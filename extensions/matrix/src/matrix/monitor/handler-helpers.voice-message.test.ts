import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isMatrixVoiceMessageContent } from "./handler-helpers.js";

describe("isMatrixVoiceMessageContent", () => {
  it.each([
    { marker: undefined, expected: false },
    { marker: null, expected: false },
    { marker: "voice", expected: false },
    { marker: [], expected: false },
    { marker: {}, expected: true },
  ])("classifies an audio event with marker $marker", ({ marker, expected }) => {
    assert.equal(
      isMatrixVoiceMessageContent({
        msgtype: "m.audio",
        body: "recording.ogg",
        "org.matrix.msc3245.voice": marker,
      }),
      expected,
    );
  });

  it("does not classify a non-audio event as a voice message", () => {
    assert.equal(
      isMatrixVoiceMessageContent({
        msgtype: "m.text",
        body: "A caption",
        "org.matrix.msc3245.voice": {},
      }),
      false,
    );
  });
});
