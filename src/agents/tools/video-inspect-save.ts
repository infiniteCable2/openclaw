import { randomUUID } from "node:crypto";
import path from "node:path";
import { root } from "@openclaw/fs-safe/root";
import type { RenderedVideoFrame } from "../../media/video-frames.js";
import { ToolInputError } from "./common.js";
import type { MediaToolSandbox } from "./media-tool-shared.js";

/** Explicit user artifacts, not entries in the expiring live-frame/media cache. */
export async function saveInspectedVideoFrames(params: {
  frames: readonly RenderedVideoFrame[];
  workspaceDir?: string;
  sandbox?: MediaToolSandbox;
  signal?: AbortSignal;
  assertCurrent: () => void;
}) {
  const workspace = params.sandbox?.root ?? params.workspaceDir;
  if (!workspace) {
    throw new ToolInputError("Saving video frames requires an assigned workspace");
  }
  const bridge = params.sandbox?.bridge;
  if (bridge && !bridge.createFileExclusive) {
    throw new ToolInputError("This sandbox cannot exclusively create saved frame files");
  }
  const fsRoot = bridge ? undefined : await root(workspace);
  const files: Array<{ path: string; mimeType: string; sizeBytes: number }> = [];
  // A fixed directory and generated basenames avoid granting arbitrary write destinations.
  try {
    for (const frame of params.frames) {
      params.assertCurrent();
      params.signal?.throwIfAborted();
      const relativePath = `media/video-frames/${randomUUID()}.${frame.mimeType === "image/png" ? "png" : "jpg"}`;
      let outputPath: string;
      if (bridge) {
        const target = bridge.resolvePath({ filePath: relativePath, cwd: workspace });
        const pinned = await bridge.resolvePinnedMutationTarget?.({
          filePath: target.containerPath,
          cwd: workspace,
          action: "create",
          signal: params.signal,
        });
        params.assertCurrent();
        const outcome = await bridge.createFileExclusive!({
          filePath: target.containerPath,
          cwd: workspace,
          data: frame.buffer,
          mkdir: true,
          pinnedPath: pinned?.pinnedPath,
          signal: params.signal,
        });
        if (outcome !== "created") {
          throw new ToolInputError("Saved frame destination already exists; no file was replaced");
        }
        outputPath = target.containerPath;
      } else {
        await fsRoot!.create(relativePath, frame.buffer, {
          atomic: true,
          mkdir: true,
          mode: 0o600,
          mutationSymlinks: "reject",
          assertBeforeMutation: () => {
            params.assertCurrent();
            params.signal?.throwIfAborted();
          },
        });
        outputPath = path.join(workspace, relativePath);
      }
      // A completed artifact is preserved even if a later write or result publication fails.
      files.push({ path: outputPath, mimeType: frame.mimeType, sizeBytes: frame.buffer.length });
      params.assertCurrent();
    }
  } catch (error) {
    if (files.length) {
      throw new Error(
        `Frame save did not complete. Already saved workspace files: ${JSON.stringify(files)}`,
        { cause: error },
      );
    }
    throw error;
  }
  return files;
}
