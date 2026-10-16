import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { saveInspectedVideoFrames } from "./video-inspect-save.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const frame = {
  buffer: Buffer.from("received-image"),
  mimeType: "image/png" as const,
  width: 1,
  height: 1,
};

describe("explicit video frame artifacts", () => {
  it("keeps exact bytes in unique workspace files independently of live-buffer expiry", async () => {
    const workspaceDir = tempDirs.make("openclaw-frame-save-");
    const files = await saveInspectedVideoFrames({
      frames: [frame, frame],
      workspaceDir,
      assertCurrent() {},
    });
    expect(files).toHaveLength(2);
    expect(files[0]!.path).not.toBe(files[1]!.path);
    for (const file of files) {
      expect(path.dirname(file.path)).toBe(path.join(workspaceDir, "media/video-frames"));
      expect(await fs.readFile(file.path)).toEqual(frame.buffer);
      expect(file.sizeBytes).toBe(frame.buffer.length);
    }
  });

  it("uses the sandbox namespace and refuses missing exclusive-write support", async () => {
    const workspaceDir = tempDirs.make("openclaw-frame-sandbox-");
    const bridge = createHostSandboxFsBridge(workspaceDir);
    const files = await saveInspectedVideoFrames({
      frames: [frame],
      sandbox: { root: workspaceDir, bridge },
      assertCurrent() {},
    });
    expect(files[0]!.path).toMatch(/^\/workspace\/media\/video-frames\//);
    expect(await bridge.readFile({ filePath: files[0]!.path })).toEqual(frame.buffer);
    await expect(
      saveInspectedVideoFrames({
        frames: [frame],
        sandbox: { root: workspaceDir, bridge: { ...bridge, createFileExclusive: undefined } },
        assertCurrent() {},
      }),
    ).rejects.toThrow("exclusively create");
  });

  it("does not overwrite a destination or ignore a sandbox write denial", async () => {
    const workspaceDir = tempDirs.make("openclaw-frame-denied-");
    const bridge = createHostSandboxFsBridge(workspaceDir);
    const create = vi.fn().mockResolvedValue("exists");
    await expect(
      saveInspectedVideoFrames({
        frames: [frame],
        sandbox: { root: workspaceDir, bridge: { ...bridge, createFileExclusive: create } },
        assertCurrent() {},
      }),
    ).rejects.toThrow("no file was replaced");
    create.mockRejectedValueOnce(new Error("read-only mount"));
    await expect(
      saveInspectedVideoFrames({
        frames: [frame],
        sandbox: { root: workspaceDir, bridge: { ...bridge, createFileExclusive: create } },
        assertCurrent() {},
      }),
    ).rejects.toThrow("read-only mount");
  });

  it("rejects cancelled or revoked saves before writing and reports completed files on partial failure", async () => {
    const workspaceDir = tempDirs.make("openclaw-frame-revoked-");
    const controller = new AbortController();
    controller.abort();
    await expect(
      saveInspectedVideoFrames({
        frames: [frame],
        workspaceDir,
        signal: controller.signal,
        assertCurrent() {},
      }),
    ).rejects.toThrow();
    expect(await fs.readdir(workspaceDir)).toEqual([]);
    const bridge = createHostSandboxFsBridge(workspaceDir);
    let active = true;
    const create = bridge.createFileExclusive!;
    await expect(
      saveInspectedVideoFrames({
        frames: [frame, frame],
        sandbox: {
          root: workspaceDir,
          bridge: {
            ...bridge,
            createFileExclusive: async (params) => {
              const result = await create(params);
              active = false;
              return result;
            },
          },
        },
        assertCurrent() {
          if (!active) {
            throw new Error("run closed");
          }
        },
      }),
    ).rejects.toThrow("Already saved workspace files");
    expect(await fs.readdir(path.join(workspaceDir, "media/video-frames"))).toHaveLength(1);
  });
});
