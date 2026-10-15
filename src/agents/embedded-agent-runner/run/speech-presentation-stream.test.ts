import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  getEventStreamCompletion,
} from "../../../../packages/llm-core/src/utils/event-stream.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AssistantMessage, AssistantMessageEvent } from "../../../llm/types.js";
import type { StreamFn } from "../../runtime/index.js";
import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { wrapStreamFnWithSpeechPresentation } from "./speech-presentation-stream.js";

const plain = "Hello there.";
const expression = { emotion: "happy", parts: [{ text: plain }] };
const envelope = JSON.stringify({ type: "speech", text: plain, expression });

function message(text: string): AssistantMessage {
  return makeAssistantMessageFixture({
    content: [{ type: "text", text }],
    stopReason: "stop",
    errorMessage: undefined,
  });
}

function source(
  events: AssistantMessageEvent[],
  result: AssistantMessage,
): MutableAssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    result: async () => result,
  };
}

async function open(streamFn: StreamFn, assertCurrent = () => {}) {
  return wrapStreamFnWithSpeechPresentation(streamFn, assertCurrent)({} as never, { messages: [] });
}

async function collect(stream: MutableAssistantMessageEventStream) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("native speech presentation stream", () => {
  it("projects stale expression envelopes to plain text without facts when disabled", async () => {
    const stale = message(
      JSON.stringify({ type: "speech", text: plain, expression: { unknown: true } }),
    );
    const stream = await wrapStreamFnWithSpeechPresentation(
      () => source([{ type: "done", reason: "stop", message: stale }], stale),
      () => {},
      { expressionEnabled: false },
    )({} as never, { messages: [] });
    const events = await collect(stream);
    const last = events.at(-1);
    expect(last?.type).toBe("done");
    if (last?.type === "done") {
      expect(last.message.content).toEqual([{ type: "text", text: plain }]);
    }
    expect((await stream.result()).content).toEqual([{ type: "text", text: plain }]);
  });
  it("suppresses every partial JSON prefix and projects final facts without mutating raw snapshots", async () => {
    const events: AssistantMessageEvent[] = [];
    const snapshots: AssistantMessage[] = [];
    for (let index = 0; index < envelope.length; index++) {
      const partial = message(envelope.slice(0, index + 1));
      Object.freeze(partial.content[0]);
      Object.freeze(partial.content);
      Object.freeze(partial);
      snapshots.push(partial);
      events.push(
        Object.freeze({ type: "text_delta", contentIndex: 0, delta: envelope[index], partial }),
      );
    }
    const final = message(envelope);
    const terminal: AssistantMessageEvent = Object.freeze({
      type: "done",
      reason: "stop",
      message: final,
    });
    const raw = source([...events, terminal], final);
    const stream = await open(() => raw);
    const projected = await collect(stream);
    const deltas = projected.filter((event) => event.type === "text_delta");
    expect(deltas.map((event) => event.delta).join("")).toBe(plain);
    expect(deltas.slice(0, -1).every((event) => event.delta === "")).toBe(true);
    for (const event of projected) {
      if ("partial" in event) {
        expect(event.partial?.content[0]).toMatchObject({ type: "text" });
        expect(event.partial?.content[0]).not.toHaveProperty("text", envelope);
      }
    }
    expect(projected.at(-1)).toMatchObject({
      type: "done",
      message: {
        content: [{ text: plain, openclawDelivery: { tts: { tagged: true, expression } } }],
      },
    });
    expect((await stream.result()).content[0]).toMatchObject({
      text: plain,
      openclawDelivery: { tts: { tagged: true } },
    });
    expect(stream).toBe(raw);
    expect(terminal.message).toBe(final);
    expect(final.content[0]).toEqual({ type: "text", text: envelope });
    expect(snapshots.map((snapshot) => snapshot.content[0])).toEqual(
      Array.from({ length: envelope.length }, (_, index) => ({
        type: "text",
        text: envelope.slice(0, index + 1),
      })),
    );
  });

  it("handles partialless deltas and cleans text-end content without injecting events", async () => {
    const final = message(envelope);
    const events: AssistantMessageEvent[] = [
      { type: "text_start", contentIndex: 0, partial: message("") },
      { type: "text_delta", contentIndex: 0, delta: envelope.slice(0, 17) },
      { type: "text_delta", contentIndex: 0, delta: envelope.slice(17) },
      { type: "text_end", contentIndex: 0, content: envelope, partial: final },
    ];
    const projected = await collect(await open(() => source(events, final)));
    expect(projected.map((event) => event.type)).toEqual(events.map((event) => event.type));
    expect(projected).toMatchObject([
      { contentIndex: 0 },
      { delta: "", contentIndex: 0 },
      { delta: plain, contentIndex: 0 },
      {
        content: plain,
        partial: { content: [{ text: plain, openclawDelivery: { tts: { expression } } }] },
      },
    ]);
  });

  it("preserves native producer completion independently of consumer iteration", async () => {
    const raw = createAssistantMessageEventStream();
    const completion = getEventStreamCompletion(raw);
    const stream = await open(() => raw);
    const final = message(envelope);
    raw.push({ type: "done", reason: "stop", message: final });
    raw.end();
    expect(stream).toBe(raw);
    expect(getEventStreamCompletion(stream)).toBe(completion);
    await expect(completion).resolves.toBe(final);
    expect(await stream.result()).toMatchObject({ content: [{ text: plain }] });
  });

  it("keeps ordinary text, tool IDs and reasoning order unchanged while cleaning their partials", async () => {
    const thinking = { type: "thinking" as const, thinking: "Working", thinkingSignature: "sig" };
    const tool = {
      type: "toolCall" as const,
      id: "call-example",
      name: "lookup",
      arguments: { key: 1 },
    };
    const partial = makeAssistantMessageFixture({
      content: [thinking, { type: "text", text: envelope.slice(0, 16) }, tool],
    });
    const final = makeAssistantMessageFixture({
      content: [thinking, { type: "text", text: "Ordinary text." }, tool],
    });
    const events: AssistantMessageEvent[] = [
      { type: "thinking_delta", contentIndex: 0, delta: "Working", partial },
      { type: "toolcall_end", contentIndex: 2, toolCall: tool, partial },
      { type: "text_start", contentIndex: 1, partial: final },
      { type: "text_delta", contentIndex: 1, delta: "Ordinary text.", partial: final },
      { type: "text_end", contentIndex: 1, content: "Ordinary text.", partial: final },
    ];
    const projected = await collect(await open(() => source(events, final)));
    expect(projected.map((event) => event.type)).toEqual(events.map((event) => event.type));
    expect(projected[0]).toMatchObject({
      contentIndex: 0,
      delta: "Working",
      partial: { content: [thinking, { text: "" }, tool] },
    });
    expect(projected[1]).toMatchObject({ contentIndex: 2, toolCall: tool });
    expect(projected.slice(2)).toEqual(events.slice(2));
    expect("partial" in projected[2] && projected[2].partial).toBe(final);
    expect(partial.content[1]).toMatchObject({ text: envelope.slice(0, 16) });
    expect(projected[1]).toHaveProperty("toolCall", tool);
  });

  it("projects result-only and error paths and is idempotent on already projected text", async () => {
    const final = message(envelope);
    const stream = await open(() =>
      source([{ type: "error", reason: "error", error: final }], final),
    );
    const result = await stream.result();
    expect(result.content[0]).toMatchObject({
      text: plain,
      openclawDelivery: { tts: { expression } },
    });
    expect(await collect(stream)).toMatchObject([{ type: "error", error: result }]);
    const again = await open(() => source([], result));
    expect(await again.result()).toBe(result);
  });

  it("releases an ambiguous prefix when it becomes ordinary text", async () => {
    const final = message("{ordinary}");
    const stream = await open(() =>
      source(
        [
          { type: "text_delta", contentIndex: 0, delta: "{" },
          { type: "text_delta", contentIndex: 0, delta: "ordinary}" },
        ],
        final,
      ),
    );
    expect(await collect(stream)).toMatchObject([{ delta: "" }, { delta: "{ordinary}" }]);
  });

  it("rejects a final invalid explicit envelope instead of leaking its serialized controls", async () => {
    const final = message('{"type":"speech","text":7}');
    const stream = await open(() => source([], final));
    await expect(stream.result()).rejects.toThrow();
  });

  it("checks current admission before a captured invocation and after a delayed stream resolution", async () => {
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("closed speech run");
      }
    };
    const gate = createDeferred<MutableAssistantMessageEventStream>();
    const wrapped = wrapStreamFnWithSpeechPresentation(() => gate.promise, assertCurrent);
    const pending = wrapped({} as never, { messages: [] });
    current = false;
    gate.resolve(source([], message("plain")));
    await expect(pending).rejects.toThrow("closed speech run");
    expect(() => wrapped({} as never, { messages: [] })).toThrow("closed speech run");
  });

  it("rejects a result and an event that settle after admission closes", async () => {
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("closed speech run");
      }
    };
    const resultGate = createDeferred<AssistantMessage>();
    const eventGate = createDeferred<IteratorResult<AssistantMessageEvent>>();
    const raw: MutableAssistantMessageEventStream = {
      result: () => resultGate.promise,
      [Symbol.asyncIterator]: () => ({ next: () => eventGate.promise }),
    };
    const stream = await open(() => raw, assertCurrent);
    const result = stream.result();
    const event = stream[Symbol.asyncIterator]().next();
    current = false;
    resultGate.resolve(message(envelope));
    eventGate.resolve({
      done: false,
      value: { type: "text_delta", contentIndex: 0, delta: envelope },
    });
    await expect(result).rejects.toThrow("closed speech run");
    await expect(event).rejects.toThrow("closed speech run");
    await expect(stream.result()).rejects.toThrow("closed speech run");
  });
});
