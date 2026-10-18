import { afterEach, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as sessionEntryReads from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as voiceWakeRouting from "../../infra/voicewake-routing.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as attachments from "../chat-attachments.js";
import { createChatRunState } from "../server-chat-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import "../session-utils-store-worker.js";
import { prepareAgentContentPhase } from "./agent-content-phase.js";
import type { AgentTurnContext } from "./types.js";

let state: OpenClawTestState | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
});

it.each([
  { name: "main", agentId: "main", replaceDuringRead: false },
  { name: "work", agentId: "work", replaceDuringRead: false },
  { name: "replacement work", agentId: "work", replaceDuringRead: true },
])(
  "admits images using the explicit $name global session owner",
  async ({ agentId, replaceDuringRead }) => {
    state = await createOpenClawTestState({ label: "agent-content-owner" });
    const { stateDir, workspaceDir } = state;
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { model: "mock-openai/main-vision" },
          work: { model: "mock-openai/work-vision" },
        },
        defaults: { workspace: state.workspaceDir },
      },
      plugins: { enabled: false },
      session: { scope: "global" },
    };
    await state.writeConfig(cfg);
    if (replaceDuringRead) {
      const scope = { agentId, sessionKey: "global", env: state.env };
      await replaceSessionEntry(scope, {
        sessionId: "previous-text-session",
        lifecycleRevision: "previous-lifecycle",
        updatedAt: 1,
        providerOverride: "mock-openai",
        modelOverride: "text-only",
      });
      const read = sessionEntryReads.withSessionEntryReadOnlyInWorker;
      vi.spyOn(sessionEntryReads, "withSessionEntryReadOnlyInWorker").mockImplementationOnce(
        async (...args) => {
          await replaceSessionEntry(scope, {
            sessionId: "replacement-vision-session",
            lifecycleRevision: "replacement-lifecycle",
            updatedAt: 2,
            providerOverride: "mock-openai",
            modelOverride: `${agentId}-vision`,
          });
          return await read(...args);
        },
      );
    }
    const loadGatewayModelCatalogSnapshot = vi.fn<
      AgentTurnContext["loadGatewayModelCatalogSnapshot"]
    >(async (params) => ({
      agentId: params?.agentId ?? agentId,
      agentDir: stateDir,
      workspaceDir,
      catalogComplete: true,
      config: cfg,
      entries: [
        {
          id: "text-only",
          name: "Synthetic text model",
          provider: "mock-openai",
          input: ["text"],
        } satisfies ModelCatalogEntry,
        {
          id: `${params?.agentId}-vision`,
          name: "Synthetic vision model",
          provider: "mock-openai",
          input: ["text", "image"],
        } satisfies ModelCatalogEntry,
      ],
      routeVariants: [],
    }));
    const context: AgentTurnContext = {
      addChatRun: vi.fn(),
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      chatRunState: createChatRunState(),
      dedupe: new Map(),
      deps: {},
      getRuntimeConfig: () => cfg,
      trackExecution: async (work) => await work(),
      getSessionEventSubscriberConnIds: () => new Set(),
      loadGatewayModelCatalog: vi.fn(async () => []),
      loadGatewayModelCatalogSnapshot,
      logGateway: createSubsystemLogger("test/agent-content"),
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(() => undefined),
    };
    const respond = vi.fn();
    const result = await prepareAgentContentPhase({
      request: {
        message: "Inspect this synthetic pixel",
        agentId,
        sessionKey: "global",
        idempotencyKey: `image-${agentId}`,
      },
      cfg,
      context,
      respond,
      isRawModelRun: false,
      requestedSessionKeyRaw: "global",
      requestedSessionKey: "global",
      agentId,
      knownAgents: ["main", "work"],
      normalizedAttachments: [
        {
          type: "file",
          mimeType: "image/png",
          fileName: "pixel.png",
          content:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
      ],
    });
    expect(respond).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      agentId,
      requestedSessionKey: "global",
      images: [expect.objectContaining({ mimeType: "image/png" })],
    });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledExactlyOnceWith({
      agentId,
      readOnly: true,
    });
  },
);

it("rejects a voice-wake retarget to a persisted root before attachment parsing after mode opt-out", async () => {
  state = await createOpenClawTestState({ label: "agent-voicewake-root-target" });
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {}, work: {} } },
    plugins: { enabled: false },
  };
  await state.writeConfig(cfg);
  await replaceSessionEntry(
    { agentId: "work", sessionKey: "agent:work:main", env: state.env },
    {
      sessionId: "consolidation-root",
      lifecycleRevision: "root-generation",
      updatedAt: 1,
      createdVia: "internal",
      createdActor: { type: "system", id: "conversation-root" },
      visibility: "draft",
      delivery: { kind: "none" },
      conversationTopology: { version: 1, role: "root" },
    },
  );
  vi.spyOn(voiceWakeRouting, "loadVoiceWakeRoutingConfig").mockResolvedValue({
    version: 1,
    defaultTarget: { agentId: "work" },
    routes: [],
    updatedAtMs: 1,
  });
  const parse = vi.spyOn(attachments, "parseMessageWithAttachments");
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const respond = vi.fn();
  await expect(
    prepareAgentContentPhase({
      request: {
        message: "Inspect this attachment",
        voiceWakeTrigger: "assistant",
        idempotencyKey: "voicewake-root-retarget",
      },
      cfg,
      context,
      respond,
      conversationInput: true,
      isRawModelRun: false,
      agentId: "main",
      requestedSessionKey: "agent:main:matrix:room",
      knownAgents: ["main", "work"],
      normalizedAttachments: [
        {
          type: "file",
          mimeType: "image/png",
          fileName: "pixel.png",
          content:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
      ],
    }),
  ).rejects.toThrow("Explicitly migrate it before changing conversation mode");
  expect(parse).not.toHaveBeenCalled();
  expect(respond).not.toHaveBeenCalled();
});
