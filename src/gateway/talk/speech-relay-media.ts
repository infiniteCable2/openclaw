import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import { readImageProbeFromHeader } from "rastermill";
import {
  TALK_RELAY_VIDEO_MAX_FRAME_BYTES,
  type TalkSessionMediaParams,
  type TalkSessionMediaResult,
} from "../../../packages/gateway-protocol/src/schema/channels.js";
import type { SpeechVideoConfig } from "../../config/zod-schema.media-frames.js";
import type { SpeechVideoFrame } from "../../talk/speech/transport.js";

type Availability = { generation: number; available: boolean };

/** A connection-scoped transport adapter. The speech session owns admitted frames. */
export function createTalkRelayMedia(video: SpeechVideoConfig | undefined) {
  const videoInput = video?.enabled
    ? {
        maxFrameBytes: Math.min(
          TALK_RELAY_VIDEO_MAX_FRAME_BYTES,
          video.maxSourceBytes ?? Infinity,
          video.maxBufferBytes ?? Infinity,
        ),
        maxDimension: video.maxSourceDimension ?? 1_920,
        minIntervalMs: video.intervalMs ?? 1_000,
        leaseMs: Math.max(5_000, 3 * (video.intervalMs ?? 1_000)),
      }
    : undefined;
  const availability: Record<"video" | "audio" | "text", Availability> = {
    video: { generation: 0, available: false },
    audio: { generation: 0, available: true },
    text: { generation: 0, available: true },
  };
  let audioOutput = new AbortController();
  let onFrame: ((frame: SpeechVideoFrame) => void) | undefined;
  let lastFrameAt = -Infinity;
  let expiresAt = -Infinity;
  let lease: ReturnType<typeof setTimeout> | undefined;
  const stopVideo = () => {
    clearTimeout(lease);
    lease = undefined;
    availability.video.available = false;
    expiresAt = -Infinity;
  };
  const report = (status: TalkSessionMediaResult["status"]): TalkSessionMediaResult => ({
    ok: true,
    status,
    available: {
      videoInput: availability.video.available,
      audioOutput: availability.audio.available,
      textOutput: availability.text.available,
    },
  });
  return {
    contract: { ...(videoInput ? { videoInput } : {}), audioOutput: true, textOutput: true },
    startVideoInput(receive: (frame: SpeechVideoFrame) => void) {
      onFrame = receive;
    },
    audioOutputSignal: () => audioOutput.signal,
    textOutputAvailable: () => availability.text.available,
    receive(input: TalkSessionMediaParams, clearAudio: () => void) {
      const now = performance.now();
      if (availability.video.available && now >= expiresAt) {
        stopVideo();
      }
      if (input.type === "availability") {
        const state = availability[input.medium];
        if (input.medium === "video" && (!videoInput || !onFrame)) {
          throw new Error("Talk video input was not negotiated for this session");
        }
        if (input.generation <= state.generation) {
          return report(
            input.generation === state.generation && input.available === state.available
              ? "applied"
              : "stale",
          );
        }
        state.generation = input.generation;
        const changed = state.available !== input.available;
        if (input.medium === "video" && videoInput) {
          stopVideo();
          state.available = input.available;
          if (state.available) {
            expiresAt = now + videoInput.leaseMs;
            lease = setTimeout(stopVideo, videoInput.leaseMs);
            lease.unref();
          }
        } else {
          state.available = input.available;
          if (input.medium === "audio" && changed) {
            if (state.available) {
              audioOutput = new AbortController();
            } else {
              audioOutput.abort();
              clearAudio();
            }
          }
        }
        return report("applied");
      }
      if (!videoInput || !onFrame) {
        throw new Error("Talk video input was not negotiated for this session");
      }
      if (!availability.video.available || input.generation !== availability.video.generation) {
        return report("stale");
      }
      if (now - lastFrameAt < videoInput.minIntervalMs) {
        return report("throttled");
      }
      if (input.imageBase64.length > 4 * Math.ceil(videoInput.maxFrameBytes / 3)) {
        throw new Error("Talk video frame exceeds the negotiated byte limit");
      }
      const canonical = canonicalizeBase64(input.imageBase64);
      const data = canonical === input.imageBase64 ? Buffer.from(canonical, "base64") : undefined;
      const probe =
        data && data.length <= videoInput.maxFrameBytes
          ? readImageProbeFromHeader(data)
          : undefined;
      if (
        !data ||
        probe?.format !== "jpeg" ||
        Math.max(probe.width, probe.height) > videoInput.maxDimension
      ) {
        throw new Error("Talk video frame is not a bounded JPEG");
      }
      lastFrameAt = now;
      expiresAt = now + videoInput.leaseMs;
      lease?.refresh();
      onFrame({
        data,
        mimeType: input.mimeType,
        timestampMs: Date.now(),
        sourceId: "relay-camera",
      });
      return report("applied");
    },
    close() {
      stopVideo();
      audioOutput.abort();
      onFrame = undefined;
    },
  };
}
