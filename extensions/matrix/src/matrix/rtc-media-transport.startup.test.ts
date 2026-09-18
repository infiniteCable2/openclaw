import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  lstat: vi.fn(),
  mkdtemp: vi.fn(),
  chmod: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({
  lstat: mocks.lstat,
  mkdtemp: mocks.mkdtemp,
  chmod: mocks.chmod,
  rm: mocks.rm,
}));

import { createMatrixRtcMediaTransport } from "./rtc-media-transport.js";

describe("MatrixRTC media bridge startup", () => {
  it("handles asynchronous spawn errors before socket discovery and removes startup state", async () => {
    const tempDir = path.join(os.tmpdir(), "openclaw-matrix-rtc-startup-test");
    mocks.mkdtemp.mockResolvedValue(tempDir);
    mocks.lstat
      .mockResolvedValueOnce({
        isFile: () => true,
        isSymbolicLink: () => false,
        mode: 0o700,
      })
      .mockRejectedValue(Object.assign(new Error("No socket"), { code: "ENOENT" }));
    const child = Object.assign(new EventEmitter(), {
      stdout: { pause: vi.fn() },
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill: vi.fn(),
    });
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn EACCES")));
      return child;
    });

    await expect(
      createMatrixRtcMediaTransport({
        command: path.join(tempDir, "bridge"),
        url: "wss://rtc.example.test",
        token: "test-token",
        allowedRemoteIdentity: "caller",
        initialKeys: [],
      }),
    ).rejects.toThrow(/aborted|failed to start/);

    expect(child.kill).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledExactlyOnceWith(tempDir, { recursive: true, force: true });
  });
});
