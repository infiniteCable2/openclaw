import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createVideoFrameSource } from "../../media/video-frame-source.js";
import { createSandboxFsBridgeFromResolver } from "../test-helpers/host-sandbox-fs-bridge.js";
import { createVideoInspectTool } from "./video-inspect-tool.js";

const fixture = vi.hoisted(() => ({
  png: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
    "base64",
  ),
  video: Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex"),
  load: vi.fn(),
  probe: vi.fn(),
  extract: vi.fn(),
  render: vi.fn(),
  capture: vi.fn(),
  invocationCurrent: vi.fn(),
}));
// mock-isolation: Inject invocation revocation directly without booting a Gateway or touching operator state.
vi.mock("../../gateway/operator-invocation-authority.js", () => ({
  captureAmbientGatewayOperatorAuthority: fixture.capture,
}));
// mock-isolation: Keep channel plugin discovery outside this fixture; real shared root/sandbox policy still runs.
vi.mock("../../media/channel-inbound-roots.js", () => ({
  resolveChannelInboundAttachmentRootsForChannel: () => ["/fixture/inbound"],
}));
// mock-isolation: Observe the native access-owner's bounded read options without fetching or decoding media.
vi.mock("../../media/web-media.js", () => ({ loadWebMedia: fixture.load }));
// mock-isolation: This tool adapter checks native image result shape, not the independently tested codec worker.
vi.mock("../tool-images.js", () => ({
  sanitizeContentBlocksImages: async (blocks: unknown[]) => blocks,
}));
// mock-isolation: Extraction/process limits are tested at their owner; inject deterministic frames and metadata here.
vi.mock("../../media/video-frames.js", () => ({
  MAX_VIDEO_FRAME_COUNT: 12,
  MAX_VIDEO_FRAME_SOURCE_BYTES: 100 * 1024 * 1024,
  probeVideoBuffer: fixture.probe,
  extractVideoFrames: fixture.extract,
  renderVideoFrameBuffer: fixture.render,
  buildVideoOverviewTimestamps: (_duration: number, count: number) =>
    Array.from({ length: count }, (_, index) => index + 0.5),
}));
const config: OpenClawConfig = {
  tools: { media: { video: { frames: { enabled: true, maxFrames: 3, profile: "preview" } } } },
};
const options = { config, modelHasVision: true, workspaceDir: path.resolve("/fixture/workspace") };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function tool(overrides: Partial<Parameters<typeof createVideoInspectTool>[0]> = {}) {
  const created = createVideoInspectTool({ ...options, ...overrides });
  if (!created) {
    throw new Error("Expected enabled test tool");
  }
  return created;
}

describe("native video_inspect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.capture.mockResolvedValue({ assertInvocationCurrent: fixture.invocationCurrent });
    fixture.load.mockResolvedValue({
      kind: "video",
      contentType: "video/mp4",
      buffer: fixture.video,
    });
    fixture.probe.mockResolvedValue({
      container: "mov",
      durationSeconds: 10,
      width: 1920,
      height: 1080,
      hasAudio: true,
    });
    fixture.extract.mockImplementation(
      async ({ timestampsSeconds }: { timestampsSeconds: number[] }) =>
        timestampsSeconds.map((timestampSeconds) => ({
          buffer: fixture.png,
          mimeType: "image/png",
          timestampSeconds,
          width: 1,
          height: 1,
        })),
    );
    fixture.render.mockResolvedValue({
      buffer: fixture.png,
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
  });

  it("is opt-in and only available to the actual vision model under native scope", () => {
    expect(createVideoInspectTool({ ...options, modelHasVision: false })).toBeNull();
    expect(createVideoInspectTool({ ...options, config: {} })).toBeNull();
    expect(
      createVideoInspectTool({
        ...options,
        config: { tools: { media: { video: { enabled: false, frames: { enabled: true } } } } },
      }),
    ).toBeNull();
    expect(
      createVideoInspectTool({
        ...options,
        config: {
          tools: { media: { video: { frames: { enabled: true }, scope: { default: "deny" } } } },
        },
      }),
    ).toBeNull();
    expect(
      createVideoInspectTool({
        ...options,
        config: {},
        toolBindings: { video_inspect: { read: () => undefined, assertCurrent() {} } },
      }),
    ).toBeNull();
  });

  it("returns truthful metadata without synthesizing an image or second model call", async () => {
    const result = await tool().execute("info", { path: "clip.mp4" });
    expect(result.details).toMatchObject({
      durationSeconds: 10,
      hasAudio: true,
      media: { outbound: false },
    });
    expect(result.content.every((part) => part.type === "text")).toBe(true);
    expect(fixture.extract).not.toHaveBeenCalled();
    expect(fixture.load).toHaveBeenCalledWith(
      path.resolve(options.workspaceDir, "clip.mp4"),
      expect.objectContaining({
        maxBytes: 100 * 1024 * 1024,
        localRoots: expect.arrayContaining([options.workspaceDir]),
      }),
    );
  });

  it("returns actual image blocks, exact timestamps and source-profile overrides without base64 text", async () => {
    const result = await tool().execute("frames", {
      action: "frames",
      path: "media://inbound/clip.mp4",
      timestampsSeconds: [1, 2],
      profile: "source",
    });
    expect(fixture.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        timestampsSeconds: [1, 2],
        profile: "source",
        buffer: fixture.video,
      }),
    );
    expect(result.content.filter((part) => part.type === "image")).toHaveLength(2);
    expect(
      result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" "),
    ).not.toContain(fixture.png.toString("base64"));
    expect(JSON.stringify(result.details)).not.toContain(fixture.png.toString("base64"));
    expect(result.details).toMatchObject({
      profile: "source",
      timestampsSeconds: [1, 2],
      source: "media://inbound/clip.mp4",
    });
  });

  it("uses configured overview defaults and explicitly adjustable detail rendition", async () => {
    await tool().execute("overview", {
      action: "overview",
      path: "clip.mp4",
      profile: "detail",
      targetBytes: 400_000,
      maxSide: 1600,
    });
    expect(fixture.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        timestampsSeconds: [0.5, 1.5, 2.5],
        profile: "detail",
        targetBytes: 400_000,
        maxSide: 1600,
      }),
    );
  });

  it.each([
    [],
    [-1],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [10],
    Array.from({ length: 13 }, () => 1),
  ])("rejects invalid or excessive timestamps %j", async (timestampsSeconds) => {
    await expect(
      tool().execute("bad", { action: "frames", path: "clip.mp4", timestampsSeconds }),
    ).rejects.toThrow("timestampsSeconds");
    expect(fixture.extract).not.toHaveBeenCalled();
  });

  it.each(["https://example.test/video.mp4", "data:video/mp4;base64,AAAA", "custom:video"])(
    'rejects remote or unsupported reference "%s" before any read',
    async (input) => {
      await expect(tool().execute("bad", { path: input })).rejects.toThrow("local path");
      expect(fixture.load).not.toHaveBeenCalled();
    },
  );

  it("propagates workspace-only sandbox reads and does not grant channel inbound roots", async () => {
    const bridge = createSandboxFsBridgeFromResolver((filePath) => ({
      containerPath: path.resolve(options.workspaceDir, filePath),
      relativePath: "clip.mp4",
    }));
    await tool({
      fsPolicy: { workspaceOnly: true, root: options.workspaceDir },
      sandbox: { root: options.workspaceDir, bridge },
      agentChannel: "matrix",
    }).execute("info", { path: "clip.mp4" });
    expect(fixture.load).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sandboxValidated: true, readFile: expect.any(Function) }),
    );
    expect(fixture.load.mock.calls[0]?.[1]).not.toHaveProperty("inboundRoots");
  });

  it("does not publish results after live authority is revoked during decoding", async () => {
    let active = true;
    fixture.probe.mockImplementationOnce(async () => {
      active = false;
      return { durationSeconds: 10 };
    });
    const assertInvocationCurrent = () => {
      if (!active) {
        throw new Error("run closed");
      }
    };
    await expect(
      tool({ assertInvocationCurrent }).execute("info", { path: "clip.mp4" }),
    ).rejects.toThrow("run closed");
    expect(fixture.extract).not.toHaveBeenCalled();
  });

  it("keeps a trusted live-frame source available without file extraction and never substitutes expired frames", async () => {
    const read = vi.fn((id: string) =>
      id === "retained"
        ? { id, timestampMs: 1234, data: fixture.png, mimeType: "image/png" as const }
        : undefined,
    );
    const assertCurrent = vi.fn();
    const live = tool({
      config: {},
      toolBindings: { video_inspect: createVideoFrameSource(read, assertCurrent) },
    });
    const result = await live.execute("live", {
      frameId: "retained",
      profile: "detail",
      maxSide: 1280,
    });
    expect(result.content.some((part) => part.type === "image")).toBe(true);
    expect(fixture.render).toHaveBeenCalledWith(
      expect.objectContaining({ buffer: fixture.png, profile: "detail", maxSide: 1280 }),
    );
    expect(fixture.load).not.toHaveBeenCalled();
    await expect(live.execute("expired", { frameId: "gone" })).rejects.toThrow(
      "unavailable or expired",
    );
    expect(read).toHaveBeenLastCalledWith("gone");
    expect(assertCurrent).toHaveBeenCalled();
    await expect(live.execute("file", { path: "clip.mp4" })).rejects.toThrow("not enabled");
  });

  it("saves selected source-quality file frames without adding images or base64 to context", async () => {
    const workspaceDir = tempDirs.make("openclaw-inspect-save-");
    const result = await tool({ workspaceDir }).execute("save", {
      action: "save",
      path: "clip.mp4",
      timestampsSeconds: [1],
    });
    expect(fixture.extract).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "source", timestampsSeconds: [1] }),
    );
    expect(result.content.every((part) => part.type === "text")).toBe(true);
    const details = result.details as { files: Array<{ path: string }> };
    expect(await fs.readFile(details.files[0]!.path)).toEqual(fixture.png);
    expect(result.details).toMatchObject({
      storage: "workspace",
      automaticExpiry: false,
      media: { outbound: false },
    });
  });

  it("exposes live retention and saves only the exact still-available frame", async () => {
    const workspaceDir = tempDirs.make("openclaw-inspect-live-save-");
    const retention = {
      checkedAtMs: 2000,
      expiresAtMs: 5000,
      remainingMs: 3000,
      pinned: false,
      afterReleaseMs: 3000,
    };
    const read = vi.fn((id: string) =>
      id === "retained"
        ? { id, timestampMs: 1000, data: fixture.png, mimeType: "image/png" as const, retention }
        : undefined,
    );
    const live = tool({
      workspaceDir,
      toolBindings: { video_inspect: createVideoFrameSource(read, () => {}) },
    });
    const info = await live.execute("info", { action: "info", frameId: "retained" });
    expect(info.details).toMatchObject({ retention });
    const result = await live.execute("save", { action: "save", frameId: "retained" });
    expect(fixture.render).toHaveBeenCalledWith(expect.objectContaining({ profile: "source" }));
    expect(result.details).toMatchObject({ frameId: "retained", automaticExpiry: false });
    await expect(live.execute("gone", { action: "save", frameId: "gone" })).rejects.toThrow(
      "unavailable or expired",
    );
    expect(await fs.readdir(path.join(workspaceDir, "media/video-frames"))).toHaveLength(1);
  });
});
