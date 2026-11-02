import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { SpeechExpression } from "../llm/types.js";
import type { RealtimeVoiceAgentConsultSpeechEvent } from "./agent-consult-runtime.js";
import { createRealtimeVoiceConsultSpeechDelivery } from "./agent-consult-speech-delivery.js";

function utterance(
  text: string,
  index: number,
  messageStart: number,
  expression?: SpeechExpression,
  range?: readonly [number, number],
) {
  return setReplyPayloadMetadata(
    { text },
    {
      assistantMessageIndex: index,
      assistantMessageStartIndex: messageStart,
      tts: { tagged: true, text, ...(expression ? { expression } : {}) },
      ...(range ? { blockSourceText: text, blockSourceRange: range, ttsSourceRange: range } : {}),
    },
  );
}

function setup() {
  const events: RealtimeVoiceAgentConsultSpeechEvent[] = [];
  const delivery = createRealtimeVoiceConsultSpeechDelivery({
    runId: "example-run",
    sessionId: "example-session",
    abortSignal: new AbortController().signal,
    assertExpressionCurrent: () => {},
    assertNotInterrupted: () => {},
    speechExpressionContext: { guidance: "Native speech presentation.", assertCurrent: () => {} },
    logger: { warn: vi.fn() },
    onSpeakableText: (event) => {
      events.push(event);
    },
  });
  return { delivery, events };
}

describe("native voice source-occurrence recovery", () => {
  it("joins deliberate silent completion and preserves sink errors", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const failure = new Error("Synthetic silent completion sink failure");
    const assertNotInterrupted = vi.fn();
    const logger = { warn: vi.fn() };
    const delivery = createRealtimeVoiceConsultSpeechDelivery({
      runId: "silent-run",
      sessionId: "silent-session",
      abortSignal: new AbortController().signal,
      assertExpressionCurrent: () => {},
      assertNotInterrupted,
      logger,
      onSpeakableText: async (event) => {
        expect(event).toEqual({ type: "done", text: "" });
        entered.resolve();
        await release.promise;
        throw failure;
      },
    });
    let settled = false;
    const completion = delivery.finish({ yielded: false, deliberateSilent: true, payloads: [] });
    const expected = expect(completion).rejects.toBe(failure);
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await entered.promise;
      expect(settled).toBe(false);
      expect(assertNotInterrupted).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await expected;
    }
    expect(assertNotInterrupted).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it("appends only an unstreamed suffix of the adopted answer with its active expression", async () => {
    const { delivery, events } = setup();
    delivery.onBlockReply(utterance("Earlier.", 0, 0, undefined, [0, 8]));
    delivery.currentSourceReplyTarget!.beginInput!({});
    delivery.onBlockReply(utterance("A.", 1, 1, undefined, [0, 2]));
    const earlier = setReplyPayloadMetadata(utterance("Earlier.", 0, 0), {
      precedingInputAnswer: true,
    });
    const current = utterance("A.\nB.", 2, 1, {
      emotion: "joyful",
      parts: [{ text: "A.\n" }, { event: "laugh" }, { text: "B.", emotion: "tender" }],
    });
    const result = await delivery.finish({ yielded: false, payloads: [earlier, current] });
    const chunks = events.filter((event) => event.type === "chunk");
    expect(chunks.map((event) => event.text)).toEqual(["Earlier.", "A.", "B."]);
    expect(chunks[2]?.speech?.expression).toEqual({
      emotion: "joyful",
      parts: [{ event: "laugh" }, { text: "B.", emotion: "tender" }],
    });
    expect(result.text).toBe("A.\nB.");
  });

  it("does not treat identical words from a preceding input as current delivery", async () => {
    const { delivery, events } = setup();
    delivery.onBlockReply(utterance("Same.", 0, 0, undefined, [0, 5]));
    delivery.currentSourceReplyTarget!.beginInput!({});
    const earlier = setReplyPayloadMetadata(utterance("Same.", 0, 0), {
      precedingInputAnswer: true,
    });
    await delivery.finish({ yielded: false, payloads: [earlier, utterance("Same.", 1, 1)] });
    expect(events.filter((event) => event.type === "chunk").map((event) => event.text)).toEqual([
      "Same.",
      "Same.",
    ]);
  });

  it("distinguishes repeated current text by occurrence and preserves the second vocal event", async () => {
    const { delivery, events } = setup();
    delivery.onBlockReply(utterance("Old.", 0, 0, undefined, [0, 4]));
    delivery.currentSourceReplyTarget!.beginInput!({});
    delivery.onBlockReply(utterance("Hi.", 1, 1, undefined, [0, 3]));
    const earlier = setReplyPayloadMetadata(utterance("Old.", 0, 0), {
      precedingInputAnswer: true,
    });
    await delivery.finish({
      yielded: false,
      payloads: [
        earlier,
        utterance("Hi. Hi.", 1, 1, {
          parts: [{ text: "Hi." }, { event: "laugh" }, { text: " Hi.", emotion: "joyful" }],
        }),
      ],
    });
    const chunks = events.filter((event) => event.type === "chunk");
    expect(chunks.map((event) => event.text)).toEqual(["Old.", "Hi.", "Hi."]);
    expect(chunks[2]?.speech?.expression).toEqual({
      parts: [{ event: "laugh" }, { text: "Hi.", emotion: "joyful" }],
    });
  });

  it("does not infer delivery from a source occurrence in another physical message", async () => {
    const { delivery, events } = setup();
    delivery.onBlockReply(utterance("A.", 0, 0, undefined, [0, 2]));
    const earlier = setReplyPayloadMetadata(utterance("A.", 0, 0), {
      precedingInputAnswer: true,
    });
    await delivery.finish({ yielded: false, payloads: [earlier, utterance("A. B.", 2, 2)] });
    expect(events.filter((event) => event.type === "chunk").map((event) => event.text)).toEqual([
      "A.",
      "A. B.",
    ]);
  });

  it("does not recover a prefix whose source changed after streaming", async () => {
    const { delivery, events } = setup();
    delivery.onBlockReply(utterance("Old.", 0, 0, undefined, [0, 4]));
    delivery.currentSourceReplyTarget!.beginInput!({});
    delivery.onBlockReply(utterance("A.", 1, 1, undefined, [0, 2]));
    const earlier = setReplyPayloadMetadata(utterance("Old.", 0, 0), {
      precedingInputAnswer: true,
    });
    await delivery.finish({ yielded: false, payloads: [earlier, utterance("Changed. B.", 2, 1)] });
    expect(events.filter((event) => event.type === "chunk").map((event) => event.text)).toEqual([
      "Old.",
      "A.",
      "Changed. B.",
    ]);
  });

  it("does not mistake a later identical source occurrence for the delivered prefix", async () => {
    const { delivery, events } = setup();
    delivery.onBlockReply(utterance("Old.", 0, 0, undefined, [0, 4]));
    delivery.currentSourceReplyTarget!.beginInput!({});
    delivery.onBlockReply(utterance("Hi.", 1, 1, undefined, [4, 7]));
    const earlier = setReplyPayloadMetadata(utterance("Old.", 0, 0), {
      precedingInputAnswer: true,
    });
    await delivery.finish({ yielded: false, payloads: [earlier, utterance("Hi. Hi.", 1, 1)] });
    expect(events.filter((event) => event.type === "chunk").map((event) => event.text)).toEqual([
      "Old.",
      "Hi.",
      "Hi. Hi.",
    ]);
  });
});
