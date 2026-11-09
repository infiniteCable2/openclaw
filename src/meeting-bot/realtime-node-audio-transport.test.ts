import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createNodeMeetingRealtimeAudioTransport } from "./realtime-node-audio-transport.js";

function createTransport(
  invoke: ReturnType<typeof vi.fn>,
  options: { outputGenerationSupported?: boolean; initialOutputGeneration?: number } = {},
) {
  const transport = createNodeMeetingRealtimeAudioTransport({
    runtime: { nodes: { invoke } } as never,
    nodeId: "node-1",
    bridgeId: "bridge-1",
    logger: { warn: vi.fn(), debug: vi.fn() } as never,
    commandName: "meeting.chrome",
    logScope: "[meeting]",
    logPrefix: "node",
    ...(options.initialOutputGeneration !== undefined
      ? { initialOutputGeneration: options.initialOutputGeneration }
      : {}),
  });
  if (options.outputGenerationSupported !== undefined) {
    Reflect.set(
      transport,
      Symbol.for("openclaw.internal.meeting-node-output-generation.v1"),
      options.outputGenerationSupported,
    );
  }
  return transport;
}

function expectCommand(invoke: ReturnType<typeof vi.fn>, nth: number, params: object) {
  expect(invoke).toHaveBeenNthCalledWith(nth, expect.objectContaining({ params }));
}

function blockedOutput(stopReleases = false) {
  const started = createDeferredCore();
  const released = createDeferredCore();
  const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
    if (params.action === "pushAudio") {
      started.resolve();
      await released.promise;
    } else if (stopReleases && params.action === "stop") {
      released.resolve();
    }
    return { ok: true };
  });
  return { invoke, started, released };
}

describe("node meeting realtime audio transport", () => {
  afterEach(() => vi.useRealTimers());

  it.each([false, true])("handles malformed input (persistent errors=%s)", async (fatal) => {
    vi.useFakeTimers();
    let pullCount = 0;
    const idlePull = createDeferredCore<object>();
    const audio = Buffer.from([5, 4, 3]);
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (params.action !== "pullAudio") {
        idlePull.resolve({});
        return { ok: true };
      }
      pullCount += 1;
      if (fatal || pullCount === 1) {
        return { base64: "not-base64!" };
      }
      if (pullCount === 2) {
        return { base64: audio.toString("base64") };
      }
      return idlePull.promise;
    });
    const transport = createTransport(invoke);
    const onFatal = vi.fn();
    const onAudio = vi.fn();
    transport.onFatal(onFatal);
    await transport.startInput(onAudio);
    await vi.advanceTimersByTimeAsync(fatal ? 1_000 : 250);
    await vi.waitFor(() => expect(fatal ? onFatal : onAudio).toHaveBeenCalledOnce());
    if (fatal) {
      expect(onAudio).not.toHaveBeenCalled();
    } else {
      expect(onAudio).toHaveBeenCalledWith(audio);
    }
    expect(transport.getHealth?.()).toMatchObject({
      consecutiveInputErrors: fatal ? 5 : 0,
      lastInputError: fatal ? "pullAudio base64 must be a valid audio payload" : undefined,
    });

    await transport.stop();
  });

  it("cannot verify stopped output from a pending input pull", async () => {
    const pendingPull = createDeferredCore<{ base64: string }>();
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) =>
      params.action === "pullAudio" ? pendingPull.promise : {},
    );
    const transport = createTransport(invoke);
    const output = Buffer.alloc(80 * 240 * 2);
    for (let sample = 0; sample < output.byteLength / 2; sample += 1) {
      const amplitude = 400 + ((Math.floor(sample / 240) * 7919) % 12_000);
      output.writeInt16LE(sample % 2 === 0 ? amplitude : -amplitude, sample * 2);
    }
    await transport.writeOutput(output);
    const health = transport.getHealth?.();
    const onAudio = vi.fn();
    await transport.startInput(onAudio);
    await transport.stop();
    pendingPull.resolve({ base64: output.toString("base64") });
    await setImmediate();

    expect(transport.getHealth?.()).toEqual(health);
    expect(onAudio).not.toHaveBeenCalled();
  });

  it.each([
    ["serializes legacy clear", false, "clear"],
    ["clears generation-aware output immediately", true, "clear"],
    ["stops legacy output without waiting", false, "stop"],
  ] as const)("%s", async (_label, generations, action) => {
    const { invoke, started, released } = blockedOutput(action === "stop");
    const transport = createTransport(invoke, { outputGenerationSupported: generations });
    const pushing = transport.writeOutput(Buffer.from([1, 2, 3]));
    const clearing = generations ? undefined : transport.clearOutput();
    await withTestTimeout(started.promise, 1_000, "output push did not start");
    if (generations) {
      expectCommand(
        invoke,
        1,
        expect.objectContaining({ action: "pushAudio", outputGeneration: 0 }),
      );
      await transport.clearOutput();
      expectCommand(invoke, 2, { action: "clearAudio", bridgeId: "bridge-1", outputGeneration: 1 });
    } else {
      // A queued legacy clear must remain blocked until the push settles.
      await setImmediate();
      expect(invoke).toHaveBeenCalledTimes(1);
      if (action === "clear") {
        expectCommand(invoke, 1, {
          action: "pushAudio",
          bridgeId: "bridge-1",
          base64: Buffer.from([1, 2, 3]).toString("base64"),
        });
      } else {
        await transport.stop();
      }
    }
    released.resolve();
    await Promise.all([pushing, clearing]);
    if (generations) {
      await transport.writeOutput(Buffer.from([4, 5, 6]));
      expectCommand(
        invoke,
        3,
        expect.objectContaining({ action: "pushAudio", outputGeneration: 1 }),
      );
    }
    if (!generations) {
      if (action === "clear") {
        expectCommand(invoke, 2, { action: "clearAudio", bridgeId: "bridge-1" });
      } else {
        expect(invoke.mock.calls.map(([call]) => call.params.action)).toEqual([
          "pushAudio",
          "stop",
        ]);
      }
    }
    await transport.stop();
    const invokeCountAfterStop = invoke.mock.calls.length;
    await transport.writeOutput(Buffer.from([7, 8, 9]));
    await transport.clearOutput();
    expect(invoke).toHaveBeenCalledTimes(invokeCountAfterStop);
  });

  it("starts fenced output at the generation returned by the node", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const transport = createTransport(invoke, { initialOutputGeneration: 7 });

    await transport.writeOutput(Buffer.from([1, 2]));
    await transport.clearOutput();
    await transport.writeOutput(Buffer.from([3, 4]));

    expect(invoke.mock.calls).toMatchObject([
      [{ params: { outputGeneration: 7 } }],
      [{ params: { outputGeneration: 8 } }],
      [{ params: { outputGeneration: 8 } }],
    ]);
    await transport.stop();
  });

  it("sends long PCM output in bounded node RPCs", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const transport = createTransport(invoke, { initialOutputGeneration: 1 });

    await transport.writeOutput(Buffer.alloc(60_000));

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls).toMatchObject(
      [24_000, 24_000, 12_000].map((size) => [
        { params: { action: "pushAudio", base64: Buffer.alloc(size).toString("base64") } },
      ]),
    );
    await transport.stop();
  });

  it("does not submit later chunks after a fenced clear", async () => {
    let releasePush: (() => void) | undefined;
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (params.action === "pushAudio") {
        await new Promise<void>((resolve) => {
          releasePush = resolve;
        });
      }
      return { ok: true };
    });
    const transport = createTransport(invoke, { initialOutputGeneration: 1 });

    const pushing = transport.writeOutput(Buffer.alloc(60_000));
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(1);
    });
    await transport.clearOutput();
    releasePush?.();
    await pushing;

    expect(invoke.mock.calls.filter(([call]) => call.params.action === "pushAudio")).toHaveLength(
      1,
    );
    await transport.stop();
  });

  it.each([
    { shape: "direct", result: { dropped: true } },
    { shape: "payload", result: { ok: true, payload: { dropped: true } } },
    { shape: "payload-stale", result: { ok: true, payload: { stale: true } } },
    { shape: "payloadJSON", result: { ok: true, payloadJSON: '{"dropped":true}' } },
  ])("fails a current-generation output rejected through $shape", async ({ result }) => {
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) =>
      params.action === "pushAudio" ? result : { ok: true },
    );
    const transport = createTransport(invoke, { initialOutputGeneration: 1 });

    await expect(transport.writeOutput(Buffer.alloc(48_000))).rejects.toThrow(
      "node rejected current audio output generation",
    );
    expect(invoke.mock.calls.filter(([call]) => call.params.action === "pushAudio")).toHaveLength(
      1,
    );
    await transport.stop();
  });

  it("serializes output commands for legacy node hosts", async () => {
    const pushStarted = createDeferredCore();
    let releasePush: (() => void) | undefined;
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (params.action === "pushAudio") {
        await new Promise<void>((resolve) => {
          releasePush = resolve;
          pushStarted.resolve();
        });
      }
      return { ok: true };
    });
    const transport = createTransport(invoke);

    const pushing = transport.writeOutput(Buffer.from([1, 2, 3]));
    const clearing = transport.clearOutput();
    await withTestTimeout(pushStarted.promise, 1_000, "legacy output push did not start");
    // Give an incorrectly unblocked clear a turn while pushAudio is still blocked.
    await setImmediate();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        params: {
          action: "pushAudio",
          bridgeId: "bridge-1",
          base64: Buffer.from([1, 2, 3]).toString("base64"),
        },
      }),
    );

    releasePush?.();
    await Promise.all([pushing, clearing]);
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: {
          action: "clearAudio",
          bridgeId: "bridge-1",
        },
      }),
    );

    await transport.stop();
  });

  it("clears immediately when the node host supports output generations", async () => {
    let releasePush: (() => void) | undefined;
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (params.action === "pushAudio") {
        await new Promise<void>((resolve) => {
          releasePush = resolve;
        });
      }
      return { ok: true };
    });
    const transport = createTransport(invoke, { outputGenerationSupported: true });

    const pushing = transport.writeOutput(Buffer.from([1, 2, 3]));
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(1);
    });
    await transport.clearOutput();
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: {
          action: "clearAudio",
          bridgeId: "bridge-1",
          outputGeneration: 1,
        },
      }),
    );

    releasePush?.();
    await pushing;
    await transport.stop();
  });

  it("stops a legacy node host without waiting for blocked output", async () => {
    const pushStarted = createDeferredCore();
    let releasePush: (() => void) | undefined;
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (params.action === "pushAudio") {
        await new Promise<void>((resolve) => {
          releasePush = resolve;
          pushStarted.resolve();
        });
      } else if (params.action === "stop") {
        releasePush?.();
      }
      return { ok: true };
    });
    const transport = createTransport(invoke);

    const pushing = transport.writeOutput(Buffer.from([1, 2, 3]));
    const clearing = transport.clearOutput();
    await withTestTimeout(pushStarted.promise, 1_000, "legacy output push did not start");
    // Give an incorrectly unblocked clear a turn while pushAudio is still blocked.
    await setImmediate();
    expect(invoke).toHaveBeenCalledTimes(1);
    await transport.stop();
    await Promise.all([pushing, clearing]);

    expect(invoke.mock.calls.map(([call]) => call.params.action)).toEqual(["pushAudio", "stop"]);
  });
});
