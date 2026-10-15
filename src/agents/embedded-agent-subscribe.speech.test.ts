import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import type { SpeechExpression, TextContent } from "../llm/types.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import {
  captureNativeBlockSpeechSource,
  projectNativeBlockSpeech,
} from "./embedded-agent-subscribe.speech.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

function block(text: string, emotion: string, commentary = false): TextContent {
  return {
    type: "text",
    text,
    textSignature: JSON.stringify({ v: 1, phase: commentary ? "commentary" : "final_answer" }),
    openclawDelivery: {
      tts: { tagged: true, text, expression: { emotion, parts: [{ text }] } },
    },
  };
}

describe("native block speech delivery", () => {
  it("snapshots producer text while retaining canonical delivery facts", () => {
    const text = block("First.", "joyful");
    const message = makeAgentAssistantMessage({ content: [text] });
    const captured = captureNativeBlockSpeechSource(message);
    text.text = "Changed by a later provider update.";
    expect(captured?.content[0]).toMatchObject({ text: "First." });
    expect(captured?.content[0]).not.toBe(text);
    const capturedText = captured?.content[0];
    if (!capturedText || capturedText.type !== "text") {
      throw new Error("Expected the captured producer text block");
    }
    expect(capturedText.openclawDelivery).toBe(text.openclawDelivery);
  });

  it.each([undefined, "joyful"])(
    "keeps compact message_end buffers bound to their producer (%s)",
    async (firstEmotion) => {
      const onBlockReply = vi.fn<(payload: ReplyPayload) => void>();
      const h = createSubscribedSessionHarness({
        runId: "compact-native-speech",
        onBlockReply,
        blockReplyBreak: "message_end",
      });
      const items = [
        { id: "item-a", text: "Alpha.", emotion: firstEmotion },
        { id: "item-b", text: "Beta.", emotion: "sad" },
      ];
      const content = items.map(({ id, text, emotion }): TextContent => ({
        ...(emotion ? block(text, emotion) : { type: "text" as const, text }),
        textSignature: JSON.stringify({ v: 1, id, phase: "final_answer" }),
      }));
      const base = makeAgentAssistantMessage({
        api: "openai-responses",
        provider: "openai",
        content: [],
      });
      try {
        h.emit({ type: "message_start", message: { ...base, content: [] } });
        for (const [contentIndex, entry] of content.entries()) {
          // Responses may carry just the current item while its index remains global.
          const partial = { ...base, content: [entry] };
          for (const type of ["text_delta", "text_end"] as const) {
            h.emit({
              type: "message_update",
              message: partial,
              assistantMessageEvent: {
                type,
                contentIndex,
                ...(type === "text_delta" ? { delta: entry.text } : { content: entry.text }),
                partial,
              },
            });
          }
          await h.subscription.waitForPendingEvents();
          expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual(
            contentIndex === 0 ? [] : ["Alpha."],
          );
        }
        h.emit({ type: "message_end", message: { ...base, content } });
        await h.subscription.waitForPendingEvents();
        expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
          "Alpha.",
          "Beta.",
        ]);
        expect(
          onBlockReply.mock.calls.map(
            ([payload]) => getReplyPayloadMetadata(payload)?.tts?.expression?.emotion,
          ),
        ).toEqual([firstEmotion, "sad"]);
        expect(
          onBlockReply.mock.calls.map(
            ([payload]) => getReplyPayloadMetadata(payload)?.assistantMessageStartIndex,
          ),
        ).toEqual([1, 1]);
      } finally {
        h.subscription.unsubscribe();
      }
    },
  );

  it("keeps identical chunks tied to their exact native block and inherits scoped emotion", () => {
    const message = makeAgentAssistantMessage({
      content: [block("Yes.", "joyful"), block("Yes.", "sad")],
    });
    expect(
      projectNativeBlockSpeech({ message, text: "Yes.", sourceRange: [0, 4] })?.tts?.expression,
    ).toEqual({ emotion: "joyful", parts: [{ text: "Yes." }] });
    expect(
      projectNativeBlockSpeech({
        message,
        text: "Yes.",
        sourceRange: [0, 4],
        sourceContentIndex: 1,
      })?.tts?.expression,
    ).toEqual({ emotion: "sad", parts: [{ text: "Yes." }] });
  });

  it("permits native trailing separator trimming without moving the source start", () => {
    const message = makeAgentAssistantMessage({ content: [block("First. Second.", "joyful")] });
    expect(
      projectNativeBlockSpeech({ message, text: "First.", sourceRange: [0, 7] })?.tts?.text,
    ).toBe("First.");
    expect(() =>
      projectNativeBlockSpeech({ message, text: "Second.", sourceRange: [0, 7] }),
    ).toThrow("authoritative source range");
  });

  it("does not apply the scope origin twice after a native snapshot reconciliation", () => {
    const message = makeAgentAssistantMessage({
      content: [block("First.", "joyful"), block("Second.", "sad")],
    });
    expect(
      projectNativeBlockSpeech({
        message,
        text: "Second.",
        sourceContentIndex: 1,
        sourceRange: [7, 14],
        sourceOffset: 7,
      })?.tts?.expression,
    ).toEqual({ emotion: "sad", parts: [{ text: "Second." }] });
  });

  it("keeps vocal events at a sentence boundary out of the preceding chunk", () => {
    const expression: SpeechExpression = {
      parts: [{ text: "First. " }, { event: "laugh" }, { text: "Second." }],
    };
    const message = makeAgentAssistantMessage({
      content: [
        {
          type: "text",
          text: "First. Second.",
          openclawDelivery: { tts: { tagged: true, text: "First. Second.", expression } },
        },
      ],
    });
    expect(
      projectNativeBlockSpeech({ message, text: "First.", sourceRange: [0, 7] })?.tts?.expression
        ?.parts,
    ).toEqual([{ text: "First." }]);
    expect(
      projectNativeBlockSpeech({ message, text: "Second.", sourceRange: [7, 14] })?.tts?.expression
        ?.parts,
    ).toEqual([{ event: "laugh" }, { text: "Second." }]);
  });

  it("retains a vocal event located in the native chunker's skipped whitespace", () => {
    const message = makeAgentAssistantMessage({
      content: [
        {
          type: "text",
          text: "Hi. Next. ",
          openclawDelivery: {
            tts: {
              tagged: true,
              text: "Hi. Next. ",
              expression: {
                parts: [
                  { text: "Hi." },
                  { event: "laugh" },
                  { text: " Next. " },
                  { event: "sigh" },
                ],
              },
            },
          },
        },
      ],
    });
    expect(
      projectNativeBlockSpeech({ message, text: "Hi.", sourceRange: [0, 3] })?.tts?.expression
        ?.parts,
    ).toEqual([{ text: "Hi." }]);
    expect(
      projectNativeBlockSpeech({ message, text: "Next.", sourceRange: [4, 9] })?.tts?.expression
        ?.parts,
    ).toEqual([{ event: "laugh" }, { text: "Next." }, { event: "sigh" }]);
  });

  it("delivers clean native commentary and final speech through the real subscription", async () => {
    const onBlockReply = vi.fn<(payload: ReplyPayload) => void>();
    const h = createSubscribedSessionHarness({
      runId: "native-speech",
      onBlockReply,
      deliverCommentaryBlocks: true,
      blockReplyBreak: "message_end",
    });
    const message = makeAgentAssistantMessage({
      content: [block("Checking.", "focused", true), block("It is ready.", "joyful")],
    });
    try {
      h.emit({ type: "message_start", message });
      h.emit({ type: "message_end", message });
      await h.subscription.waitForPendingEvents();
      expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
        "Checking.",
        "It is ready.",
      ]);
      expect(
        onBlockReply.mock.calls.map(
          ([payload]) => getReplyPayloadMetadata(payload)?.tts?.expression?.emotion,
        ),
      ).toEqual(["focused", "joyful"]);
    } finally {
      h.subscription.unsubscribe();
    }
  });
});
