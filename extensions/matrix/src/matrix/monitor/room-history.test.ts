import { describe, expect, it } from "vitest";
import { createRoomHistoryTracker, type ReservedHistorySlot } from "./room-history.js";

const ROOM = "!room:test";
const AGENT = "agent_a";

function entry(body: string, messageId?: string) {
  return { sender: "user", body, messageId };
}

describe("createRoomHistoryTracker — admitted inputs", () => {
  it("omits the admitted input before settlement while retaining ambient history and retry context", () => {
    const tracker = createRoomHistoryTracker();
    tracker.recordPending(ROOM, entry("before", "$before"));
    const first = tracker.prepareTrigger(AGENT, ROOM, 100, entry("first", "$first"));
    tracker.consumeTriggerInput(AGENT, ROOM, first, "$first");
    tracker.recordPending(ROOM, entry("after", "$after"));

    const retried = tracker.prepareTrigger(AGENT, ROOM, 100, entry("first", "$first"));
    expect(retried).toBe(first);
    expect(retried.history.map((item) => item.body)).toEqual(["before"]);
    const next = tracker.prepareTrigger(AGENT, ROOM, 100, entry("next", "$next"));
    expect(next.history.map((item) => item.body)).toEqual(["before", "after"]);
    const other = tracker.prepareTrigger("other", ROOM, 100, entry("other trigger", "$other"));
    expect(other.history.map((item) => item.body)).toEqual(["before", "first", "after", "next"]);
  });

  it("does not consume a different message at the selected position", () => {
    const tracker = createRoomHistoryTracker();
    const snapshot = tracker.prepareTrigger(AGENT, ROOM, 100, entry("current", "$current"));
    tracker.consumeTriggerInput(AGENT, ROOM, snapshot, "$wrong");
    const next = tracker.prepareTrigger(AGENT, ROOM, 100, entry("next", "$next"));
    expect(next.history.map((item) => item.body)).toEqual(["current"]);
  });

  it("does not consume a replacement row after the selected input is trimmed", () => {
    const tracker = createRoomHistoryTracker(1);
    const snapshot = tracker.prepareTrigger(AGENT, ROOM, 100, entry("old", "$same"));
    tracker.recordPending(ROOM, entry("fresh", "$same"));
    tracker.consumeTriggerInput(AGENT, ROOM, snapshot, "$same");
    const next = tracker.prepareTrigger(AGENT, ROOM, 100, entry("next", "$next"));
    expect(next.history.map((item) => item.body)).toEqual(["fresh"]);
  });

  it("does not consume a recreated queue with the same input id and position", () => {
    const tracker = createRoomHistoryTracker(200, 1);
    const snapshot = tracker.prepareTrigger(AGENT, ROOM, 100, entry("old", "$same"));
    tracker.recordPending("!other:test", entry("evict old room"));
    tracker.prepareTrigger(AGENT, ROOM, 100, entry("fresh", "$same"));
    tracker.consumeTriggerInput(AGENT, ROOM, snapshot, "$same");
    const next = tracker.prepareTrigger(AGENT, ROOM, 100, entry("next", "$next"));
    expect(next.history.map((item) => item.body)).toEqual(["fresh"]);
  });

  it("keeps admission local to its thread and agent", () => {
    const tracker = createRoomHistoryTracker();
    const main = tracker.prepareTrigger(AGENT, ROOM, 100, entry("main input", "$same"));
    const thread = tracker.prepareTrigger(
      AGENT,
      ROOM,
      100,
      entry("thread input", "$same"),
      "$thread",
    );
    tracker.consumeTriggerInput(AGENT, ROOM, main, "$same", "$thread");
    tracker.consumeTriggerInput(AGENT, ROOM, thread, "$same", "$missing");
    expect(
      tracker
        .prepareTrigger("other", ROOM, 100, entry("observer", "$observer"), "$thread")
        .history.map((item) => item.body),
    ).toEqual(["thread input"]);
    tracker.consumeTriggerInput(AGENT, ROOM, thread, "$same", "$thread");
    expect(
      tracker
        .prepareTrigger(AGENT, ROOM, 100, entry("next", "$next"), "$thread")
        .history.map((item) => item.body),
    ).toEqual(["observer"]);
    expect(
      tracker
        .prepareTrigger(AGENT, ROOM, 100, entry("main next", "$main-next"))
        .history.map((item) => item.body),
    ).toEqual(["main input"]);
  });

  it("does not consume an unresolved reserved input", () => {
    const tracker = createRoomHistoryTracker();
    const reserved = tracker.reservePending(AGENT, ROOM, entry("placeholder", "$audio"));
    tracker.consumeTriggerInput(AGENT, ROOM, reserved, "$audio");
    tracker.finalizePending(ROOM, reserved, entry("audio transcript", "$audio"));
    const next = tracker.prepareTrigger(AGENT, ROOM, 100, entry("next", "$next"));
    expect(next.history.map((item) => item.body)).toEqual(["audio transcript"]);
  });
});
function createTracker(...limits: Parameters<typeof createRoomHistoryTracker>) {
  const tracker = createRoomHistoryTracker(...limits);
  function room(roomId = ROOM) {
    return {
      record: (body: string, messageId?: string, thread?: string) =>
        tracker.recordPending(roomId, entry(body, messageId), thread),
      reserve: (body: string, messageId?: string, thread?: string) =>
        tracker.reservePending(AGENT, roomId, entry(body, messageId), thread),
      prepare: (body: string, messageId?: string, thread?: string, slot?: ReservedHistorySlot) =>
        tracker.prepareTrigger(AGENT, roomId, 100, entry(body, messageId), thread, slot),
      history: (body: string, messageId?: string, thread?: string, slot?: ReservedHistorySlot) =>
        tracker
          .prepareTrigger(AGENT, roomId, 100, entry(body, messageId), thread, slot)
          .history.map(({ body: entryBody }) => entryBody),
      consume: (
        snapshot: Parameters<typeof tracker.consumeHistory>[2],
        messageId?: string,
        thread?: string,
      ) => tracker.consumeHistory(AGENT, roomId, snapshot, messageId, thread),
      finalize: (slot: ReservedHistorySlot, body: string, messageId?: string) =>
        tracker.finalizePending(roomId, slot, entry(body, messageId)),
      discard: (slot: ReservedHistorySlot) => tracker.discardPending(roomId, slot),
    };
  }
  return { ...room(), room };
}

describe("createRoomHistoryTracker — watermark monotonicity", () => {
  it("consumeHistory is monotone: out-of-order completion does not regress the watermark", () => {
    const tracker = createTracker();
    tracker.record("msg1");
    tracker.record("msg2");
    const snap1 = tracker.prepare("trigger1");
    tracker.record("msg3");
    const snap2 = tracker.prepare("trigger2");
    tracker.consume(snap2);
    tracker.consume(snap1);
    tracker.record("msg4");
    expect(tracker.history("trigger3")).toEqual(["msg4"]);
  });

  it("reserved pending slots are finalized in arrival order", () => {
    const tracker = createTracker();
    const reserved = tracker.reserve("audio placeholder", "$audio");
    tracker.record("after", "$after");
    tracker.finalize(reserved, "audio final", "$audio");
    expect(tracker.history("trigger")).toEqual(["audio final", "after"]);
  });

  it("discarded reserved slots do not leak into later history", () => {
    const tracker = createTracker();
    const reserved = tracker.reserve("blocked audio", "$blocked");
    tracker.discard(reserved);
    tracker.record("after", "$after");
    expect(tracker.history("trigger", "$trigger")).toEqual(["after"]);
  });

  it("reserved triggers use the arrival-time watermark even if a later trigger consumes history", () => {
    const tracker = createTracker();
    tracker.record("before", "$before");
    const reserved = tracker.reserve("audio placeholder", "$audio");
    const later = tracker.prepare("later trigger", "$later");
    tracker.consume(later, "$later");
    expect(tracker.history("audio trigger", "$audio", undefined, reserved)).toEqual(["before"]);
  });

  it("does not let later triggers consume unfinalized reserved slots", () => {
    const tracker = createTracker();
    const reserved = tracker.reserve("audio placeholder", "$audio");
    const later = tracker.prepare("later trigger", "$later");
    tracker.consume(later, "$later");
    tracker.finalize(reserved, "audio transcript", "$audio");
    expect(tracker.history("follow up", "$follow-up")).toEqual(["audio transcript"]);
  });

  it("reserved trigger retries discard the extra placeholder slot", () => {
    const tracker = createTracker();
    tracker.record("before", "$before");
    const firstReserved = tracker.reserve("audio placeholder", "$audio");
    const firstPrepared = tracker.prepare("audio trigger", "$audio", undefined, firstReserved);
    const retryReserved = tracker.reserve("audio placeholder retry", "$audio");
    const retried = tracker.prepare("audio trigger", "$audio", undefined, retryReserved);
    tracker.consume(retried, "$audio");
    expect(retried.snapshotIdx).toBe(firstPrepared.snapshotIdx);
    expect(tracker.history("follow up")).toEqual([]);
  });

  it("advances watermarks independently per thread", () => {
    const tracker = createTracker();
    tracker.record("thread-a-1", undefined, "$thread-a");
    tracker.record("thread-b-1", undefined, "$thread-b");
    const snapA = tracker.prepare("trigger-a", undefined, "$thread-a");
    tracker.consume(snapA, undefined, "$thread-a");
    expect(tracker.history("follow-up-a", undefined, "$thread-a")).toEqual([]);
    expect(tracker.history("follow-up-b", undefined, "$thread-b")).toEqual(["thread-b-1"]);
  });

  it("reserved thread triggers keep the thread arrival-order history window", () => {
    const tracker = createTracker();
    tracker.record("main-before");
    tracker.record("thread-before", undefined, "$thread");
    const reserved = tracker.reserve("audio placeholder", "$audio", "$thread");
    tracker.record("thread-after", undefined, "$thread");
    tracker.record("main-after");
    expect(tracker.history("audio trigger", "$audio", "$thread", reserved)).toEqual([
      "thread-before",
    ]);
  });

  it("refreshes watermark recency before capped-map eviction", () => {
    const tracker = createTracker(200, 10, 2);
    const room1 = tracker.room("!room1:test");
    const room2 = tracker.room("!room2:test");
    const room3 = tracker.room("!room3:test");
    room1.record("old msg in room1");
    const snap1 = room1.prepare("trigger in room1");
    room1.consume(snap1);
    room2.record("old msg in room2");
    const snap2 = room2.prepare("trigger in room2");
    room2.consume(snap2);

    // Refresh room1 so room2 becomes the stalest watermark entry.
    room1.consume(snap1);
    room3.record("old msg in room3");
    const snap3 = room3.prepare("trigger in room3");
    room3.consume(snap3);
    room1.record("new msg in room1");
    expect(room1.history("next trigger")).toEqual(["new msg in room1"]);
  });

  it("refreshes prepared-trigger recency before capped eviction on retry hits", () => {
    const tracker = createTracker(200, 10, 5000, 2);
    const room1 = tracker.room("!room1:test");
    room1.prepare("trigger1", "$trigger1");
    room1.prepare("trigger2", "$trigger2");

    // Retry hit should refresh trigger1 so trigger2 becomes the stale entry.
    const retried = room1.prepare("trigger1", "$trigger1");
    room1.prepare("trigger3", "$trigger3");
    const reused = room1.prepare("trigger1", "$trigger1");
    expect(reused.snapshotIdx).toBe(retried.snapshotIdx);
  });
});

describe("createRoomHistoryTracker — roomQueues eviction", () => {
  it.each([false, true])(
    "keeps recreated rooms free of stale watermarks (late completion: %s)",
    (late) => {
      const tracker = createTracker(200, 1);
      const room1 = tracker.room("!room1:test");
      const room2 = tracker.room("!room2:test");
      room1.record("old msg in room1");
      const prepared = room1.prepare("trigger in room1", late ? "$trigger" : undefined);
      if (!late) {
        room1.consume(prepared);
      }
      // A late completion must not recreate the watermark after this eviction.
      room2.record("msg in room2");
      if (late) {
        room1.consume(prepared, "$trigger");
      }
      room1.record("new msg in room1");
      expect(room1.history("new trigger")).toEqual(["new msg in room1"]);
    },
  );
});
