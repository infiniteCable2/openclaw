import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import type { TtsTelephonyStreamResult } from "../../tts/tts-runtime-types.js";
import { createSpeechOutput } from "./output.js";

type OutputParams = Parameters<typeof createSpeechOutput>[0];

function createFixture(
  synthesize: () => Promise<TtsTelephonyStreamResult>,
  writeOutput: (audio: Buffer) => Promise<void>,
) {
  let generation = 0;
  let stopped = false;
  let waitingTurn: number | undefined;
  const transcripts: { role: string; text: string; audioDelivery?: string }[] = [];
  const emit = vi.fn<ReturnType<OutputParams["getHarness"]>["emit"]>();
  const finishOutputAudio = vi.fn();
  const endTurn = vi.fn();
  const harness = {
    talk: { activeTurnId: "synthetic-turn" },
    outputActivity: { markPlaybackStarted: vi.fn() },
    recordOutputAudio: vi.fn(),
    recordTranscript(role: string, text: string) {
      const entry = { role, text };
      transcripts.push(entry);
      return entry;
    },
    ensureTurn: () => "synthetic-turn",
    finishOutputAudio,
    endTurn,
    emit,
  } as unknown as ReturnType<OutputParams["getHarness"]>;
  const activeTtsAborts: OutputParams["activeTtsAborts"] = new Set();
  const activeTtsReaders: OutputParams["activeTtsReaders"] = new Set();
  const warn = vi.fn();
  const onOutput = vi.fn<NonNullable<OutputParams["onOutput"]>>();
  const onActivity = vi.fn<NonNullable<OutputParams["onActivity"]>>();
  const onSpeechCaption = vi.fn<NonNullable<OutputParams["onSpeechCaption"]>>();
  const waitingStop = vi.fn(async (): Promise<void> => undefined);
  const waitingIdle = vi.fn((_turn: number) => undefined);
  let stopping = Promise.resolve();
  const stopWaiting = () => {
    stopping = waitingStop();
    return stopping;
  };
  const finishWaitingTurn = vi.fn((turn: number) => {
    if (waitingTurn === turn) {
      waitingTurn = undefined;
      void stopWaiting();
    }
  });
  const waitForInput = vi.fn(async () => {});
  const output = createSpeechOutput({
    config: { audioFormat: "pcm16-24khz", providers: {} },
    fullConfig: {},
    runtime: {
      tts: { streamTextToSpeechTelephony: synthesize },
    } as unknown as OutputParams["runtime"],
    surface: { displayName: "Synthetic speech", logScope: "test", sessionIdPrefix: "test" },
    sessionId: "prefetch-test",
    agentLogScope: "test",
    logger: { info: vi.fn(), warn, error: vi.fn() },
    onOutput,
    onActivity,
    onSpeechCaption,
    getHarness: () => harness,
    isStopped: () => stopped,
    getOutputGeneration: () => generation,
    getWaitingTurn: () => waitingTurn,
    finishWaitingTurn,
    waitForInput,
    waiting: {
      generation: 0,
      stop: stopWaiting,
      joinStop: () => stopping,
      stopInBackground: vi.fn(),
      onOutputIdle: waitingIdle,
    } as unknown as OutputParams["waiting"],
    speechCancellation: {
      removeProvisionalTranscriptEntries: vi.fn(),
    } as unknown as OutputParams["speechCancellation"],
    activeTtsAborts,
    activeTtsReaders,
    transport: {
      onFatal() {},
      startInput() {},
      writeOutput,
      clearOutput: async () => undefined,
      stop: async () => undefined,
      dispose: async () => undefined,
    },
    onOutputTurn: vi.fn(),
  });
  return {
    output,
    finishOutputAudio,
    endTurn,
    emit,
    warn,
    onOutput,
    onActivity,
    onSpeechCaption,
    transcripts,
    activeTtsAborts,
    activeTtsReaders,
    waitingStop,
    waitingIdle,
    finishWaitingTurn,
    waitForInput,
    setWaitingTurn(turn: number) {
      waitingTurn = turn;
    },
    cancel() {
      generation += 1;
      for (const controller of activeTtsAborts) {
        controller.abort();
      }
      return Promise.all([...activeTtsReaders].map((reader) => reader.cancel()));
    },
    close() {
      stopped = true;
    },
  };
}

function completeResult(
  audio = Buffer.alloc(4_800),
  release: () => Promise<void> = vi.fn(async () => undefined),
) {
  return {
    success: true,
    sampleRate: 24_000,
    outputFormat: "pcm",
    release,
    audioStream: new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(audio);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
  };
}

describe("speech output compute/playout overlap", () => {
  it("queues status without holding native work and retains waiting/answer custody until physical release", async () => {
    const releasing = createDeferred();
    const allowRelease = createDeferred();
    const release = vi.fn(async () => {
      releasing.resolve();
      await allowRelease.promise;
    });
    const synthesize = vi.fn(async () => completeResult());
    synthesize.mockImplementationOnce(async () => completeResult(Buffer.alloc(4_800), release));
    const f = createFixture(synthesize, async () => {});
    f.setWaitingTurn(9);
    expect(f.output.enqueueSpeechStatus("Context maintenance.", 0, 9)).toBe(true);
    let receipt: ReturnType<typeof f.output.finalizeSpeechUtterance>;
    try {
      await releasing.promise;
      expect(f.endTurn).not.toHaveBeenCalled();
      expect(f.finishWaitingTurn).not.toHaveBeenCalled();
      expect(f.finishOutputAudio).not.toHaveBeenCalled();
      const answer = f.output.createSpeechUtterance(9);
      receipt = f.output.finalizeSpeechUtterance(answer, "The actual answer.");
    } finally {
      allowRelease.resolve();
      await f.output.drain();
    }
    expect(release).toHaveBeenCalledOnce();
    expect(f.waitingIdle).toHaveBeenCalledWith(9);
    expect(f.endTurn).toHaveBeenCalledOnce();
    expect(f.finishWaitingTurn).toHaveBeenCalledExactlyOnceWith(9);
    await expect(receipt?.completion).resolves.toEqual(["The actual answer."]);
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(synthesize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "Context maintenance." }),
    );
    expect(synthesize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "The actual answer." }),
    );
  });

  it.each(["synthesis", "sink", "audio-completion"] as const)(
    "does not fail the native turn or replace its answer after status %s failure",
    async (phase) => {
      const synthesize = vi.fn(async () => completeResult());
      const write = vi.fn(async () => {});
      const f = createFixture(synthesize, write);
      if (phase === "synthesis") {
        synthesize.mockRejectedValueOnce(new Error("Status TTS unavailable"));
      }
      if (phase === "sink") {
        write.mockRejectedValueOnce(new Error("Status sink unavailable"));
      }
      if (phase === "audio-completion") {
        f.finishOutputAudio.mockImplementationOnce(() => {
          throw new Error("Status observer unavailable");
        });
      }
      f.setWaitingTurn(9);
      f.output.enqueueSpeechStatus("Context maintenance.", 0, 9);
      await f.output.drain();
      expect(f.endTurn).not.toHaveBeenCalled();
      expect(f.finishWaitingTurn).not.toHaveBeenCalled();
      const answer = f.output.createSpeechUtterance(9);
      const receipt = f.output.finalizeSpeechUtterance(answer, "The actual answer.");
      await f.output.drain();
      await expect(receipt?.completion).resolves.toEqual(["The actual answer."]);
      expect(f.endTurn).toHaveBeenCalledOnce();
      expect(synthesize).toHaveBeenCalledTimes(2);
    },
  );

  it("does not enqueue stale or closed status output", async () => {
    const synthesize = vi.fn(async () => completeResult());
    const f = createFixture(synthesize, async () => {});
    await f.cancel();
    expect(f.output.enqueueSpeechStatus("Old status.", 0)).toBe(false);
    f.close();
    expect(f.output.enqueueSpeechStatus("Closed status.", 1)).toBe(false);
    await f.output.drain();
    expect(synthesize).not.toHaveBeenCalled();
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.endTurn).not.toHaveBeenCalled();
  });

  it("keeps an empty public speak request a no-op", async () => {
    const synthesize = vi.fn(async () => completeResult());
    const fixture = createFixture(synthesize, async () => {});
    fixture.output.enqueueSpeakText(undefined);
    fixture.output.enqueueSpeakText("  ");
    await fixture.output.drain();
    expect(synthesize).not.toHaveBeenCalled();
    expect(fixture.endTurn).not.toHaveBeenCalled();
    expect(fixture.finishOutputAudio).not.toHaveBeenCalled();
    expect(fixture.onActivity).not.toHaveBeenCalled();
  });

  it("does not normalize a public speak request twice", async () => {
    const synthesize = vi.fn(async () => completeResult());
    const fixture = createFixture(synthesize, async () => {});
    fixture.output.enqueueSpeakText(`say exactly: "say exactly: 'hello'"`);
    await fixture.output.drain();
    expect(synthesize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "say exactly: 'hello'" }),
    );
  });

  it.each([false, true])(
    "settles deliberate silence after existing commentary=%s without new TTS",
    async (commentary) => {
      const handoff = createDeferred();
      const written = createDeferred();
      const synthesize = vi.fn(async () => completeResult());
      const fixture = createFixture(synthesize, async () => {
        written.resolve();
        await handoff.promise;
      });
      fixture.setWaitingTurn(9);
      const utterance = fixture.output.createSpeechUtterance(9);
      if (commentary) {
        fixture.output.enqueueSpeechChunk(
          "Checking.",
          utterance,
          undefined,
          undefined,
          undefined,
          "commentary",
        );
      }
      expect(fixture.output.finalizeSpeechUtterance(utterance, "")).toBeUndefined();
      if (commentary) {
        await written.promise;
        expect(utterance.finalized).toBe(false);
        expect(fixture.endTurn).not.toHaveBeenCalled();
      }
      handoff.resolve();
      await fixture.output.drain();
      expect(synthesize).toHaveBeenCalledTimes(commentary ? 1 : 0);
      expect(fixture.finishWaitingTurn).toHaveBeenCalledExactlyOnceWith(9);
      expect(fixture.waitingStop).toHaveBeenCalled();
      expect(fixture.finishOutputAudio).toHaveBeenCalledExactlyOnceWith("completed");
      expect(fixture.endTurn).toHaveBeenCalledOnce();
      expect(utterance.finalized).toBe(true);
      expect(fixture.onActivity).toHaveBeenLastCalledWith("listening");
      expect(fixture.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "output.text.done" }),
      );
    },
  );

  it("does not end newer output when an older silent finalizer resumes", async () => {
    const stoppedWaiting = createDeferred();
    const entered = createDeferred();
    const fixture = createFixture(
      async () => completeResult(),
      async () => {},
    );
    fixture.waitingStop.mockImplementationOnce(async () => {
      entered.resolve();
      await stoppedWaiting.promise;
    });
    fixture.setWaitingTurn(9);
    const utterance = fixture.output.createSpeechUtterance(9);
    fixture.output.finalizeSpeechUtterance(utterance, "");
    await entered.promise;
    await fixture.cancel();
    fixture.setWaitingTurn(10);
    stoppedWaiting.resolve();
    await fixture.output.drain();
    expect(fixture.endTurn).not.toHaveBeenCalled();
    expect(fixture.finishOutputAudio).not.toHaveBeenCalled();
  });

  it("joins waiting already stopped by input retirement before ending a silent turn", async () => {
    const input = createDeferred();
    const inputEntered = createDeferred();
    const stoppedWaiting = createDeferred();
    const fixture = createFixture(
      async () => completeResult(),
      async () => {},
    );
    fixture.waitForInput.mockImplementationOnce(async () => {
      inputEntered.resolve();
      await input.promise;
    });
    fixture.waitingStop.mockImplementationOnce(() => stoppedWaiting.promise);
    fixture.setWaitingTurn(9);
    const utterance = fixture.output.createSpeechUtterance(9);
    fixture.output.finalizeSpeechUtterance(utterance, "");
    await inputEntered.promise;
    fixture.finishWaitingTurn(9); // Native cleanup retires the turn while input is held.
    input.resolve();
    await setImmediate();
    expect(fixture.endTurn).not.toHaveBeenCalled();
    expect(fixture.finishOutputAudio).not.toHaveBeenCalled();
    expect(fixture.waitingStop).toHaveBeenCalledOnce();
    stoppedWaiting.resolve();
    await fixture.output.drain();
    expect(fixture.endTurn).toHaveBeenCalledOnce();
    expect(fixture.finishOutputAudio).toHaveBeenCalledExactlyOnceWith("completed");
    expect(fixture.waitingStop).toHaveBeenCalledOnce();
  });

  it("retains the input gate when a candidate arrives during silent waiting cleanup", async () => {
    const stoppedWaiting = createDeferred();
    const stopEntered = createDeferred();
    const pendingInput = createDeferred();
    const inputEntered = createDeferred();
    const fixture = createFixture(
      async () => completeResult(),
      async () => {},
    );
    fixture.waitingStop.mockImplementationOnce(async () => {
      stopEntered.resolve();
      await stoppedWaiting.promise;
    });
    fixture.waitForInput.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      inputEntered.resolve();
      await pendingInput.promise;
    });
    fixture.setWaitingTurn(9);
    const utterance = fixture.output.createSpeechUtterance(9);
    fixture.output.finalizeSpeechUtterance(utterance, "");
    await stopEntered.promise;
    stoppedWaiting.resolve();
    await inputEntered.promise;
    expect(fixture.endTurn).not.toHaveBeenCalled();
    pendingInput.resolve();
    await fixture.output.drain();
    expect(fixture.endTurn).toHaveBeenCalledOnce();
  });

  it("observes preparation, actual handoff and submission without claiming local playback drain", async () => {
    const handoff = createDeferred();
    const written = createDeferred();
    const fixture = createFixture(
      async () => completeResult(),
      async () => {
        written.resolve();
        await handoff.promise;
      },
    );
    const utterance = fixture.output.createSpeechUtterance();
    fixture.output.enqueueSpeechChunk("First.", utterance);
    expect(fixture.onOutput.mock.calls).toEqual([[0, "preparing", "speech"]]);
    await written.promise;
    expect(fixture.onOutput).toHaveBeenLastCalledWith(0, "streaming", "speech");
    fixture.output.enqueueSpeechChunk("Second.", utterance);
    // Read-ahead cannot label an already streaming generation as preparing.
    expect(fixture.onOutput.mock.calls.filter(([, state]) => state === "preparing")).toHaveLength(
      1,
    );
    expect(fixture.onOutput.mock.calls.some(([, state]) => state === "submitted")).toBe(false);
    handoff.resolve();
    await fixture.output.drain();
    expect(fixture.onOutput).toHaveBeenLastCalledWith(0, "submitted", "speech");
  });

  it("publishes admitted commentary as identified text without finalizing the answer", async () => {
    const fixture = createFixture(
      async () => completeResult(),
      async () => undefined,
    );
    const utterance = fixture.output.createSpeechUtterance();
    fixture.output.enqueueSpeechChunk(
      "Checking.",
      utterance,
      undefined,
      undefined,
      undefined,
      "commentary",
    );
    expect(fixture.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "output.text.delta",
        final: false,
        payload: expect.objectContaining({
          text: "Checking.",
          purpose: "commentary",
          blockFinal: true,
        }),
      }),
    );
    const first = fixture.emit.mock.calls[0]![0];
    fixture.output.enqueueSpeechChunk(
      "Checking.",
      utterance,
      undefined,
      undefined,
      undefined,
      "commentary",
    );
    const second = fixture.emit.mock.calls[1]![0];
    expect(first.itemId).not.toBe(second.itemId);
    fixture.output.finalizeSpeechUtterance(utterance, "Finished.");
    expect(fixture.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "output.text.done",
        payload: { sessionId: "prefetch-test", text: "Finished." },
      }),
    );
    await fixture.output.drain();
  });

  it("does not publish commentary for an obsolete output generation", async () => {
    const fixture = createFixture(
      async () => completeResult(),
      async () => undefined,
    );
    const utterance = fixture.output.createSpeechUtterance();
    await fixture.cancel();
    fixture.output.enqueueSpeechChunk(
      "Stale.",
      utterance,
      undefined,
      undefined,
      undefined,
      "commentary",
    );
    expect(fixture.emit).not.toHaveBeenCalled();
  });
  it("retains drain custody when audio finishes before native pending metadata is produced", async () => {
    const fixture = createFixture(
      async () => completeResult(),
      async () => undefined,
    );
    const utterance = fixture.output.createSpeechUtterance();
    const receipt = fixture.output.finalizeSpeechUtterance(utterance, "A final answer.", {
      reserveSettlement: true,
    })!;
    const settlement = createDeferred();
    let drained = false;
    const drain = fixture.output.drain().then(() => {
      drained = true;
    });
    try {
      expect(await receipt.completion).toEqual(["A final answer."]);
      // One event-loop checkpoint allows an unreserved, already-resolved drain
      // to finish. No wall-clock race or arbitrary timeout is used.
      await setImmediate();
      expect(drained).toBe(false);
      receipt.trackSettlement(settlement.promise);
      receipt.releaseSettlement();
      await setImmediate();
      expect(drained).toBe(false);
    } finally {
      receipt.releaseSettlement();
      settlement.resolve();
      await drain;
    }
    expect(drained).toBe(true);
  });

  it("withholds the exact utterance receipt until paced writes and owned settlements drain", async () => {
    const gate = createDeferred();
    const written = createDeferred();
    const settlement = createDeferred();
    const fixture = createFixture(
      async () => completeResult(),
      async () => {
        written.resolve();
        await gate.promise;
      },
    );
    const utterance = fixture.output.createSpeechUtterance();
    fixture.output.enqueueSpeechChunk("Actually synthesized.", utterance);
    const receipt = fixture.output.finalizeSpeechUtterance(utterance, "A different final text.")!;
    const completed = vi.fn();
    void receipt.completion.then(completed);
    receipt.trackSettlement(settlement.promise);
    let drained = false;
    const drain = fixture.output.drain().then(() => {
      drained = true;
    });
    try {
      await written.promise;
      expect(completed).not.toHaveBeenCalled();
      gate.resolve();
      expect(await receipt.completion).toEqual(["Actually synthesized."]);
      expect(drained).toBe(false);
    } finally {
      gate.resolve();
      settlement.resolve();
      await drain;
    }
    expect(drained).toBe(true);
  });

  it.each(["write-failure", "barge-in", "session-close", "empty-audio"] as const)(
    "does not acknowledge failed, partial or closed output: %s",
    async (variant) => {
      const gate = createDeferred();
      const written = createDeferred();
      const fixture = createFixture(
        async () =>
          completeResult(variant === "empty-audio" ? Buffer.alloc(0) : Buffer.alloc(4_800)),
        async () => {
          written.resolve();
          await gate.promise;
          if (variant === "write-failure") {
            throw new Error("Synthetic sink failure");
          }
        },
      );
      const utterance = fixture.output.createSpeechUtterance();
      fixture.output.enqueueSpeechChunk("Unconfirmed output.", utterance);
      const receipt = fixture.output.finalizeSpeechUtterance(utterance, "Unconfirmed output.")!;
      try {
        if (variant !== "empty-audio") {
          await written.promise;
          if (variant === "barge-in") {
            await fixture.cancel();
          }
          if (variant === "session-close") {
            fixture.close();
          }
        }
      } finally {
        gate.resolve();
        await fixture.output.drain();
      }
      expect(await receipt.completion).toBeUndefined();
    },
  );

  it("announces an intra-result gap and drains waiting music before resumed PCM", async () => {
    const firstWritten = createDeferred();
    const gapStarted = createDeferred();
    const drainStarted = createDeferred();
    const musicDrained = createDeferred();
    const sourceReady = createDeferred<ReadableStreamDefaultController<Uint8Array>>();
    const write = vi.fn(async () => {
      firstWritten.resolve();
    });
    const fixture = createFixture(
      async () => ({
        success: true,
        sampleRate: 24_000,
        outputFormat: "pcm",
        audioStream: new ReadableStream<Uint8Array>(
          {
            start(controller) {
              sourceReady.resolve(controller);
            },
          },
          { highWaterMark: 0 },
        ),
      }),
      write,
    );
    fixture.waitingIdle.mockImplementation(() => {
      if (write.mock.calls.length > 0) {
        gapStarted.resolve();
      }
    });
    fixture.output.enqueueSpeechChunk(
      "A block with a synthesis gap.",
      fixture.output.createSpeechUtterance(1),
    );
    const source = await sourceReady.promise;
    let sourceClosed = false;
    try {
      source.enqueue(Buffer.alloc(4_800));
      await firstWritten.promise;
      await gapStarted.promise;
      fixture.waitingStop.mockImplementationOnce(async () => {
        drainStarted.resolve();
        await musicDrained.promise;
      });
      source.enqueue(Buffer.alloc(4_800));
      source.close();
      sourceClosed = true;
      await drainStarted.promise;
      expect(write).toHaveBeenCalledOnce();
    } finally {
      if (!sourceClosed) {
        source.close();
      }
      musicDrained.resolve();
      await fixture.output.drain();
    }
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("prepares two successors while the first sink write is paced, without admitting a fourth result", async () => {
    const firstWrite = createDeferred();
    const threePrepared = createDeferred();
    const thirdAudioRead = createDeferred();
    const writeStarted = createDeferred();
    let count = 0;
    const synthesize = vi.fn(async () => {
      count += 1;
      if (count === 3) {
        threePrepared.resolve();
        return {
          ...completeResult(),
          audioStream: new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                controller.enqueue(Buffer.alloc(4_800));
                controller.close();
                thirdAudioRead.resolve();
              },
            },
            { highWaterMark: 0 },
          ),
        };
      }
      return completeResult();
    });
    const write = vi.fn(async () => {
      writeStarted.resolve();
      await firstWrite.promise;
    });
    const fixture = createFixture(synthesize, write);
    const utterance = fixture.output.createSpeechUtterance();
    for (const text of ["First block.", "Second block.", "Third block.", "Fourth block."]) {
      fixture.output.enqueueSpeechChunk(text, utterance);
    }
    try {
      await writeStarted.promise;
      await threePrepared.promise;
      await thirdAudioRead.promise;
      expect(synthesize).toHaveBeenCalledTimes(3);
      expect(write).toHaveBeenCalledOnce();
      expect(fixture.onSpeechCaption).toHaveBeenCalledExactlyOnceWith({
        role: "assistant",
        text: "First block.",
      });
      expect(fixture.transcripts.map((entry) => entry.audioDelivery)).toEqual([
        "started",
        "unplayed",
        "unplayed",
        "unplayed",
      ]);
    } finally {
      firstWrite.resolve();
      await fixture.output.drain();
    }
    expect(synthesize).toHaveBeenCalledTimes(4);
    expect(write).toHaveBeenCalledTimes(4);
    expect(fixture.onSpeechCaption.mock.calls.map(([caption]) => caption.text)).toEqual([
      "First block.",
      "Second block.",
      "Third block.",
      "Fourth block.",
    ]);
    expect(fixture.activeTtsAborts.size).toBe(0);
    expect(fixture.activeTtsReaders.size).toBe(0);
  });

  it("reads ahead inside one result and drops its queued audio when interrupted", async () => {
    const firstWrite = createDeferred();
    const writeStarted = createDeferred();
    const thirdRead = createDeferred();
    const release = vi.fn(async () => undefined);
    let pulls = 0;
    const result: TtsTelephonyStreamResult = {
      success: true,
      sampleRate: 24_000,
      outputFormat: "pcm",
      release,
      audioStream: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(Buffer.alloc(4_800, pulls));
            if (pulls === 3) {
              thirdRead.resolve();
              controller.close();
            }
          },
        },
        { highWaterMark: 0 },
      ),
    };
    const write = vi.fn(async () => {
      writeStarted.resolve();
      await firstWrite.promise;
    });
    const fixture = createFixture(async () => result, write);
    fixture.output.enqueueSpeechChunk(
      "An interrupted synthetic block.",
      fixture.output.createSpeechUtterance(),
    );
    try {
      await writeStarted.promise;
      await thirdRead.promise;
      expect(write).toHaveBeenCalledOnce();
      await fixture.cancel();
    } finally {
      firstWrite.resolve();
      await fixture.output.drain();
    }
    expect(write).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(fixture.transcripts[0]?.audioDelivery).toBe("interrupted");
    expect(fixture.onSpeechCaption).toHaveBeenCalledExactlyOnceWith({
      role: "assistant",
      text: "An interrupted synthetic block.",
    });
    expect(fixture.activeTtsAborts.size).toBe(0);
    expect(fixture.activeTtsReaders.size).toBe(0);
  });

  it("observes a prefetched failure only after earlier audio has reached the sink", async () => {
    const firstWrite = createDeferred();
    const secondPrepared = createDeferred();
    const writeStarted = createDeferred();
    let count = 0;
    const fixture = createFixture(
      async () => {
        count += 1;
        if (count === 2) {
          secondPrepared.resolve();
          throw new Error("Synthetic next-block failure");
        }
        return completeResult();
      },
      async () => {
        writeStarted.resolve();
        await firstWrite.promise;
      },
    );
    const utterance = fixture.output.createSpeechUtterance();
    fixture.output.enqueueSpeechChunk("A valid first block.", utterance);
    fixture.output.enqueueSpeechChunk("A failing next block.", utterance);
    try {
      await secondPrepared.promise;
      await writeStarted.promise;
      expect(fixture.warn).not.toHaveBeenCalled();
      expect(fixture.transcripts[0]?.audioDelivery).toBe("started");
    } finally {
      firstWrite.resolve();
      await fixture.output.drain();
    }
    expect(fixture.transcripts[0]?.audioDelivery).toBe("submitted");
    expect(fixture.warn).toHaveBeenCalledOnce();
  });
});
