import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixMonitorHandlerParams } from "./handler-types.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";

const roomId = "!room:example.org";
type HarnessOptions = NonNullable<Parameters<typeof createMatrixHandlerTestHarness>[0]>;

function setup(options: HarnessOptions = {}) {
  const harness = createMatrixHandlerTestHarness({
    historyLimit: 20,
    groupPolicy: "open",
    isDirectMessage: false,
    dispatchInboundMessage: async () => ({
      queuedFinal: true,
      counts: { final: 1, block: 0, tool: 0 },
    }),
    ...options,
  });
  const receive = (event: MatrixRawEvent) => harness.handler(roomId, event);
  const text = (eventId: string, body: string, ts?: number, trigger = false) =>
    receive(
      createMatrixTextMessageEvent({
        eventId,
        body: trigger ? `@room ${body}` : body,
        originServerTs: ts,
        ...(trigger ? { mentions: { room: true } } : {}),
      }),
    );
  return {
    ...harness,
    receive,
    text,
    trigger: (eventId: string, body: string, ts?: number) => text(eventId, body, ts, true),
    history: (index = 0) =>
      harness.runPrepared.mock.calls[index]![0].ctxPayload.InboundHistory?.map(
        (entry) => entry.body,
      ) ?? [],
  };
}

beforeEach(() => installMatrixMonitorTestRuntime());

describe("matrix group chat history", () => {
  it.for([false, true])(
    "does not re-quote an admitted input while dispatch is settling (replay claim=%s)",
    async (withReplayClaim, { signal }) => {
      const adopted = createDeferred<void>();
      const settle = createDeferred<void>();
      const observedHistory: string[][] = [];
      const claim = { commit: vi.fn(async () => true), release: vi.fn() };
      type InboundRun = MatrixMonitorHandlerParams["core"]["channel"]["inbound"]["run"];
      const run = (async (params: Parameters<InboundRun>[0]) => {
        const input = await params.adapter.ingest(params.raw);
        if (!input) {
          throw new Error("Expected admitted Matrix input");
        }
        const turn = await params.adapter.resolveTurn(
          input,
          { kind: "message", canStartAgentTurn: true },
          {},
        );
        if (!("route" in turn) || "runDispatch" in turn) {
          throw new Error("Expected routed Matrix turn");
        }
        observedHistory.push(turn.ctxPayload.InboundHistory?.map((item) => item.body) ?? []);
        expect(params.turnAdoptionLifecycle).toBeDefined();
        await params.turnAdoptionLifecycle?.onAdopted();
        if (input.id === "$first") {
          adopted.resolve();
          await settle.promise;
        }
        return {
          admission: { kind: "dispatch" as const },
          dispatched: true as const,
          ctxPayload: turn.ctxPayload,
          routeSessionKey: turn.route.sessionKey,
          dispatchResult: { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } },
        };
      }) as InboundRun;
      const f = setup({
        runChannelInboundEvent: run,
        inboundDeduper: withReplayClaim
          ? {
              claim: vi.fn(async ({ eventId }) => ({
                kind: "claimed" as const,
                handle: { keys: [eventId] as const, ...claim },
              })),
            }
          : undefined,
      });
      await f.text("$before", "ambient before", 1_000);
      const first = f.trigger("$first", "first input", 2_000);
      const release = () => settle.resolve();
      signal.addEventListener("abort", release, { once: true });
      try {
        const outcome = await Promise.race([
          adopted.promise.then(() => "adopted"),
          first.then(() => "returned"),
        ]);
        expect(outcome).toBe("adopted");
        await f.text("$after", "ambient after", 3_000);
        await f.trigger("$second", "second input", 4_000);
        expect(observedHistory).toEqual([["ambient before"], ["ambient before", "ambient after"]]);
        if (withReplayClaim) {
          expect(claim.commit).toHaveBeenCalled();
          expect(claim.release).not.toHaveBeenCalled();
        }
      } finally {
        signal.removeEventListener("abort", release);
        release();
        await first;
      }
    },
  );

  it("respects historyLimit: caps to the most recent N entries", async () => {
    const f = setup({ historyLimit: 2 });
    for (let i = 1; i <= 4; i++) {
      await f.text(`$p${i}`, `pending ${i}`, i * 1000);
    }
    await f.trigger("$t", "trigger", 5000);
    const history = f.history();
    expect(history).toHaveLength(2);
    expect(history[0]).toContain("pending 3");
    expect(history[1]).toContain("pending 4");
  });

  it("history-enabled rooms do not serialize DM ingress heavy work", async () => {
    let resolveFirstName: (() => void) | undefined;
    let nameLookupCalls = 0;
    const f = setup({
      isDirectMessage: true,
      getMemberDisplayName: vi.fn(async () => {
        nameLookupCalls += 1;
        if (nameLookupCalls === 1) {
          await new Promise<void>((resolve) => {
            resolveFirstName = resolve;
          });
        }
        return "sender";
      }),
    });
    const first = f.text("$dm-a", "first dm");
    await vi.waitFor(() => {
      expect(resolveFirstName).toBeTypeOf("function");
    });
    const second = f.text("$dm-b", "second dm");
    await vi.waitFor(() => {
      expect(nameLookupCalls).toBe(2);
    });
    resolveFirstName?.();
    await Promise.all([first, second]);
  });

  it("includes skipped poll updates in next trigger history", async () => {
    const getEvent = vi.fn(async () => ({
      event_id: "$poll",
      sender: "@user:example.org",
      type: "m.poll.start",
      origin_server_ts: Date.now(),
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          kind: "m.poll.disclosed",
          max_selections: 1,
          answers: [{ id: "a1", "m.text": "Pizza" }],
        },
      },
    }));
    const getRelations = vi.fn(async () => ({ events: [], nextBatch: null, prevBatch: null }));
    const f = setup({ client: { getEvent, getRelations } });
    await f.receive({
      type: "m.poll.response",
      sender: "@user:example.org",
      event_id: "$poll-response-1",
      origin_server_ts: 1000,
      content: {
        "m.poll.response": { answers: ["a1"] },
        "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
      },
    });
    expect(f.finalizeInboundContext).not.toHaveBeenCalled();
    await f.trigger("$trigger-poll", "trigger", 2000);
    expect(getEvent).toHaveBeenCalledOnce();
    expect(getRelations).toHaveBeenCalledOnce();
    expect(f.history().join("\n")).toContain("Lunch?");
  });

  it("retrying the same failed trigger reuses the original history window", async () => {
    const f = setup({
      createReplyDispatcherWithTyping: (params) => ({
        dispatcher: {
          markComplete: () => {},
          waitForIdle: async () => {
            params?.onError?.(new Error("simulated delivery failure"), { kind: "final" });
          },
        },
        replyOptions: {},
        markDispatchIdle: () => {},
        markRunComplete: () => {},
      }),
    });
    await f.text("$p", "pending msg", 1000);
    await f.trigger("$same", "trigger", 2000);
    await f.trigger("$same", "trigger", 2000);
    expect(f.finalizeInboundContext).toHaveBeenCalledTimes(2);
    expect(f.history(0)).toEqual(["pending msg"]);
    expect(f.history(1)).toEqual(["pending msg"]);
  });
});
