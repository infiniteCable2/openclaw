import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaToolsConfig } from "../../../config/types.tools.js";
import type { ImageContent, UserMessage } from "../../../llm/types.js";
import type { MediaFact } from "../../../media/media-facts.js";
import { prepareHarnessContextMedia } from "../../harness/context-media-runtime.js";
import type { AgentMessage } from "../../runtime/index.js";
import { hydratePromptMediaMessages, materializeProviderContext } from "./images.js";

const fixtures = vi.hoisted(() => ({
  png: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
    "base64",
  ),
  video: Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex"),
  load: vi.fn(),
  probe: vi.fn(),
  extract: vi.fn(),
}));
// mock-isolation: This routing fixture controls source reads without starting media fetch/codec workers.
vi.mock("../../../media/web-media.js", () => ({ loadWebMedia: fixtures.load }));
// mock-isolation: File/PDF parsing is outside frame ownership and would bootstrap unrelated parser workers.
vi.mock("../../../media-understanding/file-context.js", () => ({
  prepareFileContextFromMedia: vi.fn(async () => ({ images: [], text: undefined })),
}));
// mock-isolation: Extraction safety has its own suite; routing observes supplied frames without spawning FFmpeg.
vi.mock("../../../media/video-frames.js", () => ({
  probeVideoBuffer: fixtures.probe,
  buildVideoOverviewTimestamps: (_duration: number, count: number) =>
    Array.from({ length: count }, (_, index) => index + 1),
  extractVideoFrames: fixtures.extract,
}));
// mock-isolation: Image sanitation is independently tested; preserve image identity without compiling native codec workers.
vi.mock("../../tool-images.js", () => ({
  sanitizeImageBlocks: async (images: ImageContent[]) => ({ images, dropped: 0 }),
}));

const mediaConfig: MediaToolsConfig = { video: { frames: { enabled: true, maxFrames: 3 } } };
const options = { workspaceDir: "/workspace", model: { input: ["text", "image"] }, mediaConfig };
function message(media: MediaFact[], text = "inspect"): UserMessage {
  const user: UserMessage = { role: "user", content: text, timestamp: 1 };
  return Object.assign(user, { __openclaw: { media } });
}

function userMessages(messages: AgentMessage[]): UserMessage[] {
  return messages.map((entry) => {
    if (entry.role !== "user") {
      throw new Error("Video hydration must preserve the fixture's user-message role");
    }
    return entry;
  });
}
const video: MediaFact = { kind: "video", contentType: "video/mp4", path: "/workspace/clip.mp4" };

describe("prepared-model video frame hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixtures.load.mockResolvedValue({
      kind: "video",
      contentType: "video/mp4",
      buffer: fixtures.video,
    });
    fixtures.probe.mockResolvedValue({ durationSeconds: 10, width: 1, height: 1, hasAudio: true });
    fixtures.extract.mockImplementation(
      async ({ timestampsSeconds }: { timestampsSeconds: number[] }) =>
        timestampsSeconds.map((timestampSeconds) => ({
          timestampSeconds,
          buffer: fixtures.png,
          mimeType: "image/png",
          width: 1,
          height: 1,
        })),
    );
  });

  it("uses true images with timestamps without rewriting the source and reuses them at provider handoff", async () => {
    const original = message([video]);
    const serialized = JSON.stringify(original);
    const hydrated = userMessages(await hydratePromptMediaMessages([original], options));
    const content = hydrated[0]?.content;
    expect(Array.isArray(content) && content.filter((part) => part.type === "image")).toHaveLength(
      3,
    );
    expect(JSON.stringify(content)).toContain("frame at 1.000s");
    expect(JSON.stringify(original)).toBe(serialized);
    expect(hydrated[0]).toMatchObject({
      __openclaw: { media: [video], mediaImageBlockFactIndexes: [0, 0, 0] },
    });
    const provider = await materializeProviderContext({
      ...options,
      context: { messages: hydrated },
    });
    expect(fixtures.extract).toHaveBeenCalledTimes(1);
    expect(provider.messages[0]?.content).toEqual(content);
    expect(provider.messages[0]).not.toHaveProperty("__openclaw");
  });

  it("uses native video only when the actual prepared model accepts it", async () => {
    const provider = await materializeProviderContext({
      ...options,
      model: { input: ["text", "image", "video"] },
      context: { messages: [message([video])] },
    });
    expect(provider.messages[0]?.content).toContainEqual({
      type: "video",
      data: fixtures.video.toString("base64"),
      mimeType: "video/mp4",
    });
    expect(fixtures.probe).not.toHaveBeenCalled();
    expect(fixtures.extract).not.toHaveBeenCalled();
  });

  it("does no decode for disabled conversion or a text-only prepared model", async () => {
    for (const overrides of [{ mediaConfig: {} }, { model: { input: ["text"] } }]) {
      const result = await hydratePromptMediaMessages([message([video])], {
        ...options,
        ...overrides,
      });
      expect(JSON.stringify(result)).toContain("provider does not support native video");
    }
    expect(fixtures.load).not.toHaveBeenCalled();
  });

  it.each([
    { fact: { ...video, hydrationSuppressed: true }, config: mediaConfig },
    { fact: { ...video, purpose: "recording" as const }, config: mediaConfig },
    { fact: { ...video, purpose: "relay" as const }, config: mediaConfig },
    { fact: video, config: { video: { enabled: false, frames: { enabled: true } } } },
    {
      fact: video,
      config: { video: { frames: { enabled: true }, scope: { default: "deny" as const } } },
    },
    {
      fact: video,
      config: {
        video: {
          frames: { enabled: true },
          scope: {
            rules: [
              { action: "deny" as const, match: { channel: "matrix", keyPrefix: "agent:sample:" } },
            ],
          },
        },
      },
    },
  ])(
    "does not bypass attachment intent or native video policy ($fact.purpose)",
    async ({ fact, config }) => {
      const result = await materializeProviderContext({
        ...options,
        mediaConfig: config,
        channelId: "matrix",
        sessionKey: "agent:sample:room",
        context: { messages: [message([fact])] },
      });
      if (fact.purpose === "recording" || fact.purpose === "relay") {
        // Native fact classification leaves raw-purpose videos outside automatic media projection.
        expect(result.messages[0]?.content).toEqual([{ type: "text", text: "inspect" }]);
      } else {
        expect(JSON.stringify(result)).toContain("automatic processing is not permitted");
      }
      expect(fixtures.load).not.toHaveBeenCalled();
    },
  );

  it("bounds frames across attachments and never decodes historical videos automatically", async () => {
    const messages = [
      message([video], "old"),
      message([video, { ...video, path: "/workspace/second.mp4" }], "current"),
    ];
    const result = userMessages(await hydratePromptMediaMessages(messages, options));
    expect(JSON.stringify(result[0])).toContain("historical attachment");
    const content = result[1]?.content;
    expect(Array.isArray(content) && content.filter((part) => part.type === "image")).toHaveLength(
      3,
    );
    expect(JSON.stringify(content)).toContain("request frame limit reached");
    expect(fixtures.load).toHaveBeenCalledTimes(1);
    const provider = await materializeProviderContext({
      ...options,
      context: { messages: result },
    });
    expect(fixtures.load).toHaveBeenCalledTimes(1);
    expect(fixtures.extract).toHaveBeenCalledTimes(1);
    expect(provider.messages[1]?.content).toEqual(content);
  });

  it("reports extraction failure without claiming inspection or losing original facts", async () => {
    fixtures.probe.mockRejectedValueOnce(new Error("invalid video"));
    const original = message([video]);
    const result = await hydratePromptMediaMessages([original], options);
    expect(JSON.stringify(result)).toContain("extraction failed; do not claim visual inspection");
    expect(original).toMatchObject({ __openclaw: { media: [video] } });
  });

  it("fences an aborted decode before publishing images", async () => {
    const abort = new AbortController();
    fixtures.probe.mockImplementationOnce(async () => {
      abort.abort(new Error("closed"));
      return { durationSeconds: 10 };
    });
    await expect(
      hydratePromptMediaMessages([message([video])], { ...options, signal: abort.signal }),
    ).rejects.toThrow("closed");
    expect(fixtures.extract).not.toHaveBeenCalled();
  });

  it("supports explicit historical context inspection through the same bounded converter", async () => {
    const result = await prepareHarnessContextMedia({
      message: message([video]),
      config: { tools: { media: mediaConfig } },
      workspaceDir: "/workspace",
      modelInput: ["text", "image"],
      maxChars: 10_000,
      assertCurrent: () => {},
    });
    expect(result.images).toHaveLength(3);
    expect(result.text).toContain("frame at 1.000s");
    expect(fixtures.extract).toHaveBeenCalledTimes(1);
  });

  it("reuses hydrated historical context frames without duplicates or another source read", async () => {
    const [hydrated] = await hydratePromptMediaMessages([message([video])], options);
    if (!hydrated) {
      throw new Error("Expected hydrated video message");
    }
    const result = await prepareHarnessContextMedia({
      message: hydrated,
      config: { tools: { media: mediaConfig } },
      workspaceDir: "/workspace",
      modelInput: ["text", "image"],
      maxChars: 10_000,
      assertCurrent: () => {},
    });
    expect(result.images).toHaveLength(3);
    expect(result.text).toContain("frame at 1.000s");
    expect(fixtures.load).toHaveBeenCalledTimes(1);
    expect(fixtures.probe).toHaveBeenCalledTimes(1);
    expect(fixtures.extract).toHaveBeenCalledTimes(1);
  });
});
