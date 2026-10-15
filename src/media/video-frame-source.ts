import type { BufferedVideoFrame } from "./video-frame-buffer.js";

export type VideoFrameSource = {
  assertCurrent(): void;
  read(id: string): BufferedVideoFrame | undefined;
};
const admittedSources = new WeakSet<object>();

/** Host-only live media capability. A model/tool argument cannot manufacture a source binding. */
export function createVideoFrameSource(
  read: VideoFrameSource["read"],
  assertCurrent: VideoFrameSource["assertCurrent"],
): VideoFrameSource {
  const source: VideoFrameSource = Object.freeze({
    assertCurrent,
    read(id: string) {
      assertCurrent();
      return read(id);
    },
  });
  admittedSources.add(source);
  return source;
}

export function isVideoFrameSource(value: unknown): value is VideoFrameSource {
  return typeof value === "object" && value !== null && admittedSources.has(value);
}
