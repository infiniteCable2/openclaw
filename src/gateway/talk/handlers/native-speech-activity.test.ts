import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../../../agents/test-helpers/agent-message-fixtures.js";
import { replyRunRegistry } from "../../../auto-reply/reply/reply-run-registry.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { getUnifiedTalkSession } from "../../../talk/session-registry.js";
import { attachGatewayPairedDeviceProfileBinding } from "../../paired-device-profile.js";
import {
  context,
  mocks,
  dispatch,
  installSyntheticSpeechHardware,
  createSpeechRelayCall,
  createRelayCall,
  publishNativeSpeechModelRun,
  testState,
} from "./native-consult-target.test-support.js";

const capabilities = ["isolated-input", "output-gate", "activity-v1"];

it.for(["client-missing", "provider-missing", "method-missing", "supported"] as const)(
  "negotiates exclusive input completion: %s",
  async (kind) => {
    testState.config.talk = {
      ...testState.config.talk,
      speech: { agentProfiles: { voice: { inputEndMode: "client" } } },
    };
    const finish = vi.fn();
    const hardware = installSyntheticSpeechHardware(
      kind === "method-missing" ? {} : { finishInput: finish },
    );
    hardware.provider.supportsClientInputEnd = kind !== "provider-missing";
    const selected = kind === "client-missing" ? capabilities : [...capabilities, "input-end"];
    if (kind !== "supported") {
      const response = await dispatch("talk.session.create", {
        sessionKey: "main",
        mode: "stt-tts",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "synthetic-transcription",
        capabilities: selected,
      });
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(JSON.stringify(response.mock.calls)).toContain(
        kind === "client-missing"
          ? "input-end capability"
          : kind === "provider-missing"
            ? "does not support client input end"
            : "must implement finishInput",
      );
      if (kind === "method-missing") {
        expect(hardware.close).toHaveBeenCalledOnce();
        expect(hardware.releaseStt).toHaveBeenCalledOnce();
        expect(hardware.releaseTts).toHaveBeenCalledOnce();
      } else {
        expect(hardware.provider.prepareSession).not.toHaveBeenCalled();
        expect(hardware.provider.createSession).not.toHaveBeenCalled();
        expect(mocks.prepareSpeech).not.toHaveBeenCalled();
      }
      expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
      return;
    }
    const call = await createSpeechRelayCall({ capabilities: selected });
    try {
      expect(call.audio).toMatchObject({ inputEndMode: "client", supportsInputEnd: true });
      expect(vi.mocked(hardware.provider.createSession).mock.calls[0]?.[0].inputEndMode).toBe(
        "client",
      );
      await dispatch("talk.session.acknowledgeMark", {
        sessionId: call.sessionId,
        markName: call.readyMark,
      });
      const audioBase64 = Buffer.alloc(320, 1).toString("base64");
      const rejected = await dispatch("talk.session.appendAudio", {
        sessionId: call.sessionId,
        audioBase64,
      });
      expect(rejected.mock.calls[0]?.[0]).toBe(false);
      expect(hardware.input).not.toHaveBeenCalled();
      await dispatch("talk.session.appendAudio", {
        sessionId: call.sessionId,
        captureId: "capture-a",
        audioBase64,
      });
      expect(hardware.input).toHaveBeenCalledOnce();
      await dispatch("talk.session.appendAudio", {
        sessionId: call.sessionId,
        captureId: "capture-a",
        audioBase64: "",
        endOfInput: true,
      });
      expect(finish).toHaveBeenCalledExactlyOnceWith({ captureId: "capture-a" });
      expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
    } finally {
      await dispatch("talk.session.close", { sessionId: call.sessionId });
    }
  },
);

function activityEvents() {
  return vi.mocked(context.broadcastToConnIds).mock.calls.flatMap(([, payload]) => {
    if (!isRecord(payload) || !isRecord(payload.talkEvent)) {
      return [];
    }
    const event = payload.talkEvent;
    return event.type === "input.outcome" || event.type === "session.activity" ? [event] : [];
  });
}

it.for(["exact-source", "other-source", "unbound-browser"] as const)(
  "native speech resolves the %s tail and retains estimated PCM protection",
  async (kind, { signal }) => {
    const source = { channelId: "gateway", accountId: "paired-device", senderId: "device-a" };
    testState.config.talk = {
      ...testState.config.talk,
      speech: {
        agentProfiles: {
          voice: {
            greeting: { enabled: true, timeZone: "UTC" },
            sourceOverrides: [{ source, echoSuppressionTailSeconds: 0 }],
          },
        },
      },
    };
    if (kind !== "unbound-browser") {
      const profileId = testState.client.authenticatedUserId;
      if (!profileId) {
        throw new Error("Expected the fixture's existing admitted user");
      }
      // Exercise native source projection, not signed-credential authentication:
      // this fixture already owns its admitted person and connection authority.
      attachGatewayPairedDeviceProfileBinding(testState.client, {
        identity: kind === "exact-source" ? source : { ...source, senderId: "device-b" },
        profileId,
        isCurrent: () => true,
        authority: { assertCurrent() {}, signal: new AbortController().signal },
      });
    }
    const hardware = installSyntheticSpeechHardware();
    mocks.runEmbeddedAgent.mockImplementation(async (params) =>
      publishNativeSpeechModelRun(params, async () => ({
        payloads: [{ text: "Hello, synthetic caller." }],
        meta: { durationMs: 0 },
      })),
    );
    const ended = createDeferredCore();
    void ended.promise.catch(() => {});
    vi.mocked(context.broadcastToConnIds).mockImplementation((_name, payload) => {
      if (isRecord(payload) && isRecord(payload.talkEvent)) {
        if (payload.talkEvent.type === "turn.ended") {
          ended.resolve();
        } else if (payload.talkEvent.type === "session.error") {
          ended.reject(new Error("Native greeting failed"));
        }
      }
    });
    const call = await createSpeechRelayCall({ capabilities: ["activity-v1"] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await dispatch("talk.session.acknowledgeMark", {
        sessionId: call.sessionId,
        markName: call.readyMark,
      });
      await vi.advanceTimersByTimeAsync(150);
      await withinTest(ended.promise, signal);
      expect(
        activityEvents().some(
          (event) =>
            isRecord(event.payload) &&
            isRecord(event.payload.input) &&
            event.payload.input.available === false,
        ),
      ).toBe(true);
      // The synthetic TTS leaf emits exactly 20ms PCM. Even a zero tail cannot
      // admit input during that output's estimated playback window.
      const tailMs = kind === "exact-source" ? 0 : 3_000;
      await vi.advanceTimersByTimeAsync(19 + tailMs);
      await dispatch("talk.session.appendAudio", {
        sessionId: call.sessionId,
        audioBase64: Buffer.alloc(320, 1).toString("base64"),
      });
      expect(hardware.input).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(activityEvents().at(-1)).toMatchObject({ payload: { input: { available: true } } });
      const audio = Buffer.alloc(320, 2);
      await dispatch("talk.session.appendAudio", {
        sessionId: call.sessionId,
        audioBase64: audio.toString("base64"),
      });
      expect(hardware.input).toHaveBeenCalledExactlyOnceWith(audio);
    } finally {
      vi.useRealTimers();
      await dispatch("talk.session.close", { sessionId: call.sessionId });
    }
  },
);

it.for(["none", "legacy"] as const)(
  "native speech forwards a correlated %s boundary outcome after readiness without dispatching work",
  async (kind) => {
    const hardware = installSyntheticSpeechHardware({ finishInput: () => undefined });
    const createSession = vi.mocked(hardware.provider.createSession).getMockImplementation();
    if (!createSession) {
      throw new Error("Expected synthetic provider construction owner");
    }
    vi.mocked(hardware.provider.createSession).mockImplementation((request) => {
      const session = createSession(request);
      return {
        ...session,
        finishInput: () => (kind === "none" ? { activity: "none" as const } : undefined),
      };
    });
    const call = await createSpeechRelayCall({ capabilities });
    try {
      expect(call.audio).toMatchObject({ activityEvents: true });
      expect(activityEvents()).toEqual([]);
      await dispatch("talk.session.acknowledgeMark", {
        sessionId: call.sessionId,
        markName: call.readyMark,
      });
      expect(activityEvents().some((event) => event.type === "session.activity")).toBe(true);
      expect(activityEvents().at(-1)).toMatchObject({
        type: "session.activity",
        payload: { connection: "ready", input: { available: true } },
      });
      expect(
        await dispatch("talk.session.appendAudio", {
          sessionId: call.sessionId,
          audioBase64: "",
          endOfInput: true,
          captureId: "capture-empty",
        }),
      ).toHaveBeenCalledWith(true, { ok: true }, undefined);
      const events = activityEvents();
      const outcomes = events.filter((event) => event.type === "input.outcome");
      expect(outcomes).toEqual([
        expect.objectContaining({
          captureId: "capture-empty",
          final: true,
          payload: {
            version: 1,
            scope: "capture",
            outcome: kind === "none" ? "no-input" : "unknown",
          },
        }),
      ]);
      const terminal = outcomes[0];
      const snapshot = events.at(-1);
      if (typeof terminal?.seq !== "number" || typeof snapshot?.seq !== "number") {
        throw new Error("Expected sequenced native outcome and activity snapshot");
      }
      expect(snapshot).toMatchObject({ type: "session.activity" });
      expect(snapshot.seq).toBeGreaterThan(terminal.seq);
      expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(hardware.input).not.toHaveBeenCalled();
      expect(hardware.close).not.toHaveBeenCalled();
      expect(getUnifiedTalkSession(call.sessionId).kind).toBe("speech-relay");
    } finally {
      await dispatch("talk.session.close", { sessionId: call.sessionId });
    }
  },
);

it("native speech keeps telemetry delivery failures separate from call and input ownership", async () => {
  const hardware = installSyntheticSpeechHardware({ finishInput: () => undefined });
  const call = await createSpeechRelayCall({ capabilities });
  try {
    vi.mocked(context.broadcastToConnIds).mockImplementation((_name, payload) => {
      if (
        isRecord(payload) &&
        isRecord(payload.talkEvent) &&
        ["input.outcome", "session.activity"].includes(String(payload.talkEvent.type))
      ) {
        throw new Error("Synthetic observation delivery failure");
      }
    });
    await dispatch("talk.session.acknowledgeMark", {
      sessionId: call.sessionId,
      markName: call.readyMark,
    });
    expect(
      await dispatch("talk.session.appendAudio", {
        sessionId: call.sessionId,
        audioBase64: "",
        endOfInput: true,
        captureId: "capture-failed-delivery",
      }),
    ).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(
      await dispatch("talk.session.appendAudio", {
        sessionId: call.sessionId,
        audioBase64: Buffer.alloc(640).toString("base64"),
        captureId: "capture-next",
      }),
    ).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(hardware.input).toHaveBeenCalledOnce();
    expect(hardware.close).not.toHaveBeenCalled();
    expect(getUnifiedTalkSession(call.sessionId).kind).toBe("speech-relay");
    expect(context.logGateway.warn).toHaveBeenCalledWith(
      "Talk activity delivery failed; observation dropped",
    );
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
  } finally {
    await dispatch("talk.session.close", { sessionId: call.sessionId });
  }
});

it("a native silent answer settles activity and leaves the same connection usable", async ({
  signal,
}) => {
  const readinessReleased = [createDeferredCore(), createDeferredCore()] as const;
  let readinessReleases = 0;
  const hardware = installSyntheticSpeechHardware({
    onTurnTtsReleased: () => readinessReleased[readinessReleases++]?.resolve(),
  });
  const createSession = vi.mocked(hardware.provider.createSession).getMockImplementation();
  if (!createSession) {
    throw new Error("Expected synthetic provider construction owner");
  }
  let captures = 0;
  vi.mocked(hardware.provider.createSession).mockImplementation((request) => ({
    ...createSession(request),
    finishInput() {
      captures++;
      request.onTranscript?.(`Inspect synthetic capture ${captures}.`, {
        utteranceId: `activity-input-${captures}`,
      });
      return { activity: "observed" as const };
    },
  }));
  const quiet = createDeferredCore();
  const spoken = createDeferredCore();
  void quiet.promise.catch(() => {});
  void spoken.promise.catch(() => {});
  const ownerSettlements: Promise<void>[] = [];
  let models = 0;
  let terminalSeq: number | undefined;
  let secondSpokenTurnId: string | undefined;
  vi.mocked(context.broadcastToConnIds).mockImplementation((_name, payload) => {
    if (!isRecord(payload) || !isRecord(payload.talkEvent)) {
      return;
    }
    const event = payload.talkEvent;
    if (event.type === "session.error") {
      quiet.reject(new Error("Native activity input failed"));
      spoken.reject(new Error("Native activity reply failed"));
    }
    if (
      event.type === "transcript.done" &&
      isRecord(event.payload) &&
      event.payload.role === "user" &&
      event.payload.text === "Inspect synthetic capture 2." &&
      typeof event.turnId === "string"
    ) {
      secondSpokenTurnId = event.turnId;
    }
    if (
      event.type === "turn.ended" &&
      secondSpokenTurnId !== undefined &&
      event.turnId === secondSpokenTurnId
    ) {
      spoken.resolve();
    }
    if (
      event.type === "input.outcome" &&
      event.captureId === "capture-silent" &&
      isRecord(event.payload) &&
      event.payload.scope === "capture" &&
      event.payload.outcome === "transcribed" &&
      typeof event.seq === "number"
    ) {
      terminalSeq = event.seq;
    }
    const state = event.payload;
    if (
      event.type === "session.activity" &&
      typeof event.seq === "number" &&
      terminalSeq !== undefined &&
      event.seq > terminalSeq &&
      isRecord(state) &&
      isRecord(state.input) &&
      state.input.phase === "listening" &&
      state.input.pending === 0 &&
      isRecord(state.work) &&
      state.work.pending === 0 &&
      state.work.queued === 0 &&
      state.work.running === 0 &&
      isRecord(state.output) &&
      state.output.state === "idle"
    ) {
      quiet.resolve();
    }
  });
  mocks.runEmbeddedAgent.mockImplementation(async (params) =>
    publishNativeSpeechModelRun(params, async (persist) => {
      const index = models++;
      if (index > 1) {
        throw new Error("Native activity caused an unsolicited model request");
      }
      params.onExecutionPhase?.({ phase: "model_call_started" });
      const owner = params.sessionKey ? replyRunRegistry.get(params.sessionKey) : undefined;
      if (!owner?.ownerSettlement) {
        throw new Error("Expected actual native reply owner settlement");
      }
      ownerSettlements.push(owner.ownerSettlement);
      const text = index === 0 ? SILENT_REPLY_TOKEN : "The second synthetic capture completed.";
      await persist(
        makeAgentAssistantMessage({
          model: "synthetic-native-consult",
          content: [{ type: "text", text }],
        }),
      );
      if (index !== 0) {
        await params.onBlockReply?.({ text });
      }
      await params.waitForPendingInput?.(params.abortSignal);
      return {
        payloads: index === 0 ? [] : [{ text }],
        meta: {
          durationMs: 0,
          ...(index === 0 ? { finalAssistantRawText: text, finalAssistantVisibleText: text } : {}),
        },
      };
    }),
  );
  const call = await createSpeechRelayCall({ capabilities });
  try {
    await dispatch("talk.session.acknowledgeMark", {
      sessionId: call.sessionId,
      markName: call.readyMark,
    });
    await dispatch("talk.session.appendAudio", {
      sessionId: call.sessionId,
      audioBase64: Buffer.alloc(640).toString("base64"),
      endOfInput: true,
      captureId: "capture-silent",
    });
    await withinTest(quiet.promise, signal);
    await withinTest(readinessReleased[0].promise, signal);
    await withinTest(Promise.all(ownerSettlements), signal);
    expect(models).toBe(1);
    expect(mocks.streamSpeech).not.toHaveBeenCalled();
    expect(activityEvents()).toContainEqual(
      expect.objectContaining({
        type: "session.activity",
        payload: expect.objectContaining({ work: expect.objectContaining({ pending: 1 }) }),
      }),
    );
    expect(activityEvents()).toContainEqual(
      expect.objectContaining({
        type: "session.activity",
        payload: expect.objectContaining({ work: expect.objectContaining({ running: 1 }) }),
      }),
    );
    expect(getUnifiedTalkSession(call.sessionId).kind).toBe("speech-relay");
    expect(hardware.close).not.toHaveBeenCalled();
    await dispatch("talk.session.appendAudio", {
      sessionId: call.sessionId,
      audioBase64: Buffer.alloc(640).toString("base64"),
      endOfInput: true,
      captureId: "capture-spoken",
    });
    await withinTest(Promise.all([spoken.promise, readinessReleased[1].promise]), signal);
    await withinTest(Promise.all(ownerSettlements), signal);
    expect(models).toBe(2);
    expect(captures).toBe(2);
    expect(mocks.streamSpeech).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "The second synthetic capture completed." }),
    );
    expect(hardware.releaseStream).toHaveBeenCalledOnce();
    expect(hardware.turnTtsReleases).toHaveLength(2);
    for (const release of hardware.turnTtsReleases) {
      expect(release).toHaveBeenCalledOnce();
    }
    expect(context.broadcastToConnIds).not.toHaveBeenCalledWith(
      "talk.event",
      expect.objectContaining({ talkEvent: expect.objectContaining({ type: "session.error" }) }),
      expect.anything(),
    );
  } finally {
    try {
      await Promise.all(ownerSettlements);
    } finally {
      await dispatch("talk.session.close", { sessionId: call.sessionId });
    }
  }
});

it("an admitted greeting remains preparing across readiness and an empty capture", async ({
  signal,
}) => {
  testState.config.talk = {
    ...testState.config.talk,
    speech: { agentProfiles: { voice: { greeting: { enabled: true, timeZone: "UTC" } } } },
  };
  const hardware = installSyntheticSpeechHardware();
  const createSession = vi.mocked(hardware.provider.createSession).getMockImplementation();
  if (!createSession) {
    throw new Error("Expected synthetic provider construction owner");
  }
  vi.mocked(hardware.provider.createSession).mockImplementation((request) => ({
    ...createSession(request),
    finishInput: () => ({ activity: "none" as const }),
  }));
  mocks.runEmbeddedAgent.mockImplementation(async (params) =>
    publishNativeSpeechModelRun(params, async () => ({
      payloads: [{ text: "Hello, synthetic caller." }],
      meta: { durationMs: 0 },
    })),
  );
  const ended = createDeferredCore();
  void ended.promise.catch(() => {});
  vi.mocked(context.broadcastToConnIds).mockImplementation((_name, payload) => {
    if (isRecord(payload) && isRecord(payload.talkEvent)) {
      if (payload.talkEvent.type === "turn.ended") {
        ended.resolve();
      } else if (payload.talkEvent.type === "session.error") {
        ended.reject(new Error("Native greeting failed"));
      }
    }
  });
  const call = await createSpeechRelayCall({ capabilities });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    expect(activityEvents()).toEqual([]);
    await dispatch("talk.session.acknowledgeMark", {
      sessionId: call.sessionId,
      markName: call.readyMark,
    });
    expect(activityEvents().at(-1)).toMatchObject({
      payload: expect.objectContaining({
        output: expect.objectContaining({ state: "preparing", purpose: "greeting" }),
      }),
    });
    await dispatch("talk.session.appendAudio", {
      sessionId: call.sessionId,
      audioBase64: "",
      endOfInput: true,
      captureId: "capture-during-greeting",
    });
    const events = activityEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "input.outcome",
        captureId: "capture-during-greeting",
        payload: { version: 1, scope: "capture", outcome: "no-input" },
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "session.activity",
      payload: expect.objectContaining({
        output: expect.objectContaining({ state: "preparing", purpose: "greeting" }),
      }),
    });
    expect(context.broadcastToConnIds).not.toHaveBeenCalledWith(
      "talk.event",
      expect.objectContaining({ type: "audio" }),
      expect.anything(),
    );
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(hardware.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    await withinTest(ended.promise, signal);
    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "talk.event",
      expect.objectContaining({ type: "audio", sessionId: call.sessionId }),
      expect.anything(),
    );
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
  } finally {
    await vi.advanceTimersByTimeAsync(150);
    vi.useRealTimers();
    await dispatch("talk.session.close", { sessionId: call.sessionId });
  }
});

it("rejects capture correlation outside a speech relay without changing its connection authority", async () => {
  const call = await createRelayCall();
  try {
    expect(
      await dispatch("talk.session.appendAudio", {
        sessionId: call.sessionId,
        audioBase64: "AAAA",
        captureId: "capture-foreign-mode",
      }),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("captureId requires"),
      }),
    );
  } finally {
    await dispatch("talk.session.close", { sessionId: call.sessionId });
  }
});

it.for([
  { mode: "realtime", transport: "gateway-relay" },
  { mode: "stt-tts", transport: "managed-room" },
])("refuses activity negotiation for a non-speech relay %j", async (mode) => {
  const hardware = installSyntheticSpeechHardware();
  expect(
    await dispatch("talk.session.create", {
      sessionKey: "main",
      ...mode,
      capabilities: ["activity-v1"],
    }),
  ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  expect(hardware.provider.prepareSession).not.toHaveBeenCalled();
  expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
});

it("native speech keeps activity events opt-in for existing clients", async () => {
  installSyntheticSpeechHardware({ finishInput: () => undefined });
  const call = await createSpeechRelayCall();
  try {
    expect(call.audio).not.toHaveProperty("activityEvents");
    await dispatch("talk.session.acknowledgeMark", {
      sessionId: call.sessionId,
      markName: call.readyMark,
    });
    await dispatch("talk.session.appendAudio", {
      sessionId: call.sessionId,
      audioBase64: "",
      endOfInput: true,
    });
    expect(activityEvents()).toEqual([]);
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
  } finally {
    await dispatch("talk.session.close", { sessionId: call.sessionId });
  }
});
