import { describe, expect, it } from "vitest";
import {
  applyAssistantDeliveryDirectives,
  projectAssistantTranscriptText,
} from "./transcript-assistant-delivery.js";

describe("assistant delivery normalization across native parts", () => {
  it("publishes native speech facts without changing admitted text bytes or block identity", () => {
    const expression = { emotion: "joyful", parts: [{ event: "laugh" }, { text: " Hello. " }] };
    const block = {
      type: "text",
      text: " Hello. ",
      textSignature: "native-part",
      openclawDelivery: { tts: { tagged: true, text: " Hello. ", expression } },
    };
    const message = { role: "assistant", content: [block] };
    applyAssistantDeliveryDirectives(message);
    expect(message.content[0]).toBe(block);
    expect(block.text).toBe(" Hello. ");
    expect(block.textSignature).toBe("native-part");
    expect(projectAssistantTranscriptText(message)?.openclawDelivery?.tts).toEqual({
      tagged: true,
      text: " Hello. ",
      expression,
    });
    const prepared = structuredClone(message);
    applyAssistantDeliveryDirectives(message);
    expect(message).toEqual(prepared);
  });

  it("merges native final parts after normalizing legacy-only siblings, not commentary", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Working.",
          textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
          openclawDelivery: { tts: { tagged: true, text: "Working." } },
        },
        {
          type: "text",
          text: "[[tts:voice=example]]Prefix.",
          textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
        },
        {
          type: "text",
          text: "Hello.",
          textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
          openclawDelivery: {
            tts: {
              tagged: true,
              text: "Hello.",
              expression: { emotion: "joyful", parts: [{ event: "laugh" }, { text: "Hello." }] },
            },
          },
        },
      ],
    };
    applyAssistantDeliveryDirectives(message);
    expect(projectAssistantTranscriptText(message)?.openclawDelivery?.tts).toEqual({
      tagged: true,
      text: "Prefix.\nHello.",
      expression: {
        parts: [
          { text: "Prefix." },
          { text: "\n", emotion: "joyful" },
          { event: "laugh" },
          { text: "Hello." },
        ],
      },
      directives: [{ values: { voice: "example" } }],
    });
    const prepared = structuredClone(message);
    applyAssistantDeliveryDirectives(message);
    expect(message).toEqual(prepared);
  });

  it("replaces stale aggregate speech with native phase facts, including an omitted expression", () => {
    const expression = { emotion: "joyful", parts: [{ text: "Hello." }] };
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Hello.",
          openclawDelivery: { tts: { tagged: true, text: "Hello." } },
        },
      ],
      openclawDelivery: {
        mediaUrls: ["./kept.png"],
        tts: { tagged: true, text: "Hello.", expression },
      },
    };
    applyAssistantDeliveryDirectives(message);
    expect(message.openclawDelivery).toEqual({
      mediaUrls: ["./kept.png"],
      tts: { tagged: true, text: "Hello." },
    });
  });

  it("does not publish commentary-only native speech as final delivery facts", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Working.",
          textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
          openclawDelivery: { tts: { tagged: true, text: "Working." } },
        },
      ],
    };
    const before = structuredClone(message);
    expect(applyAssistantDeliveryDirectives(message)).toEqual(before);
    expect(projectAssistantTranscriptText(message)).toBeUndefined();
  });

  it("rejects stale expression projections before any legacy normalization mutates siblings", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "[[reply_to_current]]Prefix." },
        {
          type: "text",
          text: "[[tts:voice=example]]Hello.",
          openclawDelivery: {
            tts: {
              tagged: true,
              text: "[[tts:voice=example]]Hello.",
              expression: { parts: [{ text: "Hello." }] },
            },
          },
        },
      ],
    };
    const before = structuredClone(message);
    expect(() => applyAssistantDeliveryDirectives(message)).toThrow("project exactly");
    expect(message).toEqual(before);
  });

  it("rejects mixed native and legacy controls instead of silently restyling admitted speech", () => {
    const text = "[[tts:voice=example]]Hello.";
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "[[reply_to_current]]Prefix." },
        {
          type: "text",
          text,
          openclawDelivery: {
            tts: { tagged: true, text, expression: { parts: [{ text }] } },
          },
        },
      ],
    };
    const before = structuredClone(message);
    expect(() => applyAssistantDeliveryDirectives(message)).toThrow("legacy delivery directives");
    expect(message).toEqual(before);
  });

  it("keeps marker-like text inside native code examples literal", () => {
    const text = "Use `[[tts:voice=example]]` in a legacy example.";
    const message = {
      role: "assistant",
      content: [{ type: "text", text, openclawDelivery: { tts: { tagged: true, text } } }],
    };
    applyAssistantDeliveryDirectives(message);
    expect(projectAssistantTranscriptText(message)).toMatchObject({
      text,
      openclawDelivery: { tts: { tagged: true, text } },
    });
  });

  it("preserves speech-only expressions through transcript projection and marker retirement", () => {
    const expression = { emotion: "joyful", parts: [{ text: "Hello." }] };
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "[[tts:voice=example]]Visible answer." }],
      openclawDelivery: { tts: { tagged: true, text: "Hello.", expression } },
    };
    applyAssistantDeliveryDirectives(message);
    const projected = projectAssistantTranscriptText(message);
    expect(projected?.text).toBe("Visible answer.");
    expect(projected?.openclawDelivery?.tts).toMatchObject({ text: "Hello.", expression });
    expect(projected?.text).not.toContain("joyful");
    expect(
      projectAssistantTranscriptText({
        ...message,
        openclawDelivery: { tts: { tagged: true, text: "Different.", expression } },
      })?.openclawDelivery?.tts,
    ).toBeUndefined();
  });
  it.each([
    {
      name: "reply IDs containing code bytes",
      parts: ["Prefix.", "[[reply_to:`quoted`]]Reply."],
      expected: ["Prefix.", "Reply."],
      facts: { replyToId: "`quoted`" },
    },
    {
      name: "speech text containing code and placeholder-like bytes",
      parts: ["Prefix.", "Shown. [[tts:text]]Speak `code` \uE0000\uE000.[[/tts:text]]"],
      expected: ["Prefix.", "Shown."],
      facts: { tts: { tagged: true, text: "Speak `code` \uE0000\uE000." } },
    },
    {
      name: "speech directive values containing code bytes",
      parts: ["Prefix.", "[[tts:provider=openai voice=`quoted`]]Shown."],
      expected: ["Prefix.", "Shown."],
      facts: {
        tts: { tagged: true, directives: [{ provider: "openai", values: { voice: "`quoted`" } }] },
      },
    },
    {
      name: "code whitespace around a genuine voice directive",
      parts: ["Use `", "  [[reply_to:literal]]  `\n[[audio_as_voice]]Done."],
      expected: ["Use `", "  [[reply_to:literal]]  `\nDone."],
      facts: { audioAsVoice: true },
    },
  ])("preserves $name and remains idempotent", ({ parts, expected, facts }) => {
    const content = parts.map((text, index) => ({
      type: "text",
      text,
      textSignature: `native-${index}`,
    }));
    const identities = [...content];
    const message = { role: "assistant", content, openclawDelivery: { mediaUrls: ["./kept.png"] } };
    applyAssistantDeliveryDirectives(message);
    expect(message.content).toBe(content);
    expect(message.content.map((block) => block.text)).toEqual(expected);
    expect(message.openclawDelivery).toEqual({ mediaUrls: ["./kept.png"], ...facts });
    for (const [index, block] of message.content.entries()) {
      expect(block).toBe(identities[index]);
      expect(block.textSignature).toBe(`native-${index}`);
    }
    const prepared = structuredClone(message);
    applyAssistantDeliveryDirectives(message);
    expect(message).toEqual(prepared);
  });

  it("keeps commentary code context separate from final intent", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "```text\n[[reply_to:commentary]]",
          textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }),
        },
        {
          type: "text",
          text: "[[reply_to_current]]Final reply.",
          textSignature: JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
        },
      ],
    };
    applyAssistantDeliveryDirectives(message);
    expect(message).toMatchObject({
      content: [{ text: "```text\n[[reply_to:commentary]]" }, { text: "Final reply." }],
      openclawDelivery: { replyToCurrent: true },
    });
  });
});
