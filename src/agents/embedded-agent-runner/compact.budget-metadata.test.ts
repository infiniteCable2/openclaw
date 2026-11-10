import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-transcript-context-version.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createAssistant,
  createAssistantResultStream,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import type { ProviderConfigInput } from "../sessions/model-registry.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { useCompactHooksSessionFixture } from "./compact.hooks.fixture.test-support.js";
import { loadCompactHooksHarness, resolveModelMock } from "./compact.hooks.harness.js";

const sessionKey = "agent:main:budget-metadata";
const fixture = useCompactHooksSessionFixture(sessionKey);
let compact: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;
let sessions: typeof import("../sessions/index.js");
let configRuntime: typeof import("../../config/runtime-snapshot.js");
let storePath: string;
let prepared: Awaited<ReturnType<typeof fixture.prepareSession>>;

beforeAll(async () => {
  // Provider/bootstrap setup is isolated; the SDK, manager, SQLite and compactor
  // remain real. Restore replay too: its own metadata write is under examination.
  ({ compactEmbeddedAgentSessionDirect: compact } = await loadCompactHooksHarness({
    durableSession: true,
  }));
  sessions = await import("../sessions/index.js");
  configRuntime = await import("../../config/runtime-snapshot.js");
  storePath = await fixture.prepare();
});

beforeEach(async () => {
  prepared = await fixture.prepareSession();
  const replay = await import("./replay-history.js");
  const actualReplay =
    await vi.importActual<typeof import("./replay-history.js")>("./replay-history.js");
  vi.mocked(replay.sanitizeSessionHistory).mockImplementation(actualReplay.sanitizeSessionHistory);
  vi.mocked(replay.validateReplayTurns).mockImplementation(actualReplay.validateReplayTurns);
});

afterEach(() => {
  vi.restoreAllMocks();
  configRuntime.clearRuntimeConfigSnapshot();
});

it("records native check-only preparation metadata after a compaction boundary", async () => {
  const model = {
    ...testModel,
    api: "openai-completions" as const,
    provider: "openai",
    id: "budget-metadata-fixture",
    contextWindow: 128_000,
    maxTokens: 1_024,
  };
  const target = { agentId: "main", sessionKey, sessionId: prepared.sessionId, storePath };
  const config: OpenClawConfig = {
    session: { store: storePath },
    agents: {
      entries: { main: {} },
      defaults: { compaction: { mode: "default", postIndexSync: "off" } },
    },
  };
  configRuntime.setRuntimeConfigSnapshot(config);
  const authStorage = sessions.AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "test-api-key");
  const modelRegistry = sessions.ModelRegistry.inMemory(authStorage);
  const stream = vi.fn<NonNullable<ProviderConfigInput["streamSimple"]>>((activeModel) =>
    createAssistantResultStream(createAssistant(activeModel, [{ type: "text", text: "Unused" }])),
  );
  modelRegistry.registerProvider(model.provider, { api: model.api, streamSimple: stream });
  resolveModelMock.mockImplementation(() => ({
    logicalRef: { provider: model.provider, model: model.id },
    model,
    error: null,
    authStorage,
    modelRegistry,
  }));

  const manager = await sessions.SessionManager.openAsync(target, prepared.workspaceDir);
  await manager.appendModelChange(model.provider, model.id);
  await manager.appendThinkingLevelChange("off");
  await manager.appendCustomEntryAsync("model-snapshot", {
    timestamp: 1,
    provider: model.provider,
    modelApi: model.api,
    modelId: model.id,
  });
  await manager.appendMessageAsync({ role: "user", content: "Earlier request", timestamp: 1 });
  await manager.appendMessageAsync(
    createAssistant(model, [{ type: "text", text: "Earlier reply" }]),
  );
  const retainedId = await manager.appendMessageAsync({
    role: "user",
    content: "Retained request",
    timestamp: 2,
  });
  if (!retainedId) {
    throw new Error("Expected a persisted retained user anchor");
  }
  await manager.appendMessageAsync(
    createAssistant(model, [{ type: "text", text: "Retained reply" }]),
  );
  await manager.appendCompactionAsync("Earlier decision retained in summary.", retainedId, 100);
  const original = manager.getEntries();
  const before = manager.getTranscriptSnapshotVersion();
  expect(before).toBeDefined();
  const compactionView = await sessions.SessionManager.openAsync(target, undefined, {
    compaction: true,
  });
  expect(compactionView.getEntries().some((entry) => entry.type === "thinking_level_change")).toBe(
    false,
  );
  expect(
    compactionView
      .getEntries()
      .some((entry) => entry.type === "custom" && entry.customType === "model-snapshot"),
  ).toBe(false);

  const sdk = await import("../sessions/sdk.js");
  const createAgentSession = sdk.createAgentSession;
  let probeManager: SessionManager | undefined;
  vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options) => {
    probeManager = options.sessionManager;
    return createAgentSession(options);
  });
  const { capturePreparedConversationContextBudget } =
    await import("./run/prepared-conversation-context.js");
  let decisionVersion: Readonly<SessionTranscriptContextVersion> | undefined;
  const onDecision = vi.fn(
    (fits: boolean, capacity?: Parameters<typeof capturePreparedConversationContextBudget>[0]) => {
      expect(fits).toBe(true);
      expect(capacity && capturePreparedConversationContextBudget(capacity)).toBeDefined();
      decisionVersion = probeManager?.getTranscriptSnapshotVersion();
      expect(decisionVersion).toBeDefined();
    },
  );
  const result = await compact({
    ...target,
    sessionTarget: target,
    workspaceDir: prepared.workspaceDir,
    config,
    provider: model.provider,
    model: model.id,
    thinkLevel: "off",
    disableTools: true,
    trigger: "budget",
    budgetPreflight: { prompt: "", checkOnly: true, captureCapacity: true, onDecision },
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: false });
  expect(onDecision).toHaveBeenCalledOnce();
  expect(stream).not.toHaveBeenCalled();
  const after = await sessions.SessionManager.openAsync(target);
  expect(after.getEntries().slice(0, original.length)).toEqual(original);
  expect(
    after
      .getEntries()
      .slice(original.length)
      .map((entry) =>
        entry.type === "custom"
          ? { type: entry.type, customType: entry.customType }
          : { type: entry.type },
      ),
  ).toEqual([{ type: "thinking_level_change" }, { type: "custom", customType: "model-snapshot" }]);
  expect(after.getTranscriptSnapshotVersion()).toEqual(decisionVersion);
  expect(decisionVersion).not.toEqual(before);
  expect(decisionVersion?.generation).toBe(before?.generation);
  expect(decisionVersion?.rawSeq).toBe((before?.rawSeq ?? -1) + 2);
});
