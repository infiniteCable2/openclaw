import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { checkClientVoiceToolConfirmationPolicy } from "../../../talk/client-voice-confirmation.js";
import { resolveClientVoiceRunBinding } from "../../../talk/client-voice-session.js";
import { getUnifiedTalkSession } from "../../../talk/session-registry.js";
import { cleanupTalkConnection } from "../session-registry.js";
import {
  context,
  mocks,
  testState,
  dispatch,
  installSyntheticSpeechHardware,
  createSpeechRelayCall,
  publishNativeSpeechModelRun,
} from "./native-consult-target.test-support.js";

it("public STT/TTS input boundary finalizes real audio through native consultation without closing the call", async ({
  signal,
}) => {
  const turnEnded = createDeferredCore();
  let phase = "session startup";
  const reportAbort = () => console.error(`Synthetic speech boundary stopped during ${phase}`);
  signal.addEventListener("abort", reportAbort, { once: true });
  const finishInput = vi.fn(() => {
    expect(hardware.input).toHaveBeenLastCalledWith(audio);
    hardware.emitTranscript("Inspect the synthetic input boundary.");
  });
  const hardware = installSyntheticSpeechHardware({ finishInput });
  const audio = Buffer.alloc(640, 3);
  mocks.runEmbeddedAgent.mockImplementation(publishNativeSpeechModelRun);
  vi.mocked(context.broadcastToConnIds).mockImplementation((_name, payload) => {
    if (
      isRecord(payload) &&
      isRecord(payload.talkEvent) &&
      payload.talkEvent.type === "session.error"
    ) {
      turnEnded.reject(
        new Error("Synthetic input boundary failed before audio completion", {
          cause: vi.mocked(context.logGateway.warn).mock.calls,
        }),
      );
    }
    if (
      isRecord(payload) &&
      isRecord(payload.talkEvent) &&
      payload.talkEvent.type === "turn.ended"
    ) {
      turnEnded.resolve();
    }
  });
  const call = await createSpeechRelayCall();
  console.info("Synthetic speech boundary: session created");
  expect(call.audio.supportsInputEnd).toBe(true);
  expect(
    await dispatch("talk.session.appendAudio", {
      sessionId: call.sessionId,
      audioBase64: "",
      endOfInput: true,
    }),
  ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  expect(finishInput).not.toHaveBeenCalled();
  await dispatch("talk.session.acknowledgeMark", {
    sessionId: call.sessionId,
    markName: call.readyMark,
  });
  console.info("Synthetic speech boundary: playback ready");
  phase = "provider input finalization";
  expect(
    await dispatch("talk.session.appendAudio", {
      sessionId: call.sessionId,
      audioBase64: audio.toString("base64"),
      endOfInput: true,
    }),
  ).toHaveBeenCalledWith(true, { ok: true }, undefined);
  expect(finishInput).toHaveBeenCalledOnce();
  console.info("Synthetic speech boundary: provider finalized input");
  phase = "audio completion";
  await withinTest(turnEnded.promise, signal);
  console.info("Synthetic speech boundary: output completed");
  expect(finishInput).toHaveBeenCalledOnce();
  expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
  expect(hardware.close).not.toHaveBeenCalled();
  expect(getUnifiedTalkSession(call.sessionId).kind).toBe("speech-relay");
  phase = "session close";
  await dispatch("talk.session.close", { sessionId: call.sessionId });
  console.info("Synthetic speech boundary: session closed");
  signal.removeEventListener("abort", reportAbort);
});

it("public STT/TTS rejects unsupported input boundaries before accepting their audio", async () => {
  const hardware = installSyntheticSpeechHardware();
  const call = await createSpeechRelayCall();
  expect(call.audio.supportsInputEnd).toBe(false);
  await dispatch("talk.session.acknowledgeMark", {
    sessionId: call.sessionId,
    markName: call.readyMark,
  });
  expect(
    await dispatch("talk.session.appendAudio", {
      sessionId: call.sessionId,
      audioBase64: Buffer.alloc(640).toString("base64"),
      endOfInput: true,
    }),
  ).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining("endOfInput") }),
  );
  expect(hardware.input).not.toHaveBeenCalled();
  await dispatch("talk.session.close", { sessionId: call.sessionId });
});

it("public STT/TTS fences a pending input boundary when its call closes", async ({ signal }) => {
  const finishing = createDeferredCore();
  const release = createDeferredCore();
  const hardware = installSyntheticSpeechHardware({
    finishInput: () => {
      finishing.resolve();
      return release.promise;
    },
  });
  const call = await createSpeechRelayCall();
  await dispatch("talk.session.acknowledgeMark", {
    sessionId: call.sessionId,
    markName: call.readyMark,
  });
  const pending = dispatch("talk.session.appendAudio", {
    sessionId: call.sessionId,
    audioBase64: "",
    endOfInput: true,
  });
  await withinTest(finishing.promise, signal);
  const closing = dispatch("talk.session.close", { sessionId: call.sessionId });
  try {
    await withinTest(hardware.closeStarted.promise, signal);
    expect(hardware.releaseStt).not.toHaveBeenCalled();
    expect(hardware.releaseTts).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  expect(await withinTest(closing, signal)).toHaveBeenCalledWith(true, { ok: true }, undefined);
  expect(await withinTest(pending, signal)).toHaveBeenCalledWith(
    false,
    undefined,
    expect.any(Object),
  );
  expect(hardware.close).toHaveBeenCalledOnce();
  expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
});

it.for(["status", "cancel", "steer", "followup"] as const)(
  "public STT/TTS %s control retains original caller admission and reports idle",
  async (mode) => {
    installSyntheticSpeechHardware();
    const { sessionId } = await createSpeechRelayCall();
    const owner = testState.client;
    try {
      testState.client = { ...owner, connId: "another-speech-connection" };
      expect(
        await dispatch("talk.session.steer", { sessionId, text: "Control request", mode }),
      ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    } finally {
      testState.client = owner;
    }
    expect(
      await dispatch("talk.session.steer", { sessionId, text: "Control request", mode }),
    ).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        mode,
        active: false,
        ...(mode === "status" ? { ok: true } : { ok: false, reason: "no_active_run" }),
      }),
      undefined,
    );
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(await dispatch("talk.session.close", { sessionId })).toHaveBeenCalledWith(
      true,
      { ok: true },
      undefined,
    );
  },
);

it.for([false, true])(
  "native STT/TTS actual run retains its spoken confirmation gate after early commentary=%s",
  async (partial, { signal }) => {
    if (partial) {
      testState.config.talk = {
        ...testState.config.talk,
        speech: { agentProfiles: { voice: { speakCommentary: true } } },
      };
    }
    const hardware = installSyntheticSpeechHardware();
    const turnEnded = createDeferredCore();
    let admittedVoiceRun: ReturnType<typeof resolveClientVoiceRunBinding>;
    mocks.runEmbeddedAgent.mockImplementation(async (params) =>
      publishNativeSpeechModelRun(params, async () => {
        // The real embedded runtime reports this phase before model/tool execution.
        // Native getReply invokes its actual onAgentRunStart owner from that boundary.
        params.onExecutionPhase?.({ phase: "model_call_started" });
        admittedVoiceRun = resolveClientVoiceRunBinding(params.runId);
        expect(admittedVoiceRun).toBeDefined();
        if (partial) {
          await params.onBlockReply?.({ text: "Checking that request.", isCommentary: true });
        }
        const decision = checkClientVoiceToolConfirmationPolicy({
          agentId: admittedVoiceRun?.agentId,
          voiceSessionId: admittedVoiceRun?.voiceSessionId,
          runId: params.runId,
          toolName: "message",
          toolParams: { action: "send", message: "Example message" },
        });
        expect(decision.allowed).toBe(false);
        await params.onBlockReply?.({ text: "The message was sent." });
        return { payloads: [{ text: "The message was sent." }], meta: { durationMs: 0 } };
      }),
    );
    vi.mocked(context.broadcastToConnIds).mockImplementation((_name, payload) => {
      if (
        isRecord(payload) &&
        isRecord(payload.talkEvent) &&
        payload.talkEvent.type === "turn.ended"
      ) {
        turnEnded.resolve();
      }
    });
    const { sessionId, readyMark, target } = await createSpeechRelayCall();
    await dispatch("talk.session.acknowledgeMark", { sessionId, markName: readyMark });
    hardware.emitTranscript("Send a message.");
    await withinTest(turnEnded.promise, signal);
    expect(admittedVoiceRun).toMatchObject({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      voiceSessionId: sessionId,
    });
    const spoken = mocks.streamSpeech.mock.calls.map(([request]) => request.text);
    expect(spoken).not.toContain("The message was sent.");
    expect(spoken.filter((text) => text?.includes("has not run"))).toHaveLength(1);
    if (partial) {
      expect(spoken[0]).toBe("Checking that request.");
    }
    expect(await dispatch("talk.session.close", { sessionId })).toHaveBeenCalledWith(
      true,
      { ok: true },
      undefined,
    );
  },
);

it("public STT/TTS relay gates media readiness and uses native consultation, voice custody and lease cleanup", async ({
  signal,
}) => {
  testState.config.session = { mainKey: "home", scope: "global" };
  const hardware = installSyntheticSpeechHardware();
  mocks.runEmbeddedAgent.mockImplementation(publishNativeSpeechModelRun);
  const events: Array<Record<string, unknown>> = [];
  const turnEnded = createDeferredCore();
  vi.mocked(context.broadcastToConnIds).mockImplementation((name, payload, recipients) => {
    expect(name).toBe("talk.event");
    expect(recipients).toEqual(new Set([testState.client.connId]));
    if (!isRecord(payload)) {
      throw new Error("Expected public Talk event envelope");
    }
    events.push(payload);
    if (isRecord(payload.talkEvent) && payload.talkEvent.type === "turn.ended") {
      turnEnded.resolve();
    }
  });
  const { sessionId, readyMark, target } = await createSpeechRelayCall();
  const audioBase64 = Buffer.alloc(640, 3).toString("base64");
  expect(target).toMatchObject({ agentId: "voice", canonicalKey: "global" });
  expect(hardware.provider.prepareSession).toHaveBeenCalledOnce();
  expect(mocks.prepareSpeech).toHaveBeenCalledOnce();
  expect(mocks.prepareSpeech).toHaveBeenCalledWith(expect.objectContaining({ agentId: "voice" }));
  expect(
    await dispatch("talk.session.appendAudio", { sessionId, audioBase64 }),
  ).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining("readyMark") }),
  );
  expect(
    await dispatch("talk.session.acknowledgeMark", { sessionId, markName: "unowned-mark" }),
  ).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining("readiness mark") }),
  );
  expect(hardware.input).not.toHaveBeenCalled();
  // A connected provider may finish a buffered utterance before the browser
  // confirms its playback sink. Real consultation may proceed; audio may not.
  hardware.emitTranscript("Check the synthetic device.");
  await withinTest(hardware.streamStarted.promise, signal);
  expect(events.filter((event) => event.type === "audio")).toEqual([]);
  expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
  expect(mocks.runEmbeddedAgent.mock.calls[0]![0]).toMatchObject({
    agentId: "voice",
    sessionKey: "global",
    prompt: expect.stringContaining("Check the synthetic device."),
  });
  expect(
    await dispatch("talk.session.acknowledgeMark", { sessionId, markName: readyMark }),
  ).toHaveBeenCalledWith(true, { ok: true }, undefined);
  expect(
    await dispatch("talk.session.appendAudio", { sessionId, audioBase64 }),
  ).toHaveBeenCalledWith(true, { ok: true }, undefined);
  expect(hardware.input).toHaveBeenCalledWith(Buffer.from(audioBase64, "base64"));
  await withinTest(turnEnded.promise, signal);
  // Audio completion can precede getReply's return and its preparation finally.
  // Join the actual per-turn lease callback, not a timer or a duplicate cleanup.
  await withinTest(hardware.turnTtsReleased, signal);
  expect(mocks.prepareSpeech).toHaveBeenCalledTimes(2);
  expect(hardware.releaseTts).not.toHaveBeenCalled();
  expect(hardware.turnTtsReleases).toHaveLength(1);
  expect(hardware.turnTtsReleases[0]).not.toBe(hardware.releaseTts);
  expect(hardware.turnTtsReleases[0]).toHaveBeenCalledOnce();
  expect(events.filter((event) => event.type === "audio")).toEqual([
    expect.objectContaining({ sessionId, audioBase64: hardware.output.toString("base64") }),
  ]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "transcript",
      role: "assistant",
      text: "The synthetic device is ready.",
      final: true,
    }),
  );
  expect(await dispatch("talk.session.close", { sessionId })).toHaveBeenCalledWith(
    true,
    { ok: true },
    undefined,
  );
  expect(() => getUnifiedTalkSession(sessionId)).toThrow();
  expect(hardware.close).toHaveBeenCalledOnce();
  expect(hardware.releaseStt).toHaveBeenCalledOnce();
  expect(hardware.releaseTts).toHaveBeenCalledOnce();
  expect(hardware.turnTtsReleases[0]).toHaveBeenCalledOnce();
  expect(hardware.releaseStream).toHaveBeenCalledOnce();
  expect(context.chatAbortControllers.size).toBe(0);
  const scope = {
    agentId: target.agentId,
    sessionKey: target.canonicalKey,
    storePath: target.storePath,
  };
  const persisted = loadSessionEntry(scope)!;
  const transcript = readSessionTranscriptMessageEvents({
    agentId: target.agentId,
    sessionId: persisted.sessionId,
    storePath: target.storePath,
  });
  expect(transcript).toContainEqual(
    expect.objectContaining({
      event: expect.objectContaining({
        message: expect.objectContaining({
          role: "user",
          content: "Check the synthetic device.",
        }),
      }),
    }),
  );
  expect(transcript).toContainEqual(
    expect.objectContaining({
      event: expect.objectContaining({
        message: expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "The synthetic device is ready." }],
        }),
      }),
    }),
  );
});

it("public STT/TTS relay applies the admitted agent's commentary profile before the final model answer", async ({
  signal,
}) => {
  testState.config.talk = {
    ...testState.config.talk,
    speech: {
      agentProfiles: {
        primary: { responseStreaming: "off", speakCommentary: false },
        voice: { responseStreaming: "sentence", speakCommentary: true },
      },
    },
  };
  const hardware = installSyntheticSpeechHardware();
  const finishModel = createDeferredCore();
  const earlyAudio = createDeferredCore();
  const turnEnded = createDeferredCore();
  let modelFinished = false;
  mocks.runEmbeddedAgent.mockImplementation(async (params) =>
    publishNativeSpeechModelRun(params, async () => {
      await params.onBlockReply?.({ text: "Checking the device now.", isCommentary: true });
      await params.onBlockReply?.({
        text: "Private deliberation is never spoken.",
        isReasoning: true,
      });
      await finishModel.promise;
      modelFinished = true;
      await params.onBlockReply?.({ text: "The device check finished." });
      await params.waitForPendingInput?.(params.abortSignal);
      return { payloads: [{ text: "The device check finished." }], meta: { durationMs: 0 } };
    }),
  );
  vi.mocked(context.broadcastToConnIds).mockImplementation((_name, payload) => {
    if (!isRecord(payload)) {
      return;
    }
    if (payload.type === "audio") {
      earlyAudio.resolve();
    }
    if (isRecord(payload.talkEvent) && payload.talkEvent.type === "turn.ended") {
      turnEnded.resolve();
    }
  });
  const { sessionId, readyMark } = await createSpeechRelayCall();
  try {
    expect(
      await dispatch("talk.session.acknowledgeMark", { sessionId, markName: readyMark }),
    ).toHaveBeenCalledWith(true, { ok: true }, undefined);
    hardware.emitTranscript("Please check the device.");
    await withinTest(earlyAudio.promise, signal);
    expect(modelFinished).toBe(false);
    expect(mocks.streamSpeech).toHaveBeenCalledOnce();
    expect(mocks.streamSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Checking the device now.",
        agentId: "voice",
      }),
    );
    finishModel.resolve();
    await withinTest(turnEnded.promise, signal);
    expect(mocks.streamSpeech.mock.calls.map(([request]) => request.text)).toEqual([
      "Checking the device now.",
      "The device check finished.",
    ]);
    expect(await dispatch("talk.session.close", { sessionId })).toHaveBeenCalledWith(
      true,
      { ok: true },
      undefined,
    );
    expect(hardware.releaseStream).toHaveBeenCalledTimes(2);
  } finally {
    finishModel.resolve();
  }
});

it("public STT/TTS greeting is natively prepared without tools and held until the playback readiness mark", async ({
  signal,
}) => {
  testState.config.talk = {
    ...testState.config.talk,
    speech: {
      agentProfiles: {
        voice: {
          greeting: {
            enabled: true,
            prompt: "A short personal greeting appropriate to the time of day.",
            timeZone: "UTC",
          },
        },
      },
    },
  };
  const hardware = installSyntheticSpeechHardware();
  const turnEnded = createDeferredCore();
  const events: Array<Record<string, unknown>> = [];
  mocks.runEmbeddedAgent.mockImplementation(async (params) =>
    publishNativeSpeechModelRun(params, async () => ({
      payloads: [{ text: "Hello, welcome to your call." }],
      meta: { durationMs: 0 },
    })),
  );
  vi.mocked(context.broadcastToConnIds).mockImplementation((_name, payload) => {
    if (!isRecord(payload)) {
      return;
    }
    events.push(payload);
    if (isRecord(payload.talkEvent) && payload.talkEvent.type === "turn.ended") {
      turnEnded.resolve();
    }
  });
  const { sessionId, readyMark } = await createSpeechRelayCall();
  expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
  expect(mocks.runEmbeddedAgent.mock.calls[0]![0]).toMatchObject({
    agentId: "voice",
    toolsAllow: [],
    prompt: expect.stringContaining("A short personal greeting appropriate to the time of day."),
  });
  expect(mocks.runEmbeddedAgent.mock.calls[0]![0].prompt).toContain("(UTC)");
  expect(mocks.streamSpeech).toHaveBeenCalledWith(
    expect.objectContaining({ text: "Hello, welcome to your call.", agentId: "voice" }),
  );
  // Preparation is complete before the public create response, but no PCM or
  // spoken-greeting caption may precede the browser's readyMark acknowledgement.
  expect(hardware.releaseStream).toHaveBeenCalledOnce();
  expect(events.some((event) => event.type === "audio" || event.type === "transcript")).toBe(false);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    expect(
      await dispatch("talk.session.acknowledgeMark", { sessionId, markName: readyMark }),
    ).toHaveBeenCalledWith(true, { ok: true }, undefined);
    // Advance only the common engine's deliberate 150 ms greeting delay.
    await vi.advanceTimersByTimeAsync(150);
    await withinTest(turnEnded.promise, signal);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "audio",
        sessionId,
        audioBase64: hardware.output.toString("base64"),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "transcript",
        role: "assistant",
        text: "Hello, welcome to your call.",
        final: true,
      }),
    );
    expect(mocks.streamSpeech).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
  expect(await dispatch("talk.session.close", { sessionId })).toHaveBeenCalledWith(
    true,
    { ok: true },
    undefined,
  );
  expect(hardware.releaseStt).toHaveBeenCalledOnce();
  expect(hardware.releaseTts).toHaveBeenCalledOnce();
});

it("public STT/TTS optional greeting cannot hide failed cleanup and keeps its hold for disconnect retry", async ({
  signal,
}) => {
  testState.config.talk = {
    ...testState.config.talk,
    speech: {
      agentProfiles: {
        voice: { greeting: { enabled: true, timeZone: "UTC", onFailure: "continue" } },
      },
    },
  };
  const hardware = installSyntheticSpeechHardware();
  let cleanupFails = true;
  const released = createDeferredCore();
  hardware.releaseTts.mockImplementation(async () => {
    released.resolve();
  });
  hardware.releaseStream.mockImplementation(async () => {
    if (cleanupFails) {
      throw new Error("synthetic greeting lease cleanup failed");
    }
  });
  mocks.runEmbeddedAgent.mockImplementation(async (params) =>
    publishNativeSpeechModelRun(params, async () => ({
      payloads: [{ text: "Hello, caller." }],
      meta: { durationMs: 0 },
    })),
  );
  try {
    expect(
      await dispatch("talk.session.create", {
        sessionKey: "main",
        mode: "stt-tts",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "synthetic-transcription",
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(hardware.releaseStream).toHaveBeenCalledTimes(3);
    expect(hardware.provider.createSession).not.toHaveBeenCalled();
    expect(hardware.releaseStt).not.toHaveBeenCalled();
    expect(hardware.releaseTts).not.toHaveBeenCalled();
    expect(vi.mocked(context.broadcastToConnIds).mock.calls).not.toContainEqual([
      "talk.event",
      expect.objectContaining({ type: "audio" }),
      expect.anything(),
    ]);
  } finally {
    cleanupFails = false;
    cleanupTalkConnection(testState.client.connId, context.logGateway);
    await withinTest(released.promise, signal);
  }
  expect(hardware.releaseStream).toHaveBeenCalledTimes(4);
  expect(hardware.releaseStt).toHaveBeenCalledOnce();
  expect(hardware.releaseTts).toHaveBeenCalledOnce();
  expect(hardware.releaseStream.mock.invocationCallOrder.at(-1)!).toBeLessThan(
    hardware.releaseTts.mock.invocationCallOrder[0]!,
  );
});

it("public STT/TTS disconnect retains and releases a greeting stream acquired after cancellation", async ({
  signal,
}) => {
  testState.config.talk = {
    ...testState.config.talk,
    speech: {
      agentProfiles: {
        voice: { greeting: { enabled: true, timeZone: "UTC", onFailure: "continue" } },
      },
    },
  };
  const hardware = installSyntheticSpeechHardware();
  const acquisition = Promise.withResolvers<Awaited<ReturnType<typeof mocks.streamSpeech>>>();
  const acquiring = createDeferredCore();
  const released = createDeferredCore();
  const cancel = vi.fn(async () => undefined);
  hardware.releaseTts.mockImplementation(async () => {
    released.resolve();
  });
  mocks.streamSpeech.mockImplementationOnce(() => {
    acquiring.resolve();
    return acquisition.promise;
  });
  mocks.runEmbeddedAgent.mockImplementation(async (params) =>
    publishNativeSpeechModelRun(params, async () => ({
      payloads: [{ text: "Hello, caller." }],
      meta: { durationMs: 0 },
    })),
  );
  const creation = dispatch("talk.session.create", {
    sessionKey: "main",
    mode: "stt-tts",
    transport: "gateway-relay",
    brain: "agent-consult",
    provider: "synthetic-transcription",
  });
  try {
    await withinTest(acquiring.promise, signal);
    cleanupTalkConnection(testState.client.connId, context.logGateway);
    expect(hardware.releaseTts).not.toHaveBeenCalled();
  } finally {
    acquisition.resolve({
      success: true,
      sampleRate: 24_000,
      outputFormat: "pcm",
      audioStream: new ReadableStream<Uint8Array>({ cancel }),
      release: hardware.releaseStream,
    });
  }
  expect(await withinTest(creation, signal)).toHaveBeenCalledWith(
    false,
    undefined,
    expect.any(Object),
  );
  await withinTest(released.promise, signal);
  expect(cancel).toHaveBeenCalledOnce();
  expect(hardware.releaseStream).toHaveBeenCalledOnce();
  expect(hardware.releaseStt).toHaveBeenCalledOnce();
  expect(hardware.releaseTts).toHaveBeenCalledOnce();
  expect(hardware.provider.createSession).not.toHaveBeenCalled();
  expect(context.broadcastToConnIds).not.toHaveBeenCalledWith(
    "talk.event",
    expect.objectContaining({ type: "audio" }),
    expect.anything(),
  );
});

it("public STT/TTS relay refuses a different connection and stale native session identity before hardware delivery", async () => {
  const hardware = installSyntheticSpeechHardware();
  const { sessionId, readyMark, target } = await createSpeechRelayCall();
  const owner = testState.client;
  try {
    testState.client = { ...owner, connId: "another-speech-connection" };
    expect(
      await dispatch("talk.session.acknowledgeMark", { sessionId, markName: readyMark }),
    ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(
      await dispatch("talk.session.appendAudio", {
        sessionId,
        audioBase64: Buffer.alloc(640).toString("base64"),
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  } finally {
    testState.client = owner;
  }
  const scope = {
    agentId: target.agentId,
    sessionKey: target.canonicalKey,
    storePath: target.storePath,
  };
  const original = loadSessionEntry(scope)!;
  await replaceSessionEntry(scope, { ...original, sessionId: "replaced-speech-session" });
  try {
    expect(
      await dispatch("talk.session.acknowledgeMark", { sessionId, markName: readyMark }),
    ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(
      await dispatch("talk.session.appendAudio", {
        sessionId,
        audioBase64: Buffer.alloc(640).toString("base64"),
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(hardware.input).not.toHaveBeenCalled();
    expect(mocks.streamSpeech).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
  } finally {
    await replaceSessionEntry(scope, original);
  }
  expect(await dispatch("talk.session.close", { sessionId })).toHaveBeenCalledWith(
    true,
    { ok: true },
    undefined,
  );
  expect(hardware.releaseStt).toHaveBeenCalledOnce();
  expect(hardware.releaseTts).toHaveBeenCalledOnce();
});

it.for([["isolated-input"], ["voice-selection"]])(
  "public STT/TTS relay rejects unsupported capabilities %j before preparing hardware",
  async (capabilities) => {
    const hardware = installSyntheticSpeechHardware();
    expect(
      await dispatch("talk.session.create", {
        sessionKey: "main",
        mode: "stt-tts",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "synthetic-transcription",
        capabilities,
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(hardware.provider.prepareSession).not.toHaveBeenCalled();
    expect(hardware.provider.createSession).not.toHaveBeenCalled();
    expect(mocks.prepareSpeech).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
  },
);

it.for(["public-close", "disconnect"])(
  "public STT/TTS creation releases registered resources after %s while STT connection remains unresolved",
  async (closingMethod, { signal }) => {
    const connect = createDeferredCore();
    const hardware = installSyntheticSpeechHardware({ connect: connect.promise });
    const events: Array<Record<string, unknown>> = [];
    vi.mocked(context.broadcastToConnIds).mockImplementation((_name, payload) => {
      if (isRecord(payload)) {
        events.push(payload);
      }
    });
    const creation = dispatch("talk.session.create", {
      sessionKey: "main",
      mode: "stt-tts",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "synthetic-transcription",
    });
    let record:
      | Extract<ReturnType<typeof getUnifiedTalkSession>, { kind: "speech-relay" }>
      | undefined;
    try {
      await withinTest(hardware.connectStarted.promise, signal);
      const started = events.find(
        (event) => isRecord(event.talkEvent) && event.talkEvent.type === "session.started",
      );
      if (typeof started?.sessionId !== "string") {
        throw new Error("Expected public speech session.started");
      }
      const sessionId = started.sessionId;
      const registered = getUnifiedTalkSession(sessionId);
      if (registered.kind !== "speech-relay") {
        throw new Error("Expected preparing speech relay in native registry");
      }
      record = registered;
      if (closingMethod === "public-close") {
        expect(
          await withinTest(dispatch("talk.session.close", { sessionId }), signal),
        ).toHaveBeenCalledWith(true, { ok: true }, undefined);
      } else {
        cleanupTalkConnection(testState.client.connId, context.logGateway);
        await withinTest(record.close(), signal);
      }
      // connect has deliberately not resolved: cleanup must own its cancellation,
      // not rely on the provider eventually establishing a network connection.
      expect(await withinTest(creation, signal)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.any(Object),
      );
      expect(() => getUnifiedTalkSession(sessionId)).toThrow();
      expect(hardware.close).toHaveBeenCalledOnce();
      expect(hardware.releaseStt).toHaveBeenCalledOnce();
      expect(hardware.releaseTts).toHaveBeenCalledOnce();
      expect(mocks.streamSpeech).not.toHaveBeenCalled();
      expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(
        events.some(
          (event) => isRecord(event.talkEvent) && event.talkEvent.type === "session.ready",
        ),
      ).toBe(false);
      expect(events.some((event) => event.type === "audio")).toBe(false);
    } finally {
      connect.resolve();
      await creation;
      await record?.close();
    }
  },
);
