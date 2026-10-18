import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../../agents/embedded-agent-runner/runs.js";
import { REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS } from "../../../agents/realtime-bootstrap-context.test-support.js";
import { replyRunRegistry } from "../../../auto-reply/reply/reply-run-registry.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { emitTrustedDiagnosticEvent } from "../../../infra/diagnostic-events.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { controlRealtimeVoiceAgentRun } from "../../../talk/agent-run-control.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import {
  getUnifiedTalkSession,
  rememberUnifiedTalkSession,
} from "../../../talk/session-registry.js";
import { makeBridge } from "../../../talk/session-runtime.test-support.js";
import { registerChatAbortController } from "../../chat-abort.js";
import { resolveSessionMutationAuthorization } from "../../session-sharing.js";
import { resolveOwnedActiveTalkRunTarget } from "../run-ownership.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import {
  completeTalkVoiceChange,
  requestTalkVoiceChange,
  resolveTalkVoiceSession,
} from "../voice-selection.js";
import {
  callback,
  providerInstructions,
  browserControl,
  submitProviderResult,
  context,
  mocks,
  testState,
  dispatch,
  createRelayCall,
} from "./native-consult-target.test-support.js";
import { talkSessionHandlers } from "./session.js";

it.each([undefined, "main"])(
  "retains the opaque relay owner when Talk defaults change (key=%s)",
  async (sessionKey) => {
    testState.config.session = { scope: "global" };
    const { sessionId } = await createRelayCall();
    expect(providerInstructions).toBe(REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS);
    await replaceSessionEntry(
      { agentId: "primary", sessionKey: "global" },
      {
        sessionId: "private-primary",
        updatedAt: 1,
        visibility: "draft",
        createdActor: { type: "human", source: "profile", id: "another-person" },
      },
    );
    testState.config = { ...testState.config, talk: { agentId: "primary" } };
    expect(
      await dispatch("talk.session.steer", {
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        text: "status",
        mode: "status",
      }),
    ).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ mode: "status", sessionKey: "global" }),
      undefined,
    );
  },
);

it.each([undefined, "main"])(
  "enforces the retained relay's sharing policy (key=%s)",
  async (sessionKey) => {
    await replaceSessionEntry(
      { agentId: "voice", sessionKey: "agent:voice:main" },
      {
        sessionId: "shared-before-call",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: "another-person" },
      },
    );
    const { sessionId, target } = await createRelayCall();
    const scope = {
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    };
    await replaceSessionEntry(scope, {
      ...loadSessionEntry(scope)!,
      visibility: "read-only",
    });
    expect(
      await dispatch("talk.session.steer", {
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        text: "status",
        mode: "status",
      }),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
      }),
    );
  },
);

it("rejects retained relay mapping changes even when the physical store is unchanged", async () => {
  const { sessionId } = await createRelayCall();
  testState.config = { ...testState.config, session: { mainKey: "home" } };
  expect(
    await dispatch("talk.session.steer", { sessionId, text: "status", mode: "status" }),
  ).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("non-canonical persisted row"),
    }),
  );
});

it("fences an opaque relay record replaced after authorization", async () => {
  const { sessionId } = await createRelayCall();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const pending = dispatch(
    "talk.session.steer",
    { sessionId, text: "status", mode: "status" },
    {
      "talk.session.steer": async (request) => {
        entered.resolve();
        await release.promise;
        await talkSessionHandlers["talk.session.steer"]!(request);
      },
    },
  );
  await entered.promise;
  rememberUnifiedTalkSession(sessionId, { ...getUnifiedTalkSession(sessionId) });
  release.resolve();
  expect(await pending).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      details: expect.objectContaining({ code: "SESSION_MUTATION_AUTHORIZATION_CHANGED" }),
    }),
  );
});

function registerOwnedEmbeddedRun(runId: string, sessionId: string) {
  const registration = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId,
    sessionId,
    sessionKey: "global",
    agentId: "voice",
    ownerConnId: testState.client.connId,
    timeoutMs: 60_000,
    kind: "chat-send",
  });
  const abort = vi.fn();
  setActiveEmbeddedRun(
    sessionId,
    {
      runId,
      queueMessage: async () => undefined,
      isStreaming: () => true,
      isCompacting: () => false,
      abort,
    },
    "global",
  );
  return { registration, abort };
}

it("rechecks RPC sharing authorization after the control runtime import", async () => {
  testState.config.session = { scope: "global" };
  const target = prepareTalkSessionTarget(testState.config, "main");
  const scope = { agentId: "voice", sessionKey: "global", storePath: target.storePath };
  await replaceSessionEntry(scope, {
    sessionId: "acl-session",
    updatedAt: 1,
    visibility: "shared",
  });
  const { registration, abort } = registerOwnedEmbeddedRun("acl-run", "acl-session");
  const authorization = resolveSessionMutationAuthorization({
    client: testState.client,
    method: "talk.client.steer",
    requestParams: { sessionKey: "main" },
    context,
  });
  expect(authorization.error).toBeNull();
  const runTarget = resolveOwnedActiveTalkRunTarget({
    context,
    clientConnId: testState.client.connId,
    sessionTarget: target,
    scope: { kind: "session" },
    assertCurrent: authorization.authorization!.assertCurrent,
  });
  const pending = controlRealtimeVoiceAgentRun({
    sessionKey: "global",
    runTarget,
    text: "cancel",
    mode: "cancel",
  });
  replaceSessionEntrySync(scope, {
    sessionId: "acl-session",
    updatedAt: 2,
    visibility: "read-only",
    createdActor: { type: "human", source: "profile", id: "another-person" },
  });
  try {
    await expect(pending).rejects.toMatchObject({
      error: expect.objectContaining({
        details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
      }),
    });
    expect(abort).not.toHaveBeenCalled();
  } finally {
    registration.cleanup();
  }
});

it.each([
  "replaced",
  "agent",
  "key",
  "connection",
  "signal",
  "generation",
  "cleanup",
  "voice binding removed",
  "voice binding replaced",
] as const)("fences %s Gateway registration while exact control loads", async (change) => {
  testState.config.session = { scope: "global" };
  const target = prepareTalkSessionTarget(testState.config, "main");
  const runId = "captured-run";
  const voiceScope = { agentId: target.agentId, sessionKey: target.sessionKey };
  const voiceSessionId = createOrResumeClientVoiceSession({ ...voiceScope, origin: "client" });
  registerClientVoiceConsultRun({ ...voiceScope, voiceSessionId, runId });
  const { registration, abort } = registerOwnedEmbeddedRun(runId, "captured-session");
  const runTarget = resolveOwnedActiveTalkRunTarget({
    context,
    clientConnId: testState.client.connId,
    sessionTarget: target,
    scope: { kind: "voice-session", voiceSessionId },
  });
  expect(runTarget?.isCurrent()).toBe(true);
  const control = controlRealtimeVoiceAgentRun({
    sessionKey: "global",
    runTarget,
    text: "cancel",
    mode: "cancel",
  });
  const entry = context.chatAbortControllers.get(runId)!;
  if (change === "replaced") {
    context.chatAbortControllers.set(runId, { ...entry });
  } else if (change === "agent") {
    entry.agentId = "primary";
  } else if (change === "key") {
    entry.sessionKey = "agent:voice:another";
  } else if (change === "connection") {
    entry.ownerConnId = "another-client";
  } else if (change === "generation") {
    entry.lifecycleGeneration = "retired";
  } else if (change === "cleanup") {
    entry.registrationCleanupRequested = true;
  } else if (change === "voice binding removed") {
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId,
      durationMs: 0,
      outcome: "completed",
    });
    expect(resolveClientVoiceRunBinding(runId)).toBeUndefined();
  } else if (change === "voice binding replaced") {
    const replacementVoiceSessionId = createOrResumeClientVoiceSession({
      ...voiceScope,
      origin: "client",
    });
    registerClientVoiceConsultRun({
      ...voiceScope,
      voiceSessionId: replacementVoiceSessionId,
      runId,
    });
  } else {
    entry.controller = new AbortController();
  }
  try {
    expect(await control).toMatchObject({ ok: false, active: false, reason: "no_active_run" });
    expect(abort).not.toHaveBeenCalled();
  } finally {
    registration.cleanup();
  }
});

it("preserves status and cancellation for an owned queued chat.send reply", async () => {
  testState.config.session = { scope: "global" };
  const respond = await dispatch("talk.client.create", {
    sessionKey: "main",
    mode: "realtime",
    transport: "webrtc",
    brain: "agent-consult",
    capabilities: ["gateway-control-v1"],
  });
  expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
  const sessionId = loadSessionEntry({ agentId: "voice", sessionKey: "global" })!.sessionId;
  const registration = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId: "queued-talk",
    sessionId,
    sessionKey: "global",
    agentId: "voice",
    ownerConnId: testState.client.connId,
    timeoutMs: 60_000,
    kind: "chat-send",
  });
  const operation = replyRunRegistry.begin({
    sessionKey: "global",
    sessionId,
    resetTriggered: false,
    upstreamAbortSignal: registration.controller.signal,
  });
  const runTarget = resolveOwnedActiveTalkRunTarget({
    context,
    clientConnId: testState.client.connId,
    sessionTarget: prepareTalkSessionTarget(testState.config, "main"),
    scope: { kind: "session" },
  });
  const resolvedSessionId = "materialized-reply-session";
  context.chatAbortControllers.get("queued-talk")!.sessionId = resolvedSessionId;
  operation.updateSessionId(resolvedSessionId);
  const voiceSessionId = (respond.mock.calls[0]![1] as { voiceSessionId: string }).voiceSessionId;
  registerClientVoiceConsultRun({
    agentId: "voice",
    sessionKey: "main",
    voiceSessionId,
    runId: "queued-talk",
  });
  const voiceTarget = resolveOwnedActiveTalkRunTarget({
    context,
    clientConnId: testState.client.connId,
    sessionTarget: prepareTalkSessionTarget(testState.config, "main"),
    scope: { kind: "voice-session", voiceSessionId },
  });
  try {
    expect(voiceTarget?.isCurrent()).toBe(true);
    expect(
      await controlRealtimeVoiceAgentRun({
        sessionKey: "global",
        runTarget: voiceTarget,
        text: "status",
      }),
    ).toMatchObject({ active: false });
    expect(
      await controlRealtimeVoiceAgentRun({
        sessionKey: "global",
        runTarget,
        text: "status",
        mode: "status",
      }),
    ).toMatchObject({ active: true, sessionId: resolvedSessionId });
    expect(
      await dispatch("talk.client.steer", { sessionKey: "main", text: "status", mode: "status" }),
    ).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ active: true, sessionId: resolvedSessionId }),
      undefined,
    );
    const abortUnrelated = vi.fn();
    const unrelated = {
      runId: "queued-talk",
      queueMessage: async () => undefined,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: abortUnrelated,
    };
    setActiveEmbeddedRun(resolvedSessionId, unrelated, "global");
    try {
      expect(
        await controlRealtimeVoiceAgentRun({ sessionKey: "global", runTarget, text: "cancel" }),
      ).toMatchObject({ active: false, aborted: false });
      expect(abortUnrelated).not.toHaveBeenCalled();
    } finally {
      clearActiveEmbeddedRun(resolvedSessionId, unrelated, "global");
    }
    expect(
      await dispatch("talk.client.steer", { sessionKey: "main", text: "cancel", mode: "cancel" }),
    ).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, aborted: true, sessionId: resolvedSessionId }),
      undefined,
    );
    expect(operation.abortSignal.aborted).toBe(true);
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(runTarget?.isCurrent()).toBe(false);
    operation.complete();
    const successor = replyRunRegistry.begin({
      sessionKey: "global",
      sessionId: resolvedSessionId,
      resetTriggered: false,
      upstreamAbortSignal: registration.controller.signal,
    });
    try {
      expect(
        await controlRealtimeVoiceAgentRun({ sessionKey: "global", runTarget, text: "cancel" }),
      ).toMatchObject({ active: false, aborted: false });
      expect(successor.abortSignal.aborted).toBe(false);
    } finally {
      successor.complete();
    }
  } finally {
    operation.complete();
    registration.cleanup();
  }
});

it("restores bounded relay history after the original voice provider finishes closing", async () => {
  const configuredInstructions = "Keep native answers brief.";
  testState.config.talk = {
    ...testState.config.talk,
    realtime: { instructions: configuredInstructions },
  };
  const closeStarted = createDeferredCore();
  const finishClose = createDeferredCore();
  const requests: RealtimeVoiceBridgeCreateRequest[] = [];
  const tailUser = "The final preference is the blue bicycle.";
  const tailAssistant = "I will remember the blue bicycle.";
  const provider: RealtimeVoiceProviderPlugin = {
    id: "synthetic-voice",
    label: "Synthetic voice",
    voices: ["cove", "ember"],
    capabilities: mocks.capabilities,
    isConfigured: () => true,
    createBridge: (request) => {
      requests.push(request);
      const original = requests.length === 1;
      return makeBridge({
        close: async () => {
          if (original) {
            closeStarted.resolve();
            await finishClose.promise;
            request.onTranscript?.("user", tailUser, true);
            request.onTranscript?.("assistant", tailAssistant, true);
          }
        },
      });
    },
  };
  mocks.resolveProvider.mockReturnValue({
    provider,
    providerConfig: {},
    capabilities: { ...mocks.capabilities, handlesAgentConsult: true },
  });
  const original = await createRelayCall({ voice: "cove", capabilities: ["voice-selection"] });
  const originalRequest = requests[0];
  if (!originalRequest) {
    throw new Error("Expected original relay provider");
  }
  originalRequest.onReady?.();
  const utterances = Array.from(
    { length: 20 },
    (_, index) =>
      `HISTORY_ENTRY_${String(index).padStart(2, "0")}: ${`detail-${index} `.repeat(120)}`,
  );
  for (const text of utterances) {
    originalRequest.onTranscript?.("user", text, true);
  }
  const send = vi.fn();
  const changing = requestTalkVoiceChange({
    session: resolveTalkVoiceSession({
      kind: "client",
      connId: testState.client.connId,
      voiceSessionId: original.sessionId,
    }),
    voice: "ember",
    requesterConnId: testState.client.connId,
    assertCurrent: () => {},
    send,
  });
  void changing.catch(() => {});
  const changeId = send.mock.calls[0]?.[0].changeId as string;
  const closing = dispatch("talk.session.close", { sessionId: original.sessionId });
  try {
    await closeStarted.promise;
    expect(requests).toHaveLength(1);
    finishClose.resolve();
    expect(await closing).toHaveBeenCalledWith(true, { ok: true }, undefined);

    const storedSessionId = loadSessionEntry({
      agentId: original.target.agentId,
      sessionKey: original.target.canonicalKey,
      storePath: original.target.storePath,
    })!.sessionId;
    const transcript = readSessionTranscriptMessageEvents({
      agentId: original.target.agentId,
      sessionId: storedSessionId,
      storePath: original.target.storePath,
    });
    expect(transcript).toHaveLength(22);
    expect(transcript[0]?.event).toMatchObject({
      message: { content: [{ type: "text", text: utterances[0]?.trim() }] },
    });
    expect(transcript.slice(-2).map(({ event }) => event)).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: tailUser }],
        }),
      }),
      expect.objectContaining({
        message: expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: tailAssistant }],
        }),
      }),
    ]);

    const replacement = await createRelayCall({
      voiceChangeId: changeId,
      capabilities: ["voice-selection"],
    });
    const replacementRequest = requests[1];
    if (!replacementRequest?.runAgentConsult) {
      throw new Error("Expected replacement relay provider and consult callback");
    }
    replacementRequest.onReady?.();
    await completeTalkVoiceChange({
      changeId,
      connId: testState.client.connId,
      voiceSessionId: replacement.sessionId,
      outcome: "ready",
    });
    await expect(changing).resolves.toMatchObject({ status: "applied", voice: "ember" });

    const instructions = replacementRequest.instructions ?? "";
    expect(instructions).toContain(configuredInstructions);
    expect(instructions).toContain(tailUser);
    expect(instructions).toContain(tailAssistant);
    expect(instructions).toContain("HISTORY_ENTRY_19");
    expect(instructions).not.toContain("HISTORY_ENTRY_00");
    expect([...instructions.matchAll(/HISTORY_ENTRY_\d{2}/gu)].length).toBeLessThanOrEqual(16);
    expect(
      Buffer.byteLength(
        instructions.slice(
          configuredInstructions.length + 2 + REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS.length,
        ),
        "utf8",
      ),
    ).toBeLessThanOrEqual(8_000);

    await expect(
      replacementRequest.runAgentConsult({ prompt: "What bicycle did I choose?" }),
    ).resolves.toEqual({ text: "Synthetic consult answer" });
    const agentPrompt = mocks.runEmbeddedAgent.mock.calls.at(-1)?.[0].prompt ?? "";
    expect(agentPrompt).toContain(tailUser);
    expect(agentPrompt).toContain(tailAssistant);
    expect(agentPrompt).toContain("HISTORY_ENTRY_19");
    expect(agentPrompt).not.toContain("HISTORY_ENTRY_00");
  } finally {
    finishClose.resolve();
    await closing;
    cleanupTalkConnection(testState.client.connId, context.logGateway);
    await changing.catch(() => {});
  }
});

describe.each(["browser", "relay"] as const)("native %s Talk consultation", (transport) => {
  it.each([
    { name: "custom main", scope: "per-sender" as const, canonicalKey: "agent:voice:home" },
    { name: "global", scope: "global" as const, canonicalKey: "global" },
  ])("uses the created $name session in the provider callback", async ({ scope, canonicalKey }) => {
    testState.config.session = { mainKey: "home", scope };
    testState.config.talk = {
      ...testState.config.talk,
      realtime: { instructions: "Keep native answers brief." },
    };
    const target = prepareTalkSessionTarget(testState.config, "main");
    const method = transport === "browser" ? "talk.client.create" : "talk.session.create";
    const respond = await dispatch(method, {
      sessionKey: "main",
      mode: "realtime",
      transport: transport === "browser" ? "webrtc" : "gateway-relay",
      brain: "agent-consult",
      ...(transport === "browser" ? { capabilities: ["gateway-control-v1"] } : {}),
    });
    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect(providerInstructions).toBe(
      `Keep native answers brief.\n\n${REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS}`,
    );
    const result = respond.mock.calls[0]?.[1] as { voiceSessionId?: string; sessionId?: string };
    const storage = { agentId: "voice", sessionKey: canonicalKey, storePath: target.storePath };
    const created = loadSessionEntry(storage);
    expect(created?.sessionId).toBeTruthy();
    expect(callback).toBeTypeOf("function");
    await expect(callback!({ prompt: "Continue this conversation" })).resolves.toEqual({
      text: "Synthetic consult answer",
    });
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "voice",
        sessionKey: canonicalKey,
        sessionId: created!.sessionId,
        sessionTarget: { ...storage, sessionId: created!.sessionId },
      }),
    );
    expect(
      listSessionEntriesReadOnly({ agentId: "voice", storePath: target.storePath }).map(
        (entry) => entry.sessionKey,
      ),
    ).toEqual([canonicalKey]);
    expect(
      clientVoiceSessionTesting.readRecord("voice", result.voiceSessionId ?? result.sessionId!)
        ?.sessionKey,
    ).toBe("main");
  });
});

describe.each(["browser-rpc", "browser-provider", "relay"] as const)(
  "native %s exact control",
  (surface) => {
    it.each([
      "foreign global",
      "replaced run",
      "reused run ID",
      "other call",
      ...(surface === "relay" ? [] : ["same call"]),
    ])("keeps %s control within its declared scope", async (replacement) => {
      testState.config.session = { scope: "global" };
      const started = createDeferredCore<RunEmbeddedAgentParams>();
      const finish = createDeferredCore();
      let aborted = false;
      const abortOwned = vi.fn(() => {
        aborted = true;
        finish.resolve();
      });
      const abortOther = vi.fn();
      mocks.runEmbeddedAgent.mockImplementationOnce(async (params) => {
        const handle = {
          runId: params.runId,
          queueMessage: async () => undefined,
          isStreaming: () => true,
          isCompacting: () => false,
          abort: abortOwned,
        };
        setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
        started.resolve(params);
        try {
          await finish.promise;
          return {
            payloads: [{ text: "Synthetic consult answer" }],
            meta: { durationMs: 0, aborted },
          };
        } finally {
          clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
        }
      });
      const browser = surface !== "relay";
      const createMethod = browser ? "talk.client.create" : "talk.session.create";
      const createParams = {
        sessionKey: "main",
        mode: "realtime",
        brain: "agent-consult",
        transport: browser ? "webrtc" : "gateway-relay",
        ...(browser ? { capabilities: ["gateway-control-v1"] } : {}),
      };
      const respond = await dispatch(createMethod, createParams);
      expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      const result = respond.mock.calls[0]![1] as { voiceSessionId?: string; sessionId?: string };
      let controlSessionId = result.sessionId;
      const cancelsOriginal =
        replacement === "foreign global" ||
        replacement === "same call" ||
        (replacement === "other call" && surface === "browser-rpc");
      const consult = callback!({ prompt: "Keep working" });
      try {
        const active = await Promise.race([
          started.promise,
          consult.then(() => {
            throw new Error("consult ended before model dispatch");
          }),
        ]);
        expect(context.chatAbortControllers.get(active.runId)).toMatchObject({
          agentId: "voice",
          sessionKey: "global",
          sessionId: active.sessionId,
        });
        if (replacement === "other call" || replacement === "same call") {
          const next = await dispatch(createMethod, {
            ...createParams,
            ...(replacement === "same call" ? { voiceSessionId: result.voiceSessionId } : {}),
          });
          expect(next).toHaveBeenCalledWith(true, expect.any(Object), undefined);
          const call = next.mock.calls[0]![1] as { voiceSessionId?: string; sessionId?: string };
          expect(
            (call.voiceSessionId ?? call.sessionId) === (result.voiceSessionId ?? result.sessionId),
          ).toBe(replacement === "same call");
          controlSessionId = call.sessionId;
        } else {
          setActiveEmbeddedRun(
            replacement === "replaced run" ? active.sessionId : "other-agent-session",
            {
              runId: replacement === "reused run ID" ? active.runId : "other-run",
              queueMessage: async () => undefined,
              isStreaming: () => true,
              isCompacting: () => false,
              abort: abortOther,
            },
            "global",
          );
        }
        expect(
          await dispatch("talk.client.steer", {
            sessionKey: "agent:primary:main",
            text: "cancel",
            mode: "cancel",
          }),
        ).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        if (surface === "browser-provider") {
          browserControl!.onToolCall?.({
            callId: "control",
            itemId: "control",
            name: "openclaw_agent_control",
            args: { text: "cancel", mode: "cancel" },
          });
          await vi.waitFor(() =>
            expect(submitProviderResult).toHaveBeenCalledWith(
              "control",
              expect.objectContaining({ ok: cancelsOriginal, mode: "cancel" }),
            ),
          );
        } else {
          const control = await dispatch(browser ? "talk.client.steer" : "talk.session.steer", {
            ...(browser ? {} : { sessionId: controlSessionId }),
            sessionKey: "main",
            text: "cancel",
            mode: "cancel",
          });
          expect(control).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ ok: cancelsOriginal, mode: "cancel" }),
            undefined,
          );
        }
        expect(abortOwned).toHaveBeenCalledTimes(cancelsOriginal ? 1 : 0);
        expect(abortOther).not.toHaveBeenCalled();
        expect(
          clientVoiceSessionTesting.readRecord("voice", result.voiceSessionId ?? result.sessionId!)
            ?.sessionKey,
        ).toBe("main");
        finish.resolve();
        if (cancelsOriginal) {
          await expect(consult).rejects.toMatchObject({ name: "AbortError" });
        } else {
          await expect(consult).resolves.toEqual({ text: "Synthetic consult answer" });
        }
      } finally {
        finish.resolve();
        await Promise.allSettled([consult]);
      }
    });
  },
);
