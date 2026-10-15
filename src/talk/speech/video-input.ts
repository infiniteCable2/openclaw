import type { SpeechVideoConfig } from "../../config/zod-schema.media-frames.js";
import type { ImageContent } from "../../llm/types.js";
import { createVideoFrameBuffer, type VideoFrameSnapshot } from "../../media/video-frame-buffer.js";
import { createVideoFrameSource } from "../../media/video-frame-source.js";
import type { SpeechAudioTransport } from "./transport.js";

/** Video capture and source custody belong to this speech session, not a channel or agent loop. */
export function createSpeechVideoInput(config: SpeechVideoConfig | undefined) {
  const buffer = config?.enabled
    ? createVideoFrameBuffer({
        intervalMs: config.intervalMs ?? 1000,
        retentionMs: config.retentionMs ?? 30_000,
        maxBytes: config.maxBufferBytes ?? 32 * 1024 * 1024,
        maxFrameBytes: config.maxSourceBytes ?? 16 * 1024 * 1024,
        maxFramesPerTurn: config.maxFramesPerTurn ?? 3,
        selectedRetentionMs: config.selectedRetentionMs ?? 15 * 60_000,
      })
    : undefined;
  const snapshots = new Map<unknown, VideoFrameSnapshot>();
  const controller = new AbortController();
  const onsets = new Map<string, { startedAtMs: number; anchor?: VideoFrameSnapshot }>();
  const mergeKey = Symbol("speech-video-input");
  let closed = false;
  const source = buffer
    ? createVideoFrameSource(
        (id) => buffer.read(id),
        () => {
          if (closed) {
            throw new Error("Live video source is closed");
          }
        },
      )
    : undefined;
  return {
    source,
    async start(transport: SpeechAudioTransport, assertCurrent: () => void) {
      if (!buffer) {
        return;
      }
      assertCurrent();
      if (!transport.startVideoInput) {
        throw new Error("This transport does not support configured video input");
      }
      await transport.startVideoInput((frame) => {
        if (!closed && buffer.add(frame)) {
          for (const onset of onsets.values()) {
            if (!onset.anchor && frame.timestampMs >= onset.startedAtMs) {
              onset.anchor = buffer.capture(frame.timestampMs, frame.timestampMs);
            }
          }
        }
      });
      assertCurrent();
    },
    begin(id: string, startedAtMs: number) {
      if (!buffer || closed || onsets.has(id)) {
        return;
      }
      if (onsets.size >= 32) {
        throw new Error("Too many unsettled video utterances");
      }
      const anchor = buffer.capture(startedAtMs - (config?.intervalMs ?? 1000), startedAtMs);
      onsets.set(id, { startedAtMs, ...(anchor.frames.length ? { anchor } : {}) });
      if (!anchor.frames.length) {
        anchor.release();
      }
    },
    settle(id: string | undefined) {
      if (!id) {
        return;
      }
      onsets.get(id)?.anchor?.release();
      onsets.delete(id);
    },
    capture(
      startMs: number,
      endMs = Date.now(),
      utteranceId?: string,
    ): VideoFrameSnapshot | undefined {
      if (!buffer || closed) {
        return undefined;
      }
      const captured = buffer.capture(startMs, endMs);
      const anchor = utteranceId ? onsets.get(utteranceId)?.anchor : undefined;
      if (utteranceId) {
        onsets.delete(utteranceId);
      }
      const candidates = [...(anchor?.frames ?? []), ...captured.frames]
        .filter((frame, index, all) => all.findIndex((other) => other.id === frame.id) === index)
        .toSorted((left, right) => left.timestampMs - right.timestampMs);
      const count = Math.min(config?.maxFramesPerTurn ?? 3, candidates.length);
      const frames = Array.from(
        { length: count },
        (_, index) =>
          candidates[
            count === 1
              ? candidates.length - 1
              : Math.round((index * (candidates.length - 1)) / (count - 1))
          ],
      );
      if (!frames.length) {
        captured.release();
        anchor?.release();
        return undefined;
      }
      const snapshot: VideoFrameSnapshot = {
        frames,
        release() {
          snapshots.delete(snapshot);
          captured.release();
          anchor?.release();
        },
      };
      snapshots.set(snapshot, snapshot);
      return snapshot;
    },
    resolve(value: unknown) {
      return snapshots.get(value);
    },
    mergeKey(value: unknown) {
      return buffer && (value === undefined || snapshots.has(value)) ? mergeKey : undefined;
    },
    merge(left: unknown, right: unknown): VideoFrameSnapshot | undefined {
      const first = snapshots.get(left);
      const second = snapshots.get(right);
      if (left === undefined) {
        return second;
      }
      if (right === undefined) {
        return first;
      }
      if (!first || !second) {
        throw new Error("Video input merge requires current snapshots");
      }
      if (first === second) {
        return first;
      }
      const candidates = [...first.frames, ...second.frames]
        .filter((frame, index, all) => all.findIndex((other) => other.id === frame.id) === index)
        .toSorted((a, b) => a.timestampMs - b.timestampMs);
      const count = Math.min(config?.maxFramesPerTurn ?? 3, candidates.length);
      const frames = Array.from(
        { length: count },
        (_, index) =>
          candidates[
            count === 1
              ? candidates.length - 1
              : Math.round((index * (candidates.length - 1)) / (count - 1))
          ],
      );
      const merged: VideoFrameSnapshot = {
        frames,
        release() {
          snapshots.delete(merged);
          first.release();
          second.release();
        },
      };
      snapshots.delete(first);
      snapshots.delete(second);
      snapshots.set(merged, merged);
      return merged;
    },
    async prepare(
      snapshot: VideoFrameSnapshot | undefined,
      signal?: AbortSignal,
    ): Promise<{ images: ImageContent[]; context?: string }> {
      if (!snapshot) {
        return { images: [] };
      }
      const activeSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      const assertCurrent = () => {
        activeSignal.throwIfAborted();
        if (closed || !snapshots.has(snapshot)) {
          throw new Error("Video input snapshot is no longer active");
        }
      };
      assertCurrent();
      const images: ImageContent[] = [];
      const deliveredIds: string[] = [];
      let unavailable = 0;
      for (const frame of snapshot.frames) {
        assertCurrent();
        try {
          const { renderVideoFrameBuffer } = await import("../../media/video-frames.js");
          assertCurrent();
          const result = await renderVideoFrameBuffer({
            buffer: frame.data,
            ...config?.preview,
            signal: activeSignal,
          });
          assertCurrent();
          images.push({
            type: "image",
            mimeType: result.mimeType,
            data: result.buffer.toString("base64"),
          });
          deliveredIds.push(frame.id);
        } catch {
          // Optional visual conversion must not discard the user's accepted spoken request.
          // Cancellation/closure still invalidates the entire input rather than hiding it.
          assertCurrent();
          unavailable++;
        }
      }
      return {
        images,
        context:
          "Video frames captured during this user utterance, in attachment order: " +
          snapshot.frames
            .map((frame) => `${frame.id} at ${new Date(frame.timestampMs).toISOString()}`)
            .join("; ") +
          ". These are sampled views, not continuous video coverage. " +
          `Attached image order: ${deliveredIds.join(", ") || "none"}. ` +
          (unavailable
            ? `${unavailable} frame preview(s) unavailable. Do not claim inspection of missing previews. `
            : "") +
          "If video_inspect is available, request frameId with profile detail or source to revisit that exact retained source; expired frames are unavailable.",
      };
    },
    close() {
      closed = true;
      controller.abort();
      for (const onset of onsets.values()) {
        onset.anchor?.release();
      }
      onsets.clear();
      for (const snapshot of snapshots.values()) {
        snapshot.release();
      }
      buffer?.close();
    },
  };
}
