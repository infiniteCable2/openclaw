import { randomUUID } from "node:crypto";

export type BufferedVideoFrame = {
  id: string;
  data: Buffer;
  mimeType: "image/jpeg" | "image/png";
  timestampMs: number;
  sourceId?: string;
};
type Entry = BufferedVideoFrame & { pins: number; selectedUntilMs?: number };
export type VideoFrameSnapshot = {
  readonly frames: readonly BufferedVideoFrame[];
  release(): void;
};

/** Session-owned source bytes. Pins share the same budget; they cannot silently grow a second cache. */
export function createVideoFrameBuffer(params: {
  intervalMs: number;
  retentionMs: number;
  maxBytes: number;
  maxFrameBytes: number;
  maxFramesPerTurn: number;
  selectedRetentionMs?: number;
  now?: () => number;
}) {
  const now = params.now ?? Date.now;
  for (const value of [
    params.intervalMs,
    params.retentionMs,
    params.maxBytes,
    params.maxFrameBytes,
    params.maxFramesPerTurn,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Video frame buffer limits must be positive integers");
    }
  }
  const entries: Entry[] = [];
  let bytes = 0;
  let closed = false;
  const prune = (at: number) => {
    for (let index = entries.length - 1; index >= 0; index--) {
      const frame = entries[index];
      if (
        frame &&
        !frame.pins &&
        (frame.selectedUntilMs ?? frame.timestampMs + params.retentionMs) < at
      ) {
        bytes -= frame.data.length;
        entries.splice(index, 1);
      }
    }
  };
  const removeOldestUnpinned = () => {
    const index = entries.findIndex((entry) => entry.pins === 0);
    if (index < 0) {
      return false;
    }
    const [removed] = entries.splice(index, 1);
    if (!removed) {
      return false;
    }
    bytes -= removed.data.length;
    return true;
  };
  return {
    add(frame: Omit<BufferedVideoFrame, "id">): boolean {
      const at = now();
      prune(at);
      if (
        closed ||
        !Number.isFinite(frame.timestampMs) ||
        frame.timestampMs > at + 1000 ||
        frame.timestampMs < at - params.retentionMs ||
        frame.data.length === 0 ||
        frame.data.length > Math.min(params.maxFrameBytes, params.maxBytes)
      ) {
        return false;
      }
      const previous = entries.findLast((entry) => entry.sourceId === frame.sourceId);
      if (previous && frame.timestampMs - previous.timestampMs < params.intervalMs) {
        return false;
      }
      while (bytes + frame.data.length > params.maxBytes) {
        if (!removeOldestUnpinned()) {
          return false;
        }
      }
      const retained = { ...frame, id: randomUUID(), data: Buffer.from(frame.data), pins: 0 };
      entries.push(retained);
      bytes += retained.data.length;
      return true;
    },
    capture(startMs: number, endMs = now()): VideoFrameSnapshot {
      prune(now());
      const available = closed
        ? []
        : entries.filter((entry) => entry.timestampMs >= startMs && entry.timestampMs <= endMs);
      const count = Math.min(params.maxFramesPerTurn, available.length);
      // Spread across the utterance, retaining its beginning as well as its latest view.
      const chosen = Array.from(
        { length: count },
        (_, index) =>
          available[
            count === 1
              ? available.length - 1
              : Math.round((index * (available.length - 1)) / (count - 1))
          ],
      ).filter((frame): frame is Entry => frame !== undefined);
      for (const frame of chosen) {
        frame.pins++;
        frame.selectedUntilMs = now() + (params.selectedRetentionMs ?? params.retentionMs);
      }
      let released = false;
      return {
        frames: chosen,
        release() {
          if (released) {
            return;
          }
          released = true;
          for (const frame of chosen) {
            frame.pins--;
            if (params.selectedRetentionMs !== undefined) {
              frame.selectedUntilMs = now() + params.selectedRetentionMs;
            }
          }
          prune(now());
        },
      };
    },
    /** A detail request must use this session's exact retained identity, never a newer frame. */
    read(id: string): BufferedVideoFrame | undefined {
      prune(now());
      const entry = closed ? undefined : entries.find((frame) => frame.id === id);
      return entry ? { ...entry, data: Buffer.from(entry.data) } : undefined;
    },
    close() {
      closed = true;
      entries.length = 0;
      bytes = 0;
    },
    get sizeBytes() {
      return bytes;
    },
  };
}
