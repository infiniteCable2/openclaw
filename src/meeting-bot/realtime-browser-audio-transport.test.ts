import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { MeetingBrowserRequestParams } from "./platform-adapter-contract.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import { createBrowserMeetingRealtimeAudioTransport } from "./realtime-browser-audio-transport.js";

function setup() {
  let nativeInput: ((audio: Buffer) => void) | undefined;
  const nativeTransport = {
    onFatal: vi.fn(),
    startInput: vi.fn<MeetingRealtimeAudioTransport["startInput"]>((handler) => {
      nativeInput = handler;
    }),
    stop: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    writeOutput: vi.fn(async () => {}),
    clearOutput: vi.fn(async () => {}),
  } satisfies MeetingRealtimeAudioTransport;
  const pulls: ReturnType<typeof createDeferredCore<Record<string, unknown>>>[] = [];
  const actions: string[] = [];
  const callBrowser = vi.fn(async (request: MeetingBrowserRequestParams) => {
    const body = request.body as { fn: string };
    const { action, captureId } = JSON.parse(body.fn) as { action: string; captureId: string };
    actions.push(action);
    if (action === "pull") {
      const pending = createDeferredCore<Record<string, unknown>>();
      pulls.push(pending);
      return { result: JSON.stringify({ captureId, ...(await pending.promise) }) };
    }
    return {
      result: JSON.stringify({
        captureId,
        isolated: action === "start",
        closed: action === "stop",
      }),
    };
  });
  return {
    resolvePull(result: Record<string, unknown>) {
      const pending = pulls.shift();
      if (!pending) {
        throw new Error("Browser audio pull was not requested");
      }
      pending.resolve(result);
    },
    nativeTransport,
    callBrowser,
    actions,
    nativeInput: (audio: Buffer) => nativeInput?.(audio),
    create: () =>
      createBrowserMeetingRealtimeAudioTransport({
        nativeTransport,
        hasConfiguredInputCommand: false,
        callBrowser,
        buildCaptureScript: JSON.stringify,
        meetingSessionId: "session-1",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        targetId: "tab-1",
        audioFormat: "pcm16-24khz",
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
  };
}

describe("isolated meeting browser audio transport", () => {
  afterEach(() => vi.useRealTimers());

  it("feeds remote playback to the provider while native microphone injection stays out", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const transport = await fixture.create();
    const received = vi.fn();
    await transport.startInput(received);
    await setImmediate();
    const assistant = Buffer.from([1, 0, 2, 0]);
    const remote = Buffer.from([3, 0, 4, 0]);
    await transport.writeOutput(assistant);
    fixture.nativeInput(assistant);
    fixture.resolvePull({ isolated: true, base64: remote.toString("base64") });
    await setImmediate();
    expect(received.mock.calls).toEqual([[remote]]);
    expect(fixture.nativeTransport.writeOutput).toHaveBeenCalledWith(assistant);
    expect(transport.inputAudioIsolated).toBe(true);
    await transport.stop();
  });

  it("discards a pull after stop and rejects an expired browser capture", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const transport = await fixture.create();
    const received = vi.fn();
    const fatal = vi.fn();
    transport.onFatal(fatal);
    await transport.startInput(received);
    await setImmediate();
    // Browser evaluations are serialized, so stop retires the host immediately while
    // waiting for the in-flight page read to leave the tab lock.
    const stopping = transport.stop();
    fixture.resolvePull({ isolated: true, base64: Buffer.from([9, 0]).toString("base64") });
    await stopping;
    expect(received).not.toHaveBeenCalled();
    expect(fatal).not.toHaveBeenCalled();

    const next = setup();
    const nextTransport = await next.create();
    nextTransport.onFatal(fatal);
    await nextTransport.startInput(received);
    await setImmediate();
    next.resolvePull({ closed: true });
    await setImmediate();
    expect(fatal).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
    expect(next.nativeTransport.stop).toHaveBeenCalledOnce();
    await nextTransport.stop();
  });

  it("reports an asynchronous native input startup failure to its fatal owner", async () => {
    const fixture = setup();
    const failure = new Error("native capture startup failed");
    fixture.nativeTransport.startInput.mockImplementationOnce(async () => {
      throw failure;
    });
    const transport = await fixture.create();
    const fatal = vi.fn();
    const received = vi.fn();
    transport.onFatal(fatal);

    await expect(transport.startInput(received)).rejects.toBe(failure);
    expect(fatal).toHaveBeenCalledOnce();
    await transport.stop();
    expect(fixture.nativeTransport.stop).toHaveBeenCalledOnce();
    expect(fixture.actions).toEqual(["start", "stop"]);
    expect(received).not.toHaveBeenCalled();
  });

  it("does not start browser pulls when native capture settles after stop", async () => {
    const fixture = setup();
    const startup = createDeferredCore();
    fixture.nativeTransport.startInput.mockReturnValueOnce(startup.promise);
    const transport = await fixture.create();
    const received = vi.fn();
    const starting = transport.startInput(received);

    expect(fixture.callBrowser).toHaveBeenCalledOnce();
    await transport.stop();
    startup.resolve();
    await starting;
    expect(fixture.actions).toEqual(["start", "stop"]);
    expect(received).not.toHaveBeenCalled();
  });
});
