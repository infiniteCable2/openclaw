import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { applyMediaUnderstanding } from "./apply.js";
import { transcribeFirstAudio } from "./audio-preflight.js";
import { createMediaAttachmentCache, normalizeMediaAttachments, runCapability } from "./runner.js";
import { createSafeAudioFixtureBuffer } from "./runner.test-utils.js";
import type { AudioTranscriptionRequest } from "./types.js";

vi.mock("../agents/model-auth.js", async (importOriginal) => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return {
    ...(await importOriginal<typeof import("../agents/model-auth.js")>()),
    ...createAvailableModelAuthMockModule(),
  };
});
vi.mock("../plugins/capability-provider-runtime.js", async (importOriginal) => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return {
    ...(await importOriginal<typeof import("../plugins/capability-provider-runtime.js")>()),
    ...createEmptyCapabilityProviderMockModule(),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cfg: OpenClawConfig = {
  tools: {
    media: {
      models: [{ provider: "openai", model: "fixture", capabilities: ["audio"] }],
    },
  },
};

describe("canonical media purpose at native processing boundaries", () => {
  it.each([
    { purpose: undefined, enhanced: true, processed: true },
    { purpose: "communication" as const, enhanced: true, processed: true },
    { purpose: "analysis" as const, enhanced: false, processed: true },
    { purpose: "recording" as const, enhanced: false, processed: false },
    { purpose: "relay" as const, enhanced: false, processed: false },
  ])(
    "applies $purpose audio intent without rewriting originals",
    async ({ purpose, enhanced, processed }) => {
      const workspaceDir = tempDirs.make("openclaw-media-purpose-");
      const audioPath = path.join(workspaceDir, "original.wav");
      const bytes = createSafeAudioFixtureBuffer();
      await fs.writeFile(audioPath, bytes);
      const ctx: MsgContext = {
        Body: "original instruction",
        media: [
          {
            path: audioPath,
            contentType: "audio/wav",
            ...(purpose === undefined ? {} : { purpose }),
            speechInput: true,
            voiceMessage: true,
          },
        ],
      };
      const originalFacts = structuredClone(ctx.media);
      const transcribeAudio = vi.fn(async (_request: AudioTranscriptionRequest) => ({
        text: "recognized words",
        model: "fixture",
      }));
      await withEnvAsync({ PATH: "" }, () =>
        applyMediaUnderstanding({
          ctx,
          cfg,
          workspaceDir,
          providers: { openai: { id: "openai", capabilities: ["audio"], transcribeAudio } },
        }),
      );
      expect(transcribeAudio).toHaveBeenCalledTimes(processed ? 1 : 0);
      if (processed) {
        expect(transcribeAudio.mock.calls[0]?.[0].speechInput === true).toBe(enhanced);
        expect(ctx.Transcript).toContain("recognized words");
      } else {
        expect(ctx.Transcript).toBeUndefined();
        expect(ctx.MediaUnderstanding).toBeUndefined();
        expect(ctx.Body).toBe("original instruction");
      }
      expect(ctx.media?.[0]).toMatchObject(originalFacts![0]!);
      if (purpose === undefined) {
        expect(ctx.media?.[0]).not.toHaveProperty("purpose");
      }
      expect(await fs.readFile(audioPath)).toEqual(bytes);
    },
  );

  it.each(["recording", "relay"] as const)(
    "does not resolve providers or read %s inputs at the runner boundary",
    async (purpose) => {
      const media = normalizeMediaAttachments({
        media: [{ path: "/missing/input.wav", contentType: "audio/wav", purpose }],
      });
      const cache = createMediaAttachmentCache(media);
      const getBuffer = vi.spyOn(cache, "getBuffer");
      const providerRegistry = vi.fn(() => {
        throw new Error("raw input must not resolve a provider");
      });
      try {
        const result = await runCapability({
          capability: "audio",
          cfg,
          ctx: {},
          media,
          attachments: cache,
          providerRegistry,
        });
        expect(result.outputs).toEqual([]);
        expect(result.decision.outcome).toBe("no-attachment");
        expect(providerRegistry).not.toHaveBeenCalled();
        expect(getBuffer).not.toHaveBeenCalled();
      } finally {
        await cache.cleanup();
      }
    },
  );

  it.each(["recording", "relay"] as const)(
    "does not extract or describe %s documents, images, or videos",
    async (purpose) => {
      const ctx: MsgContext = {
        Body: "keep originals",
        media: [
          { path: "/missing/input.txt", contentType: "text/plain", purpose },
          { path: "/missing/input.png", contentType: "image/png", purpose },
          { path: "/missing/input.mp4", contentType: "video/mp4", purpose },
        ],
      };
      const result = await applyMediaUnderstanding({ ctx, cfg });
      expect(result.extractedFileImages).toEqual([]);
      expect(ctx.Body).toBe("keep originals");
      expect(ctx.MediaUnderstanding).toBeUndefined();
    },
  );

  it("preflight skips raw audio and marks only the original conversational fact", async () => {
    const workspaceDir = tempDirs.make("openclaw-purpose-preflight-");
    const audioPath = path.join(workspaceDir, "original.wav");
    await fs.writeFile(audioPath, createSafeAudioFixtureBuffer());
    const ctx: MsgContext = {
      media: [
        {
          path: "/missing/relay.wav",
          contentType: "audio/wav",
          purpose: "relay" as const,
          voiceMessage: true,
        },
        {
          path: audioPath,
          contentType: "audio/wav",
          purpose: "communication" as const,
          workspaceDir,
        },
      ],
    };
    const transcribeAudio = vi.fn(async (_request: AudioTranscriptionRequest) => ({
      text: "hello agent",
    }));
    const transcript = await withEnvAsync({ PATH: "" }, () =>
      transcribeFirstAudio({
        ctx,
        cfg,
        providers: {
          openai: { id: "openai", capabilities: ["audio"], transcribeAudio },
        },
      }),
    );
    expect(transcript).toBe("hello agent");
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(transcribeAudio.mock.calls[0]?.[0].speechInput).toBe(true);
    expect(ctx.media?.[0]).toMatchObject({
      path: "/missing/relay.wav",
      purpose: "relay",
      transcribed: false,
    });
    expect(ctx.media?.[1]).toMatchObject({
      path: audioPath,
      purpose: "communication",
      transcribed: true,
    });
  });
});
