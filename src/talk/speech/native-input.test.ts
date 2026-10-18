import { describe, expect, it, vi } from "vitest";
import type { ReplySpeechRunBinding } from "../../auto-reply/reply/reply-speech-presentation.js";
import type { ConversationReplyResult } from "../conversation-reply.js";
import { createNativeSpeechInput } from "./native-input.js";
import type { SpeechUtterance } from "./output.js";
import { createSpeechInputMetadata } from "./session-input-identity.js";
import type { SpeechNativeInputParams } from "./types.js";
import { createSpeechVideoInput } from "./video-input.js";

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
    calls.push(input);
    const result = deferred<ConversationReplyResult>();
    pending.push(result);
    reached.get(calls.length)?.resolve();
    return result.promise;
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
  const finishWaiting = vi.fn();
  const recordUnplayed = vi.fn();
  let turn = 0;
  const owner = createNativeSpeechInput({
    dispatch,
    session: {
      sessionId: "connection-a",
      config: { audioFormat: "pcm16-24khz", providers: {}, responseStreaming: "sentence" },
    },
    inputs: createSpeechInputMetadata(video, "connection-a"),
    video,
    output,
    isStopped: () => stopped,
    getGeneration: () => generation,
    startWaiting: () => ++turn,
    finishWaiting,
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
    recordUnplayed,
    bound,
    utterances,
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
