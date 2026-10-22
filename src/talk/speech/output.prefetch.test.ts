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
  const transcripts: { role: string; text: string; audioDelivery?: string }[] = [];
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
    finishOutputAudio: vi.fn(),
    endTurn: vi.fn(),
    emit: vi.fn(),
  } as unknown as ReturnType<OutputParams["getHarness"]>;
  const activeTtsAborts: OutputParams["activeTtsAborts"] = new Set();
  const activeTtsReaders: OutputParams["activeTtsReaders"] = new Set();
  const warn = vi.fn();
  const waitingStop = vi.fn(async (): Promise<void> => undefined);
  const waitingIdle = vi.fn((_turn: number) => undefined);
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
    getHarness: () => harness,
    isStopped: () => stopped,
    getOutputGeneration: () => generation,
    getWaitingTurn: () => undefined,
    finishWaitingTurn: vi.fn(),
    waitForInput: async () => undefined,
    waiting: {
      generation: 0,
      stop: waitingStop,
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
    warn,
    transcripts,
    activeTtsAborts,
    activeTtsReaders,
    waitingStop,
    waitingIdle,
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

function completeResult(audio = Buffer.alloc(4_800), release = vi.fn(async () => undefined)) {
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
