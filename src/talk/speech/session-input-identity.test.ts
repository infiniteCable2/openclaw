import { expect, it, vi } from "vitest";
import { createSpeechInputMetadata } from "./session-input-identity.js";
import { createSpeechVideoInput } from "./video-input.js";

it("keeps repeated local utterance identities stable within the actual host session", () => {
  const metadata = createSpeechInputMetadata(createSpeechVideoInput(undefined), "connection-one");
  const first = metadata.read(metadata.capture(1_000, "utterance-one")).input.inputId;
  expect(metadata.read(metadata.capture(1_000, "utterance-one")).input.inputId).toBe(first);
  expect(metadata.read(metadata.capture(1_000, "utterance-two")).input.inputId).not.toBe(first);
});

it("does not deduplicate legitimate reused provider utterance IDs across calls", () => {
  const first = createSpeechInputMetadata(createSpeechVideoInput(undefined), "connection-one");
  const second = createSpeechInputMetadata(createSpeechVideoInput(undefined), "connection-two");
  expect(first.read(first.capture(1_000, "utterance-one")).input.inputId).not.toBe(
    second.read(second.capture(1_000, "utterance-one")).input.inputId,
  );
  const left = createSpeechInputMetadata(createSpeechVideoInput(undefined), "connection:one");
  const right = createSpeechInputMetadata(createSpeechVideoInput(undefined), "connection");
  expect(left.read(left.capture(1_000, "two")).input.inputId).not.toBe(
    right.read(right.capture(1_000, "one:two")).input.inputId,
  );
});

it("mints a fresh native input nonce when the provider supplies no utterance ID", () => {
  const metadata = createSpeechInputMetadata(createSpeechVideoInput(undefined), "connection-one");
  expect(metadata.read(metadata.capture(1_000, undefined)).input.inputId).not.toBe(
    metadata.read(metadata.capture(1_000, undefined)).input.inputId,
  );
});

it("retains the provider's local ID unchanged for the actual video/onset owner", () => {
  const video = createSpeechVideoInput(undefined);
  const capture = vi.spyOn(video, "capture");
  const metadata = createSpeechInputMetadata(video, "connection-one");
  metadata.capture(1_000, "local-utterance");
  expect(capture).toHaveBeenCalledExactlyOnceWith(1_000, expect.any(Number), "local-utterance");
});
