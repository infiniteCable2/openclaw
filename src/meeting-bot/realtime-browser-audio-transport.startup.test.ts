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
