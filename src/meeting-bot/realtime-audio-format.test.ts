import { describe, expect, it } from "vitest";
import { createMeetingSttAudioConverter } from "./realtime-audio-format.js";

describe("meeting STT audio formats", () => {
  it("keeps legacy mu-law input unchanged", () => {
    const converter = createMeetingSttAudioConverter("g711-ulaw-8khz", "g711-ulaw-8khz");
    const input = Buffer.alloc(160, 0xff);
    expect(converter.process(input)).toBe(input);
  });

  it("keeps 16 kHz output stable across bridge packet boundaries", () => {
    const input = Buffer.alloc(960);
    for (let offset = 0; offset < input.length; offset += 2) {
      input.writeInt16LE(Math.round(Math.sin(offset / 20) * 10_000), offset);
    }
    const whole = createMeetingSttAudioConverter("pcm16-24khz", "pcm16-16khz");
    const split = createMeetingSttAudioConverter("pcm16-24khz", "pcm16-16khz");
    const expected = Buffer.concat([whole.process(input), whole.flush()]);
    const actual = Buffer.concat([
      split.process(input.subarray(0, 240)),
      split.process(input.subarray(240, 720)),
      split.process(input.subarray(720)),
      split.flush(),
    ]);
    expect(actual).toEqual(expected);
    expect(actual.length).toBe(640);
  });
});
