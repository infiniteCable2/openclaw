import { afterEach, expect, it, vi } from "vitest";
import { createSpeechVideoInput } from "../../talk/speech/video-input.js";
import { createTalkRelayMedia } from "./speech-relay-media.js";

const jpeg = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffc00011080001000103012200021101031101ffd9",
  "hex",
);

afterEach(() => vi.useRealTimers());

it("stops accepting a disabled or expired source while keeping already admitted frames", async () => {
  vi.useFakeTimers();
  const profile = { enabled: true, retentionMs: 30_000 };
  const transport = createTalkRelayMedia(profile);
  const video = createSpeechVideoInput(profile);
  const noop = () => {};
  await video.start(
    {
      ...transport,
      onFatal: noop,
      startInput: noop,
      stop: async () => {},
      dispose: async () => {},
      writeOutput: async () => {},
      clearOutput: async () => {},
    },
    noop,
  );
  const preview = (generation: number) =>
    transport.receive(
      {
        type: "videoFrame",
        sessionId: "synthetic",
        generation,
        imageBase64: jpeg.toString("base64"),
        mimeType: "image/jpeg",
      },
      noop,
    );
  const camera = (generation: number, available: boolean) =>
    transport.receive(
      {
        type: "availability",
        direction: "input",
        medium: "video",
        sessionId: "synthetic",
        generation,
        available,
      },
      noop,
    );
  const capturedAt = Date.now();
  expect(preview(1).status).toBe("stale");
  expect(camera(1, true).status).toBe("applied");
  expect(preview(1).status).toBe("applied");
  expect(preview(1).status).toBe("throttled");
  const visible = video.capture(capturedAt, capturedAt);
  expect(visible?.frames[0]?.data).toEqual(jpeg);
  expect(camera(2, false).available.videoInput).toBe(false);
  expect(preview(1).status).toBe("stale");
  expect(video.source?.read(visible!.frames[0].id)?.data).toEqual(jpeg);
  expect(camera(3, true).status).toBe("applied");
  vi.advanceTimersByTime(5_001);
  expect(preview(3).status).toBe("stale");
  expect(camera(3, true).status).toBe("stale");
  expect(camera(4, true).status).toBe("applied");
  expect(preview(4).status).toBe("applied");
  expect(video.capture(capturedAt, Date.now())?.frames).toHaveLength(2);
  video.close();
  transport.close();
});
