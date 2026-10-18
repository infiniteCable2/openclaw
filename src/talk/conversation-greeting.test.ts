import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { prepareSessionParticipantInput } from "../sessions/session-participant-input.js";
import { prepareConversationGreeting } from "./conversation-greeting.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  createConversationInputAdmission,
  prepareConversationReplyContext,
} from "./conversation-input-admission.js";
import type { ConversationInputScopeV1 } from "./conversation-input.types.js";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  prepareFacts: vi.fn(),
  detached: vi.fn(),
  inMemory: vi.fn(),
  projection: vi.fn(),
  prepareRun: vi.fn(),
  memoryKind: vi.fn(),
  resolveAudience: vi.fn(),
  delegateAudience: vi.fn(),
}));
// mock-isolation: Verify native run construction without starting a provider or worker.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: mocks.run }));
// mock-isolation: Transcript snapshots are separate worker-owned reads, never fixture storage.
vi.mock("../agents/sessions/session-manager.js", () => ({
  SessionManager: { openDetachedBoundedAsync: mocks.detached, inMemory: mocks.inMemory },
}));
// mock-isolation: No database worker is generated or admitted by this source-only boundary test.
vi.mock("../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: mocks.prepareFacts,
}));
// mock-isolation: Projection readiness is a worker boundary, not a fixture timer or data writer.
vi.mock("../config/sessions/session-transcript-reconcile.js", () => ({
  waitForSessionTranscriptProjection: mocks.projection,
}));
// mock-isolation: The native admission owner is tested separately with original host evidence.
vi.mock("../auto-reply/reply/channel-run-admission.js", () => ({
  prepareChannelRunAdmission: mocks.prepareRun,
}));
// mock-isolation: Native audience minting has its own generation/visibility tests; no storage leases here.
vi.mock("../plugins/memory-audience.js", () => ({
  resolveMemoryAudienceFromEntry: mocks.resolveAudience,
  delegateMemoryAudience: mocks.delegateAudience,
}));
// mock-isolation: No process-wide provider registry is activated by greeting construction tests.
vi.mock("../plugins/memory-state.js", () => ({
  resolveLoadedMemoryProviderKind: mocks.memoryKind,
}));

async function setup(existing = true) {
  const scope: ConversationInputScopeV1 = {
    agentId: "example-agent",
    conversationId: "example-call",
    inputId: "example-greeting",
    purpose: "greeting",
  };
  const sessionKey = "agent:example-agent:example-call";
  const context: MsgContext = { AgentId: scope.agentId, SessionKey: sessionKey };
  const state = { current: true };
  const assertCurrent = vi.fn(() => {
    if (!state.current) {
      throw new Error("Original admission revoked");
    }
  });
  const cap = createConversationInputAdmission({
    scope,
    source: { channelId: "example-channel", sessionKey },
    assertCurrent,
    assertInputCurrent: assertCurrent,
    prepareContext: () => context,
  });
  const input = consumeConversationInputAdmission(cap, scope);
  claimConversationInputExecution(input);
  const projected = await prepareConversationReplyContext(input, {
    text: "Greet the caller briefly.",
  });
  const target = {
    agentId: scope.agentId,
    canonicalKey: sessionKey,
    storePath: "/example/sessions.sqlite",
    entry: {
      sessionId: "original-session",
      lifecycleRevision: "original-generation",
      chatType: "direct" as const,
      owner: { actor: { type: "human" as const, id: "assigned-person" } },
    },
  };
  let currentTarget = existing ? target : null;
  const release = vi.fn();
  const close = vi.fn();
  const snapshot = { owner: "native-detached-snapshot" };
  mocks.prepareFacts.mockResolvedValue({
    storageTarget: {
      agentId: scope.agentId,
      canonicalKey: sessionKey,
      storePath: target.storePath,
    },
    readCurrent: () => ({ target: currentTarget }),
    release,
  });
  mocks.detached.mockResolvedValue(snapshot);
  mocks.inMemory.mockReturnValue(snapshot);
  mocks.projection.mockResolvedValue(undefined);
  mocks.prepareRun.mockReturnValue({ close });
  mocks.run.mockResolvedValue({ payloads: [{ text: "Good morning!" }], meta: { durationMs: 1 } });
  const onSpeakableText = vi.fn();
  const params = {
    input,
    context: projected,
    cfg: {},
    text: "Greet the caller briefly.",
    speech: {
      guidance: "Speak briefly.",
      assertOutputCurrent: vi.fn(),
      onSpeakableText,
      onError: vi.fn(),
      logger: { warn: vi.fn() },
      modelRequestProfile: { kind: "speech" as const, channelId: "example-channel" },
    },
  };
  return {
    params,
    target,
    state,
    release,
    close,
    snapshot,
    onSpeakableText,
    replaceTarget() {
      currentTarget = { ...target, entry: { ...target.entry, sessionId: "replacement" } };
    },
  };
}

describe("native detached greeting preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memoryKind.mockReturnValue(undefined);
  });

  it.each([false, true])(
    "uses only the original target when it exists=%s, without operator elevation",
    async (existing) => {
      const fixture = await setup(existing);
      const result = await prepareConversationGreeting(fixture.params);
      expect(result).toEqual({ text: "Good morning!" });
      expect(mocks.prepareFacts).toHaveBeenCalledExactlyOnceWith({
        cfg: fixture.params.cfg,
        agentId: "example-agent",
        sessionKey: fixture.params.input.source.sessionKey,
        preserveQualifiedAddress: true,
        allowMissing: true,
      });
      expect(mocks.detached).toHaveBeenCalledTimes(existing ? 1 : 0);
      expect(mocks.inMemory).toHaveBeenCalledTimes(existing ? 0 : 1);
      expect(mocks.projection).toHaveBeenCalledTimes(existing ? 1 : 0);
      if (existing) {
        expect(mocks.detached).toHaveBeenCalledWith(
          {
            agentId: "example-agent",
            sessionKey: fixture.target.canonicalKey,
            sessionId: fixture.target.entry.sessionId,
            storePath: fixture.target.storePath,
          },
          expect.objectContaining({ maxBytes: expect.any(Number), maxEvents: expect.any(Number) }),
        );
      }
      const run = mocks.run.mock.calls[0]![0] as RunEmbeddedAgentParams;
      expect(run).toMatchObject({
        agentId: "example-agent",
        sessionManager: fixture.snapshot,
        sessionPersistence: "detached",
        disableTools: true,
        toolsAllow: [],
        disableTrajectory: true,
        cleanupBundleMcpOnRunEnd: true,
        sandboxSessionKey: fixture.params.input.source.sessionKey,
        modelRequestProfile: fixture.params.speech.modelRequestProfile,
      });
      expect(run.modelRun).toBeUndefined();
      expect(run.sessionKey).toContain(":internal-session-effects:");
      expect(run.sessionKey).not.toBe(fixture.target.canonicalKey);
      expect(mocks.prepareRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceContext: fixture.params.context,
          operatorAuthority: undefined,
          assertSourceCurrent: expect.any(Function),
        }),
      );
      expect(fixture.onSpeakableText).not.toHaveBeenCalled();
      expect(result.delivered).toBeUndefined();
      expect(fixture.release).toHaveBeenCalledOnce();
      expect(fixture.close).toHaveBeenCalledOnce();
    },
  );

  it("rejects a replaced target after its native snapshot read before starting a model", async () => {
    const fixture = await setup();
    mocks.detached.mockImplementation(async () => {
      fixture.replaceTarget();
      return fixture.snapshot;
    });
    await expect(prepareConversationGreeting(fixture.params)).rejects.toThrow("target changed");
    expect(mocks.run).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("rejects revoked original authority after generation without leaking a ready greeting", async () => {
    const fixture = await setup();
    mocks.run.mockImplementation(async () => {
      fixture.state.current = false;
      return { payloads: [{ text: "Not deliverable." }], meta: { durationMs: 1 } };
    });
    await expect(prepareConversationGreeting(fixture.params)).rejects.toThrow("revoked");
    expect(fixture.onSpeakableText).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it.each([{ payloads: [] }, { payloads: [{ text: "NO_REPLY" }] }])(
    "does not invent greeting readiness from empty or silent completion",
    async ({ payloads }) => {
      const fixture = await setup(false);
      mocks.run.mockResolvedValue({ payloads, meta: { durationMs: 1 } });
      await expect(prepareConversationGreeting(fixture.params)).rejects.toThrow("no greeting");
      expect(fixture.onSpeakableText).not.toHaveBeenCalled();
      expect(fixture.release).toHaveBeenCalledOnce();
    },
  );

  it("captures a native expressive greeting without speaking or persisting it during preparation", async () => {
    const fixture = await setup(false);
    const assertExpressionCurrent = vi.fn();
    mocks.run.mockImplementation(async (run: RunEmbeddedAgentParams) => {
      const target = run.currentSourceReplyTarget!;
      target.beginInput?.({});
      await target.deliver(
        setReplyPayloadMetadata(
          { text: "Hello there!" },
          {
            tts: {
              tagged: true,
              text: "Hello there!",
              expression: { parts: [{ text: "Hello there!" }] },
            },
          },
        ),
        { final: true, phase: "final_answer", toolCallId: "original-native-expression" },
      );
      return { payloads: [], meta: { durationMs: 1 } };
    });
    const result = await prepareConversationGreeting({
      ...fixture.params,
      speech: {
        ...fixture.params.speech,
        speechExpressionContext: {
          guidance: "Use native speech presentation.",
          assertCurrent: assertExpressionCurrent,
        },
      },
    });
    expect(result).toMatchObject({ text: "Hello there!", utterances: [{ text: "Hello there!" }] });
    expect(result.delivered).toBeUndefined();
    expect(fixture.onSpeakableText).not.toHaveBeenCalled();
    expect(assertExpressionCurrent).toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("retains the native conversation audience and assigned human rather than the latest sender", async () => {
    const fixture = await setup();
    prepareSessionParticipantInput(fixture.params.context, {
      type: "profile",
      id: "current-requester",
    });
    fixture.params.context.ChatType = "group";
    fixture.params.context.SenderId = "not-a-personal-profile";
    const audience = {
      kind: "conversation" as const,
      agentId: "example-agent",
      sessionKey: fixture.target.canonicalKey,
      sessionId: fixture.target.entry.sessionId,
    };
    const delegated = { ...audience };
    const releaseSource = vi.fn();
    const releaseDelegated = vi.fn();
    mocks.memoryKind.mockReturnValue("native");
    mocks.resolveAudience.mockResolvedValue({
      status: "granted",
      audience,
      release: releaseSource,
    });
    mocks.delegateAudience.mockResolvedValue({ audience: delegated, release: releaseDelegated });
    await prepareConversationGreeting(fixture.params);
    const run = mocks.run.mock.calls[0]![0] as RunEmbeddedAgentParams;
    expect(run.bootstrapUserProfileId).toBe("assigned-person");
    expect(run.chatType).toBe("group");
    expect(run.memoryAudience).toBe(delegated);
    expect(mocks.resolveAudience).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: fixture.target.canonicalKey,
        senderIsOwner: false,
      }),
      fixture.target.entry,
    );
    expect(mocks.delegateAudience).toHaveBeenCalledWith(
      audience,
      expect.objectContaining({ sessionKey: run.sessionKey, detached: true }),
    );
    expect(releaseSource).toHaveBeenCalledOnce();
    expect(releaseDelegated).toHaveBeenCalledOnce();
  });

  it("releases a granted native audience if original authority expires during its preparation", async () => {
    const fixture = await setup();
    const release = vi.fn();
    mocks.memoryKind.mockReturnValue("native");
    mocks.resolveAudience.mockImplementation(async () => {
      fixture.state.current = false;
      return { status: "granted", audience: {}, release };
    });
    await expect(prepareConversationGreeting(fixture.params)).rejects.toThrow("revoked");
    expect(release).toHaveBeenCalledOnce();
    expect(mocks.delegateAudience).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});
