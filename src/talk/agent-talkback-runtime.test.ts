import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createRealtimeVoiceAgentTalkbackQueue } from "./agent-talkback-runtime.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type QueueParams = Parameters<typeof createRealtimeVoiceAgentTalkbackQueue>[0];

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn() });
function expectConsultCall(
  consult: ReturnType<typeof vi.fn>,
  index: number,
  expected: Record<string, unknown>,
) {
  expect(consult.mock.calls[index]?.[0]).toMatchObject({
    ...expected,
    signal: expect.any(AbortSignal),
  });
}

function createQueue(params: Pick<QueueParams, "consult"> & Partial<QueueParams>) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const deliver = vi.fn();
  const queue = createRealtimeVoiceAgentTalkbackQueue({
    debounceMs: 1,
    isStopped: () => false,
    logger,
    logPrefix: "[test]",
    responseStyle: "brief",
    fallbackText: "fallback",
    deliver,
    ...params,
  });
  return { queue, logger, deliver };
}

async function createPendingQueue(debounceMs = 1) {
  const { promise: pending, resolve } = createDeferred<{ text: string }>();
  const consult = vi
    .fn<QueueParams["consult"]>()
    .mockImplementationOnce(() => pending)
    .mockResolvedValue({ text: "queued-answer" });
  const fixture = createQueue({ consult, debounceMs });
  fixture.queue.enqueue("first");
  await vi.advanceTimersByTimeAsync(debounceMs);
  return {
    ...fixture,
    consult,
    finish: async () => {
      resolve({ text: "first-answer" });
      await vi.runAllTimersAsync();
    },
  };
}

describe("realtime voice agent talkback queue", () => {
  it("observes queued and active work through the synchronous delivery handoff", async () => {
    vi.useFakeTimers();
    const first = createDeferred<{ text: string }>();
    const onActivity = vi.fn<NonNullable<QueueParams["onActivity"]>>();
    const deliver = vi.fn(() => {
      expect(onActivity.mock.calls.at(-1)?.[0].active).toBe(true);
    });
    const { queue } = createQueue({
      consult: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ text: "Second." }),
      onActivity,
      deliver,
    });
    queue.enqueue("First", "source-a");
    expect(onActivity).toHaveBeenLastCalledWith({ queued: 1, active: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(onActivity).toHaveBeenLastCalledWith({ queued: 0, active: true });
    queue.enqueue("Second", "source-b");
    expect(onActivity).toHaveBeenLastCalledWith({ queued: 1, active: true });
    first.resolve({ text: "First." });
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(onActivity).toHaveBeenLastCalledWith({ queued: 0, active: false });
    expect(queue.isIdle()).toBe(true);
    queue.close();
  });

  it("contains failing observers without changing work or delivery", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const { queue } = createQueue({
      consult: async () => ({ text: "Complete." }),
      onActivity() {
        throw new Error("synthetic observer failure");
      },
      deliver,
    });
    expect(queue.enqueue("Question")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledExactlyOnceWith("Complete.");
    expect(queue.isIdle()).toBe(true);
    queue.close();
  });

  it("debounces transcript fragments into one consult", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const consult = vi.fn(async ({ question }) => ({ text: `answer:${question}` }));
    const deliver = vi.fn();
    const queue = createRealtimeVoiceAgentTalkbackQueue({
      debounceMs: 100,
      isStopped: () => false,
      logger,
      logPrefix: "[test]",
      responseStyle: "brief",
      fallbackText: "fallback",
      consult,
      deliver,
    });

    queue.enqueue("first");
    queue.enqueue("second");
    await vi.advanceTimersByTimeAsync(100);

    expectConsultCall(consult, 0, {
      metadata: undefined,
      question: "first\nsecond",
      responseStyle: "brief",
    });
    expect(deliver).toHaveBeenCalledWith("answer:first\nsecond");
  });

  it("does not replay a result already delivered through the consult speech stream", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const queue = createRealtimeVoiceAgentTalkbackQueue({
      debounceMs: 1,
      isStopped: () => false,
      logger: makeLogger(),
      logPrefix: "[test]",
      responseStyle: "brief",
      fallbackText: "fallback",
      consult: vi.fn(async () => ({ text: "streamed answer", delivered: true })),
      deliver,
    });

    queue.enqueue("question");
    await vi.advanceTimersByTimeAsync(1);

    expect(deliver).not.toHaveBeenCalled();
  });

  it("accumulates pending questions while a consult is active", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    let finishFirst: ((value: { text: string }) => void) | undefined;
    const consult = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ text: string }>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ text: "second-answer" });
    const deliver = vi.fn();
    const queue = createRealtimeVoiceAgentTalkbackQueue({
      debounceMs: 10,
      isStopped: () => false,
      logger,
      logPrefix: "[test]",
      responseStyle: "brief",
      fallbackText: "fallback",
      consult,
      deliver,
    });

    queue.enqueue("first");
    await vi.advanceTimersByTimeAsync(10);
    queue.enqueue("ignored");
    queue.enqueue("second");
    await vi.advanceTimersByTimeAsync(10);
    finishFirst?.({ text: "first-answer" });
    await vi.runAllTimersAsync();

    expectConsultCall(consult, 0, {
      metadata: undefined,
      question: "first",
      responseStyle: "brief",
    });
    expectConsultCall(consult, 1, {
      metadata: undefined,
      question: "ignored\nsecond",
      responseStyle: "brief",
    });
    expect(deliver).toHaveBeenCalledWith("first-answer");
    expect(deliver).toHaveBeenCalledWith("second-answer");
  });

  it("keeps active pending questions split by metadata", async () => {
    const ownerMetadata = { senderIsOwner: true };
    const guestMetadata = { senderIsOwner: false };
    const { queue, deliver, consult, finish } = await createPendingQueue(10);
    consult
      .mockResolvedValueOnce({ text: "owner-answer" })
      .mockResolvedValueOnce({ text: "guest-answer" });
    queue.enqueue("owner", ownerMetadata);
    queue.enqueue("guest", guestMetadata);
    await vi.advanceTimersByTimeAsync(10);
    await finish();

    expect(
      consult.mock.calls.slice(1).map(([{ question, metadata }]) => [question, metadata]),
    ).toEqual([
      ["owner", ownerMetadata],
      ["guest", guestMetadata],
    ]);
    expect(deliver.mock.calls.slice(1)).toEqual([["owner-answer"], ["guest-answer"]]);
  });

  it("bounds merged pending question text while a consult is active", async () => {
    const { queue, logger, consult, finish } = await createPendingQueue();
    const fragment = "x".repeat(4096);
    for (let index = 0; index < 10; index += 1) {
      queue.enqueue(fragment);
    }
    await finish();

    expect(consult.mock.calls.map(([request]) => request.question)).toEqual([
      "first",
      Array.from({ length: 7 }, () => fragment).join("\n"),
    ]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("bounds pending question count while preserving retained order", async () => {
    const { queue, logger, consult, finish } = await createPendingQueue();
    const metadata = Array.from({ length: 40 }, (_, index) => ({ index }));
    metadata.forEach((entry, index) => queue.enqueue(`question-${index}`, entry));
    await finish();

    expect(consult.mock.calls.slice(1).map(([request]) => request.metadata)).toStrictEqual(
      metadata.slice(0, 32),
    );
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("delivers fallback text when consult fails", async () => {
    const { queue, logger, deliver } = createQueue({
      consult: vi.fn<QueueParams["consult"]>().mockRejectedValue(new Error("boom")),
    });

    queue.enqueue("question");
    await vi.advanceTimersByTimeAsync(1);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith("fallback");
  });

  it("cancels pending debounced work on close", async () => {
    const consult = vi.fn(async () => ({ text: "answer" }));
    const { queue } = createQueue({
      debounceMs: 100,
      consult,
    });

    queue.enqueue("question");
    queue.close();
    await vi.advanceTimersByTimeAsync(100);

    expect(consult).not.toHaveBeenCalled();
  });

  it("aborts the active consult on close without delivering fallback", async () => {
    const pending = createDeferred<{ text: string }>();
    const consult = vi.fn<QueueParams["consult"]>(({ signal }) => {
      signal.addEventListener("abort", () => pending.reject(signal.reason));
      return pending.promise;
    });
    const { queue, logger, deliver } = createQueue({ consult });

    queue.enqueue("question");
    await vi.advanceTimersByTimeAsync(1);
    queue.close();
    queue.close();
    queue.enqueue("late question");
    await vi.runAllTimersAsync();

    expect(consult.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(consult).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
