import { describe, expect, it, vi } from "vitest";
import type { ReplySpeechRunBinding } from "../../auto-reply/reply/reply-speech-presentation.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  createConversationInputAdmission,
} from "../conversation-input-admission.js";
import type { ConversationReplyResult } from "../conversation-reply.js";
import { readAdmittedSpeechInput } from "./native-control.js";
import { createNativeSpeechInput } from "./native-input.js";
import type { SpeechUtterance } from "./output.js";
import { createSpeechInputMetadata } from "./session-input-identity.js";
import type { SpeechNativeInputParams } from "./types.js";
import { createSpeechVideoInput } from "./video-input.js";

const controlRuntime = vi.hoisted(() => ({
  resolveActiveEmbeddedRunOwnerByRunId: vi.fn(),
  resolveActiveReplyRunOwnerForSignal: vi.fn(),
  resolveActiveEmbeddedRunSessionId: vi.fn(),
  abortEmbeddedAgentRun: vi.fn(),
}));

// mock-isolation: control selection is real; this unit suite owns no embedded model runtime.
vi.mock("../agent-run-control.runtime.js", () => ({
  realtimeVoiceControlRuntime: controlRuntime,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let generation = 1;
  let stopped = false;
  const calls: SpeechNativeInputParams[] = [];
  const pending: ReturnType<typeof deferred<ConversationReplyResult>>[] = [];
  const reached = new Map<number, ReturnType<typeof deferred<void>>>();
  const dispatch = vi.fn(async (input: SpeechNativeInputParams) => {
    const control = readAdmittedSpeechInput(input);
    const accepted = control && consumeConversationInputAdmission(control.admission, control.scope);
    if (accepted) {
      claimConversationInputExecution(accepted);
    }
    calls.push(input);
    const result = deferred<ConversationReplyResult>();
    pending.push(result);
    reached.get(calls.length)?.resolve();
    try {
      return await result.promise;
    } finally {
      accepted?.release?.();
    }
  });
  const video = createSpeechVideoInput(undefined);
  const utterances: SpeechUtterance[] = [];
  const output = {
    createSpeechUtterance: vi.fn((waitingTurn?: number): SpeechUtterance => {
      const value = {
        generation,
        waitingGeneration: 0,
        waitingTurn,
        chunks: [],
        transcriptEntries: [],
        playbackStarted: false,
        finalized: false,
        failed: false,
      };
      utterances.push(value);
      return value;
    }),
    isCurrentSpeechUtterance: (value: SpeechUtterance) =>
      !stopped && !value.finalized && value.generation === generation,
    enqueueSpeechChunk: vi.fn((text: string | undefined, value: SpeechUtterance) => {
      if (text && output.isCurrentSpeechUtterance(value)) {
        value.chunks.push(text);
      }
    }),
    finalizeSpeechUtterance: vi.fn(),
    enqueueSpeechResult: vi.fn(),
  };
  const finished = new Map<number, ReturnType<typeof deferred<void>>>();
  const finishWaiting = vi.fn((turn: number) => finished.get(turn)?.resolve());
  const abortSpeechUtterance = vi.fn((utterance: SpeechUtterance) => {
    if (!output.isCurrentSpeechUtterance(utterance)) {
      return;
    }
    generation++;
    utterance.finalized = true;
    if (utterance.waitingTurn !== undefined) {
      finishWaiting(utterance.waitingTurn);
    }
  });
  const recordUnplayed = vi.fn();
  let turn = 0;
  const owner = createNativeSpeechInput({
    dispatch,
    session: {
      sessionId: "connection-a",
      requesterSessionKey: "agent:example:call",
      config: {
        agentId: "example",
        audioFormat: "pcm16-24khz",
        providers: {},
        responseStreaming: "sentence",
      },
    },
    inputs: createSpeechInputMetadata(video, "connection-a"),
    video,
    output,
    isStopped: () => stopped,
    getGeneration: () => generation,
    startWaiting: () => ++turn,
    finishWaiting,
    abortSpeechUtterance,
    waitForInput: () => undefined,
    recordUnplayed,
    onFailure: vi.fn(),
  });
  const bound = (runId: string): ReplySpeechRunBinding => ({
    runId,
    sessionId: "native-session",
    abortSignal: new AbortController().signal,
    assertCurrent: vi.fn<() => void>(),
  });
  return {
    owner,
    calls,
    pending,
    output,
    finishWaiting,
    abortSpeechUtterance,
    recordUnplayed,
    bound,
    utterances,
    waitForFinished(turn: number) {
      if (finishWaiting.mock.calls.some(([value]) => value === turn)) {
        return Promise.resolve();
      }
      const done = finished.get(turn) ?? deferred<void>();
      finished.set(turn, done);
      return done.promise;
    },
    admitControl(mode: "status" | "cancel" | "steer" | "followup") {
      const release = vi.fn();
      let current = true;
      const scope = {
        agentId: "example",
        conversationId: "connection-a",
        inputId: `control-${mode}`,
        purpose: "steering" as const,
      };
      return {
        release,
        revoke: () => {
          current = false;
        },
        control: {
          scope,
          mode,
          text: "An authenticated control",
          admission: createConversationInputAdmission({
            scope,
            source: { channelId: "webchat", sessionKey: "agent:example:call" },
            assertCurrent() {
              if (!current) {
                throw new Error("Original caller revoked");
              }
            },
            assertInputCurrent() {},
            release,
            prepareContext(text) {
              return { AgentId: "example", SessionKey: "agent:example:call", Body: text };
            },
          }),
        },
      };
    },
    waitForCall(count: number) {
      if (calls.length >= count) {
        return Promise.resolve();
      }
      const ready = reached.get(count) ?? deferred<void>();
      reached.set(count, ready);
      return ready.promise;
    },
    nextGeneration: () => ++generation,
    close: () => {
      stopped = true;
    },
  };
}

describe("native speech input media ownership", () => {
  it.for([false, true])(
    "cancels native media, not its task (queued speech: %s)",
    async (queued) => {
      const f = fixture();
      const submitted = f.owner.submit({ text: "Original request", hasOnset: false });
      await f.waitForCall(1);
      const binding = f.bound("run-a");
      f.calls[0]!.onNativeRunBound?.(binding);
      if (queued) {
        await f.calls[0]!.onSpeakableText?.({ type: "chunk", text: "Queued speech" });
      }
      await f.calls[0]!.onSpeakableText?.({ type: "abort" });
      expect(f.abortSpeechUtterance).toHaveBeenCalledExactlyOnceWith(f.utterances[0]);
      expect(f.finishWaiting).toHaveBeenCalledWith(1);
      expect(f.output.isCurrentSpeechUtterance(f.utterances[0]!)).toBe(false);
      expect(binding.abortSignal.aborted).toBe(false);
      expect(f.owner.captureRun()?.binding).toBe(binding);
      f.pending[0]!.resolve({ kind: "reply", reply: { text: "Settled native result" } });
      await expect(submitted).resolves.toMatchObject({ kind: "reply" });
      expect(f.output.finalizeSpeechUtterance).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(1);
    },
  );

  it("cancels pending output after its latest native run settles", async () => {
    const f = fixture();
    const submitted = f.owner.submit({ text: "Original request", hasOnset: false });
    await f.waitForCall(1);
    f.calls[0]!.onNativeRunBound?.(f.bound("run-a"));
    await f.calls[0]!.onSpeakableText?.({ type: "chunk", text: "Pending speech" });
    f.pending[0]!.resolve({ kind: "reply", reply: { text: "Pending speech" } });
    await submitted;
    expect(f.owner.captureRun()).toBeUndefined();
    await f.calls[0]!.onSpeakableText?.({ type: "abort" });
    expect(f.abortSpeechUtterance).toHaveBeenCalledExactlyOnceWith(f.utterances[0]);
    expect(f.finishWaiting).toHaveBeenCalledWith(1);
  });

  it.for([false, true])(
    "does not let an older native abort cancel newer output (new generation: %s)",
    async (newGeneration) => {
      const f = fixture();
      const first = f.owner.submit({ text: "Original request", hasOnset: false });
      await f.waitForCall(1);
      f.calls[0]!.onNativeRunBound?.(f.bound("run-a"));
      await f.calls[0]!.onSpeakableText?.({ type: "chunk", text: "Old speech" });
      if (newGeneration) {
        f.nextGeneration();
      }
      const second = f.owner.submit({ text: "New request", hasOnset: false });
      await f.waitForCall(2);
      f.calls[1]!.onNativeRunBound?.(f.bound("run-b"));
      await f.calls[1]!.onSpeakableText?.({ type: "chunk", text: "New speech" });
      await f.calls[0]!.onSpeakableText?.({ type: "abort" });
      expect(f.abortSpeechUtterance).not.toHaveBeenCalled();
      expect(f.utterances[0]!.finalized).toBe(true);
      expect(f.output.isCurrentSpeechUtterance(f.utterances[1]!)).toBe(true);
      expect(f.finishWaiting).not.toHaveBeenCalledWith(2);
      f.pending[0]!.resolve({ kind: "reply", reply: { text: "Old result" } });
      f.pending[1]!.resolve({ kind: "reply", reply: { text: "New result" } });
      await Promise.all([first, second]);
      expect(f.output.finalizeSpeechUtterance).toHaveBeenCalledExactlyOnceWith(
        f.utterances[1],
        "New result",
      );
    },
  );

  it.for(["steer", "followup"] as const)(
    "keeps authenticated %s on the native input and media owner",
    async (mode) => {
      const f = fixture();
      const first = f.owner.submit({ text: "Original request", hasOnset: false });
      await f.waitForCall(1);
      f.calls[0]!.onNativeRunBound?.(f.bound("run-a"));
      const admitted = f.admitControl(mode);
      const controlled = f.owner.control(admitted.control);
      await f.waitForCall(2);
      expect(f.calls[1]).toMatchObject({
        inputId: admitted.control.scope.inputId,
        purpose: "steering",
        queueMode: mode,
        args: { question: admitted.control.text },
      });
      f.calls[1]!.onQueueAccepted();
      expect(await controlled).toMatchObject({ ok: true, mode, queued: true });
      if (mode === "followup") {
        f.calls[1]!.onInputDisposition?.({ mode: "followup", committed: false });
        f.pending[0]!.resolve({ kind: "reply", reply: { text: "Original answer" } });
        await first;
        f.calls[1]!.onNativeRunBound?.(f.bound("run-b"));
        f.pending[1]!.resolve({ kind: "reply", reply: { text: "Follow-up answer" } });
        await f.waitForFinished(2);
        expect(f.output.finalizeSpeechUtterance).toHaveBeenCalledWith(
          f.utterances[1],
          "Follow-up answer",
        );
      } else {
        f.calls[1]!.onInputDisposition?.({ mode: "steer", committed: true, runId: "run-a" });
        f.pending[1]!.resolve({ kind: "steered" });
        f.pending[0]!.resolve({ kind: "reply", reply: { text: "Combined answer" } });
        await first;
      }
      expect(admitted.release).toHaveBeenCalledOnce();
    },
  );

  it.for(["status", "cancel"] as const)(
    "admits %s without manufacturing another native input",
    async (mode) => {
      const f = fixture();
      const admitted = f.admitControl(mode);
      const result = await f.owner.control(admitted.control);
      expect(result).toMatchObject({ mode, active: false });
      expect(f.calls).toHaveLength(0);
      expect(admitted.release).toHaveBeenCalledOnce();
    },
  );

  it("rejects revoked controls before consulting another native owner", async () => {
    const f = fixture();
    const admitted = f.admitControl("cancel");
    admitted.revoke();
    await expect(f.owner.control(admitted.control)).rejects.toThrow("Original caller revoked");
    expect(f.calls).toHaveLength(0);
    expect(admitted.release).toHaveBeenCalledOnce();
  });

  it.for(["status", "cancel"] as const)(
    "pins authenticated %s to the media owner's exact native run",
    async (mode) => {
      const f = fixture();
      const first = f.owner.submit({ text: "Original request", hasOnset: false });
      await f.waitForCall(1);
      f.calls[0]!.onNativeRunBound?.(f.bound("run-a"));
      const abort = vi.fn(() => true);
      controlRuntime.resolveActiveEmbeddedRunOwnerByRunId
        .mockReset()
        .mockImplementation((runId) =>
          runId === "run-a"
            ? { sessionId: "native-session", sessionKey: "agent:example:call", abort }
            : undefined,
        );
      controlRuntime.resolveActiveEmbeddedRunSessionId.mockClear();
      controlRuntime.abortEmbeddedAgentRun.mockClear();
      const admitted = f.admitControl(mode);
      expect(await f.owner.control(admitted.control)).toMatchObject({
        ok: true,
        mode,
        sessionId: "native-session",
        active: true,
        ...(mode === "cancel" ? { aborted: true } : {}),
      });
      expect(abort).toHaveBeenCalledTimes(mode === "cancel" ? 1 : 0);
      expect(controlRuntime.resolveActiveEmbeddedRunSessionId).not.toHaveBeenCalled();
      expect(controlRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(1);
      expect(admitted.release).toHaveBeenCalledOnce();
      f.pending[0]!.resolve({ kind: "reply", reply: { text: "" } });
      await first;
      controlRuntime.resolveActiveEmbeddedRunOwnerByRunId.mockReset();
    },
  );

  it("plays an immediate native answer without manufacturing a model run", async () => {
    const f = fixture();
    const input = f.owner.submit({ text: "A native shortcut", hasOnset: false });
    await f.waitForCall(1);
    f.pending[0]!.resolve({ kind: "reply", reply: { text: "Native answer" } });
    await input;
    expect(f.owner.captureRun()).toBeUndefined();
    expect(f.output.finalizeSpeechUtterance).toHaveBeenCalledExactlyOnceWith(
      f.utterances[0],
      "Native answer",
    );
  });

  it("dispatches each input to the native owner without a competing local work queue", async () => {
    const f = fixture();
    const first = f.owner.submit({ text: "First request", hasOnset: false });
    await f.waitForCall(1);
    f.calls[0]!.onNativeRunBound?.(f.bound("run-a"));
    const onsetRun = f.owner.captureRun();
    f.nextGeneration();
    const accepted = vi.fn();
    const second = f.owner.submit({
      text: "Also consider this",
      hasOnset: true,
      onsetRun,
      onAccepted: accepted,
    });
    await f.waitForCall(2);
    expect(f.calls[1]!.queueMode).toBe("steer");
    f.calls[1]!.onInputDisposition?.({ mode: "steer", committed: true, runId: "run-a" });
    f.pending[1]!.resolve({ kind: "steered" });
    await second;
    expect(accepted).toHaveBeenCalled();
    expect(f.finishWaiting).not.toHaveBeenCalledWith(2);
    await f.calls[0]!.onSpeakableText?.({ type: "chunk", text: "Combined answer" });
    f.pending[0]!.resolve({ kind: "reply", reply: { text: "Combined answer", delivered: true } });
    await first;
    expect(f.utterances[0]!.chunks).toEqual([]);
    expect(f.utterances[1]!.chunks).toEqual(["Combined answer"]);
    expect(f.output.finalizeSpeechUtterance).toHaveBeenCalledWith(
      f.utterances[1],
      "Combined answer",
    );
    expect(f.calls[0]!.transcript).toEqual([]);
    expect(f.calls[0]!.abortSignal).toBeUndefined();
  });

  it("keeps queued follow-up output attached to its actual later run instead of the drainer", async () => {
    const f = fixture();
    const first = f.owner.submit({ text: "Original", hasOnset: false });
    await f.waitForCall(1);
    f.calls[0]!.onNativeRunBound?.(f.bound("run-a"));
    f.nextGeneration();
    const second = f.owner.submit({ text: "Next", hasOnset: true, onsetRun: f.owner.captureRun() });
    await f.waitForCall(2);
    f.calls[1]!.onInputDisposition?.({ mode: "followup", committed: false });
    f.pending[0]!.resolve({ kind: "reply", reply: { text: "Old answer" } });
    await first;
    expect(f.recordUnplayed).toHaveBeenCalledWith(f.utterances[0], "Old answer");
    f.calls[1]!.onNativeRunBound?.(f.bound("run-b"));
    f.pending[1]!.resolve({ kind: "reply", reply: { text: "New answer" } });
    await second;
    expect(f.output.finalizeSpeechUtterance).toHaveBeenCalledExactlyOnceWith(
      f.utterances[1],
      "New answer",
    );
  });

  it("does not adopt a different backend on a matching output connection", async () => {
    const f = fixture();
    const first = f.owner.submit({ text: "First", hasOnset: false });
    await f.waitForCall(1);
    f.calls[0]!.onNativeRunBound?.(f.bound("run-a"));
    f.nextGeneration();
    const second = f.owner.submit({
      text: "Late addition",
      hasOnset: true,
      onsetRun: f.owner.captureRun(),
    });
    await f.waitForCall(2);
    f.calls[1]!.onInputDisposition?.({ mode: "steer", committed: true, runId: "replacement" });
    f.pending[1]!.resolve({ kind: "steered" });
    f.pending[0]!.resolve({ kind: "reply", reply: { text: "Old answer" } });
    await Promise.all([first, second]);
    expect(f.output.finalizeSpeechUtterance).not.toHaveBeenCalled();
    expect(f.recordUnplayed).toHaveBeenCalled();
  });

  it("finishes accepted native work after audio closure without playing or replaying it", async () => {
    const f = fixture();
    const input = f.owner.submit({ text: "Complete this task", hasOnset: false });
    await f.waitForCall(1);
    f.calls[0]!.onNativeRunBound?.(f.bound("run-a"));
    f.close();
    f.pending[0]!.resolve({ kind: "reply", reply: { text: "Completed" } });
    expect(await input).toMatchObject({ kind: "reply" });
    expect(f.output.finalizeSpeechUtterance).not.toHaveBeenCalled();
    expect(f.recordUnplayed).toHaveBeenCalledWith(f.utterances[0], "Completed");
    expect(f.calls).toHaveLength(1);
  });

  it("keeps onset/playback facts on the original completed run when STT arrives after a replacement", async () => {
    const f = fixture();
    const first = f.owner.submit({ text: "Original", inputId: "input-a", hasOnset: false });
    await f.waitForCall(1);
    f.calls[0]!.onNativeRunBound?.(f.bound("run-a"));
    f.utterances[0]!.playbackStarted = true;
    f.utterances[0]!.transcriptEntries.push({
      at: "2026-01-01T00:00:00Z",
      role: "assistant",
      text: "Never copy this",
      audioDelivery: "started",
    });
    const onsetRun = f.owner.captureRun();
    const onsetPlayback = f.owner.capturePlayback(1234, true);
    f.pending[0]!.resolve({ kind: "reply", reply: { text: "Old result" } });
    await first;
    expect(f.owner.captureRun()).toBeUndefined();
    expect(f.owner.capturePlayback()?.preceding.runActiveAtOnset).toBe(false);
    f.nextGeneration();
    const replacement = f.owner.submit({
      text: "Replacement",
      inputId: "input-b",
      hasOnset: false,
    });
    await f.waitForCall(2);
    f.calls[1]!.onNativeRunBound?.(f.bound("run-b"));
    const delayed = f.owner.submit({
      text: "Addition",
      inputId: "input-c",
      hasOnset: true,
      onsetRun,
      onsetPlayback,
    });
    await f.waitForCall(3);
    expect(f.calls[2]!.queueMode).toBe("followup");
    expect(f.calls[2]!.playbackObservation).toMatchObject({
      version: 1,
      inputId: "input-c",
      outputGeneration: 2,
      onsetAtMs: 1234,
      preceding: {
        runId: "run-a",
        sessionId: "native-session",
        inputId: "input-a",
        outputGeneration: 1,
        runActiveAtOnset: true,
        playbackActiveAtOnset: true,
        segments: { started: 1 },
      },
    });
    expect(JSON.stringify(f.calls[2]!.playbackObservation)).not.toContain("Never copy this");
    expect(f.calls[2]!.transcript).toEqual([]);
    f.pending[2]!.resolve({ kind: "steered" });
    f.pending[1]!.resolve({ kind: "reply", reply: { text: "New result" } });
    await Promise.all([replacement, delayed]);
  });
});
