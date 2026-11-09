// Attachment path normalization tests cover file URL host checks and Windows
// network path rejection.
import { describe, expect, it } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  normalizeAttachmentPath,
  normalizeAttachments,
  resolveAttachmentKind,
} from "./attachments.normalize.js";
import { selectAttachments } from "./attachments.select.js";

describe("normalizeAttachmentPath", () => {
  it("rejects remote-host file URLs", () => {
    expect(normalizeAttachmentPath("file://attacker/share/photo.png")).toBeUndefined();
    expect(normalizeAttachmentPath("FILE://attacker/share/photo.png")).toBeUndefined();
  });

  it("rejects Windows network paths", () => {
    withMockedPlatform("win32", () => {
      expect(normalizeAttachmentPath("\\\\attacker\\share\\photo.png")).toBeUndefined();
    });
  });
});

describe("normalizeAttachments", () => {
  it("marks only conversational input, never ordinary audio or relay media", () => {
    const attachments = normalizeAttachments({
      media: [
        { path: "/tmp/voice.ogg", contentType: "audio/ogg", voiceMessage: true },
        { path: "/tmp/file.wav", contentType: "audio/wav", voiceMessage: false },
        { path: "/tmp/device.wav", contentType: "audio/wav", speechInput: true },
        { path: "/tmp/relay.wav", contentType: "audio/wav" },
        {
          path: "/tmp/explicit-voice.wav",
          contentType: "audio/wav",
          purpose: "communication",
          voiceMessage: false,
        },
        {
          path: "/tmp/analysis.wav",
          contentType: "audio/wav",
          purpose: "analysis",
          speechInput: true,
        },
        {
          path: "/tmp/raw-relay.wav",
          contentType: "audio/wav",
          purpose: "relay",
          voiceMessage: true,
        },
        {
          path: "/tmp/recording.wav",
          contentType: "audio/wav",
          purpose: "recording",
          speechInput: true,
        },
      ],
    });
    expect(attachments.map((entry) => entry.speechInput === true)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it("preserves original fact indexes when empty slots are not materializable", () => {
    expect(
      normalizeAttachments({
        media: [
          {},
          { path: "/tmp/voice.ogg", contentType: "audio/ogg" },
          { url: "https://example.test/photo.jpg", contentType: "image/jpeg" },
        ],
      }).map((attachment) => attachment.index),
    ).toEqual([1, 2]);
  });

  it("normalizes ordered facts", () => {
    expect(
      normalizeAttachments({
        media: [
          { path: " /tmp/voice.ogg ", contentType: " audio/ogg ", transcribed: true },
          { url: "https://example.test/photo.jpg", kind: "image" },
        ],
      }),
    ).toEqual([
      {
        path: "/tmp/voice.ogg",
        url: undefined,
        mime: "audio/ogg",
        kind: "audio",
        index: 0,
        alreadyTranscribed: true,
      },
      {
        path: undefined,
        url: "https://example.test/photo.jpg",
        mime: undefined,
        kind: "image",
        index: 1,
        alreadyTranscribed: false,
      },
    ]);
  });

  it("uses staged fact paths at the attachment consumer", () => {
    expect(
      normalizeAttachments({
        media: [
          {
            path: "/tmp/staged/voice.ogg",
            url: "/tmp/staged/voice.ogg",
            contentType: "audio/ogg",
            workspaceDir: "/tmp/staged",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        path: "/tmp/staged/voice.ogg",
        url: "/tmp/staged/voice.ogg",
        workspaceDir: "/tmp/staged",
      }),
    ]);
  });

  it.each([
    {
      name: "filename-only SVG",
      fact: { fileName: "diagram.svg", contentType: "application/octet-stream" },
    },
  ])("does not select $name for image understanding", ({ fact }) => {
    const attachments = normalizeAttachments({
      media: [{ url: "https://cdn.example.test/download/opaque", ...fact }],
    });

    expect(selectAttachments({ capability: "image", attachments }).selected).toEqual([]);
  });
});

describe("resolveAttachmentKind", () => {
  it("treats stickers as images despite conflicting MIME", () => {
    expect(
      resolveAttachmentKind({
        url: "https://cdn.example.test/sticker",
        kind: "sticker",
        mime: "audio/ogg",
        index: 0,
      }),
    ).toBe("image");
  });
});
