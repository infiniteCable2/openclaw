import { describe, expect, it, vi } from "vitest";
import type { TalkEventInput } from "../talk-events.js";
import { createSpeechActivity } from "./activity.js";

function fixture() {
  const events: TalkEventInput[] = [];
  let generation = 1;
  const getGeneration = vi.fn(() => generation);
  const activity = createSpeechActivity({
    emit: (event) => {
      events.push(event);
    },
    getGeneration,
  });
  const snapshot = () => events.findLast((event) => event.type === "session.activity");
  const outcomes = (scope: "capture" | "utterance") =>
    events.filter(
      (event) =>
        event.type === "input.outcome" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        "scope" in event.payload &&
        event.payload.scope === scope,
    );
  return {
    activity,
    events,
    snapshot,
    outcomes,
    getGeneration,
    nextGeneration: () => ++generation,
  };
}

describe("native speech activity observation", () => {
  it("projects media availability separately from connection, work and output state", () => {
    const f = fixture();
    f.activity.inputAvailable(true);
    expect(f.snapshot()).toMatchObject({
      payload: { connection: "preparing", input: { available: false } },
    });
    f.activity.connection("ready");
    expect(f.snapshot()).toMatchObject({ payload: { input: { available: true } } });
    f.activity.inputAvailable(false);
    f.activity.output(1, "submitted", "speech");
    expect(f.snapshot()).toMatchObject({
      payload: { input: { available: false }, output: { state: "submitted" } },
    });
    const before = f.events.length;
    f.activity.inputAvailable(false);
    expect(f.events).toHaveLength(before);
    f.activity.inputAvailable(true);
    expect(f.events).toHaveLength(before + 1);
    expect(f.snapshot()).toMatchObject({ payload: { input: { available: true } } });
    f.activity.close();
    expect(f.snapshot()).toMatchObject({
      payload: { connection: "closed", input: { available: false } },
    });
    const closed = f.events.length;
    f.activity.inputAvailable(true);
    f.activity.connection("ready");
    expect(f.events).toHaveLength(closed);
  });

  it("starts without callbacks and forces initial publication while coalescing PCM observations", () => {
    const f = fixture();
    expect(f.events).toEqual([]);
    expect(f.getGeneration).not.toHaveBeenCalled();
    f.activity.publish();
    expect(f.snapshot()).toEqual({
      type: "session.activity",
      payload: {
        version: 1,
        connection: "preparing",
        input: { phase: "listening", available: false, pending: 0 },
        work: { pending: 0, queued: 0, running: 0 },
        output: { generation: 1, state: "idle" },
      },
    });
    f.activity.connection("ready");
    f.activity.captureStarted("capture-a");
    f.activity.audio("capture-a");
    const before = f.events.length;
    const reads = f.getGeneration.mock.calls.length;
    f.activity.audio("capture-a");
    f.activity.connection("ready");
    expect(f.events).toHaveLength(before);
    expect(f.getGeneration).toHaveBeenCalledTimes(reads);
    f.activity.publish();
    expect(f.events).toHaveLength(before + 1);
    expect(f.snapshot()).toMatchObject({
      payload: { connection: "ready", input: { phase: "receiving" } },
    });
  });

  it("always pairs an exact quiet capture outcome with a forced newer snapshot", () => {
    const f = fixture();
    f.activity.captureStarted("capture-empty");
    const before = f.events.length;
    f.activity.captureEnded("capture-empty", { activity: "none" });
    expect(f.events.slice(before)).toEqual([
      {
        type: "input.outcome",
        captureId: "capture-empty",
        final: true,
        payload: { version: 1, scope: "capture", outcome: "no-input" },
      },
      {
        type: "session.activity",
        payload: {
          version: 1,
          connection: "preparing",
          input: { phase: "listening", available: false, captureId: "capture-empty", pending: 0 },
          work: { pending: 0, queued: 0, running: 0 },
          output: { generation: 1, state: "idle" },
        },
      },
    ]);
    f.activity.captureEnded("capture-empty", { activity: "none" });
    expect(f.events).toHaveLength(before + 2);
  });

  it("keeps unproved legacy and observed-only boundaries unknown", () => {
    const f = fixture();
    for (const [id, evidence] of [
      ["legacy", undefined],
      ["observed", { activity: "observed" as const }],
    ] as const) {
      f.activity.captureStarted(id);
      f.activity.captureEnded(id, evidence);
      expect(f.outcomes("capture").at(-1)).toMatchObject({
        captureId: id,
        payload: { outcome: "unknown" },
      });
      expect(f.snapshot()).toMatchObject({ payload: { input: { phase: "unknown", pending: 0 } } });
    }
  });

  it("waits for its own utterance after explicit end and treats sustained energy as candidate", () => {
    const f = fixture();
    f.activity.captureStarted("capture-recognized");
    f.activity.speechActivity({ utteranceId: "utterance-a", state: "candidate" });
    f.activity.speechActivity({ utteranceId: "utterance-a", state: "sustained" });
    expect(f.snapshot()).toMatchObject({ payload: { input: { phase: "candidate", pending: 1 } } });
    f.activity.processing({ utteranceId: "utterance-a", state: "started" });
    expect(f.snapshot()).toMatchObject({ payload: { input: { phase: "transcribing" } } });
    f.activity.processing({ utteranceId: "utterance-a", state: "speech-confirmed" });
    expect(f.snapshot()).toMatchObject({ payload: { input: { phase: "speech", pending: 1 } } });
    f.activity.captureEnded("capture-recognized", { activity: "observed" });
    f.activity.transcript("utterance-a");
    expect(f.outcomes("capture")).toEqual([]);
    expect(f.outcomes("utterance")).toEqual([]);
    f.activity.processing({ utteranceId: "utterance-a", state: "transcribed" });
    expect(f.outcomes("utterance")).toEqual([
      {
        type: "input.outcome",
        captureId: "capture-recognized",
        final: true,
        payload: {
          version: 1,
          scope: "utterance",
          utteranceId: "utterance-a",
          outcome: "transcribed",
        },
      },
    ]);
    const terminal = f.outcomes("capture")[0];
    expect(terminal).toMatchObject({
      captureId: "capture-recognized",
      payload: { outcome: "transcribed" },
    });
    expect(f.events.at(-2)).toBe(terminal);
    expect(f.events.at(-1)).toMatchObject({
      type: "session.activity",
      payload: { input: { phase: "listening", pending: 0 } },
    });
    const before = f.events.length;
    f.activity.processing({ utteranceId: "utterance-a", state: "cancelled" });
    f.activity.speechActivity({ utteranceId: "utterance-a", state: "candidate" });
    expect(f.events).toHaveLength(before);
  });

  it.each(["empty", "failed", "cancelled"] as const)(
    "settles %s only after every own utterance finishes",
    (state) => {
      const f = fixture();
      f.activity.captureStarted("capture-two");
      f.activity.processing({ utteranceId: "first", state: "started" });
      f.activity.processing({ utteranceId: "second", state: "started" });
      f.activity.processing({ utteranceId: "first", state });
      f.activity.captureEnded("capture-two", { activity: "observed" });
      expect(f.outcomes("capture")).toEqual([]);
      f.activity.processing({ utteranceId: "second", state });
      expect(f.outcomes("capture")).toHaveLength(1);
      expect(f.outcomes("capture")[0]).toMatchObject({
        payload: { outcome: state === "empty" ? "rejected" : state },
      });
      expect(f.snapshot()).toMatchObject({
        payload: { input: { phase: "listening", pending: 0 } },
      });
    },
  );

  it("never turns contradictory none evidence into no-input or resets a newer capture", () => {
    const f = fixture();
    f.activity.captureStarted("capture-old");
    f.activity.speechActivity({ utteranceId: "old", state: "candidate" });
    f.activity.captureStarted("capture-new");
    f.activity.audio("capture-new");
    f.activity.captureEnded("capture-old", { activity: "none" });
    expect(f.outcomes("capture")).toEqual([]);
    f.activity.speechActivity({ utteranceId: "old", state: "rejected" });
    expect(f.outcomes("capture")[0]).toMatchObject({
      captureId: "capture-old",
      payload: { outcome: "rejected" },
    });
    expect(f.snapshot()).toMatchObject({
      payload: { input: { phase: "receiving", captureId: "capture-new", pending: 0 } },
    });
  });

  it("does not invent a pending utterance for legacy text or start model work from recognition", () => {
    const f = fixture();
    f.activity.captureStarted("capture-legacy-text");
    f.activity.transcript();
    f.activity.captureEnded("capture-legacy-text");
    expect(f.outcomes("utterance")).toEqual([]);
    expect(f.outcomes("capture")[0]).toMatchObject({ payload: { outcome: "transcribed" } });
    expect(f.snapshot()).toMatchObject({
      payload: { input: { pending: 0 }, work: { pending: 0, queued: 0, running: 0 } },
    });
  });

  it("deduplicates actual run IDs and keeps legacy activity pending until its real callback settles", () => {
    const f = fixture();
    f.activity.work({ inputId: "pending", phase: "pending" });
    f.activity.work({ inputId: "queued", phase: "queued" });
    f.activity.work({ inputId: "one", phase: "running", runId: "run-one" });
    f.activity.work({ inputId: "two", phase: "running", runId: "run-one" });
    f.activity.work({ inputId: "missing-run", phase: "running" });
    f.activity.legacyWork({ queued: 2, active: true });
    expect(f.snapshot()).toMatchObject({
      payload: { work: { pending: 2, queued: 3, running: 1 } },
    });
    f.activity.captureStarted("quiet");
    f.activity.captureEnded("quiet", { activity: "none" });
    expect(f.snapshot()).toMatchObject({
      payload: { work: { pending: 2, queued: 3, running: 1 } },
    });
    f.activity.work({ inputId: "one", phase: "settled", runId: "other-run" });
    expect(f.snapshot()).toMatchObject({ payload: { work: { running: 1 } } });
    f.activity.work({ inputId: "one", phase: "settled", runId: "run-one" });
    f.activity.work({ inputId: "two", phase: "settled", runId: "run-one" });
    f.activity.legacyWork({ queued: 0, active: false });
    expect(f.snapshot()).toMatchObject({
      payload: { work: { pending: 1, queued: 1, running: 0 } },
    });
  });

  it("waiting submission reveals pending speech and never erases a real stream", () => {
    const f = fixture();
    f.activity.output(1, "preparing", "speech");
    f.activity.output(1, "streaming", "waiting");
    f.activity.output(1, "submitted", "waiting");
    expect(f.snapshot()).toMatchObject({
      payload: { output: { state: "preparing", purpose: "speech" } },
    });
    f.activity.output(1, "streaming", "speech");
    f.activity.output(1, "preparing", "speech");
    expect(f.snapshot()).toMatchObject({
      payload: { output: { state: "streaming", purpose: "speech" } },
    });
    f.activity.output(1, "submitted", "greeting");
    f.activity.output(1, "streaming", "waiting");
    f.activity.output(1, "submitted", "speech");
    expect(f.snapshot()).toMatchObject({
      payload: { output: { state: "streaming", purpose: "waiting" } },
    });
    f.activity.output(1, "submitted", "waiting");
    expect(f.snapshot()).toMatchObject({ payload: { output: { state: "submitted" } } });
  });

  it("fences old output generations and announces new-generation idle", () => {
    const f = fixture();
    f.activity.output(1, "streaming", "speech");
    f.nextGeneration();
    f.activity.output(2, "idle");
    expect(f.snapshot()).toMatchObject({ payload: { output: { generation: 2, state: "idle" } } });
    const before = f.events.length;
    f.activity.output(1, "streaming", "waiting");
    f.activity.output(1, "submitted", "speech");
    expect(f.events).toHaveLength(before);
  });

  it("bounds settled tombstones while retaining older inflight captures and utterances", () => {
    const f = fixture();
    f.activity.captureStarted("inflight");
    f.activity.processing({ utteranceId: "still-running", state: "started" });
    for (let index = 0; index < 70; index++) {
      f.activity.captureStarted(`capture-${index}`);
      f.activity.speechActivity({ utteranceId: `utterance-${index}`, state: "rejected" });
      f.activity.captureEnded(`capture-${index}`, { activity: "observed" });
    }
    f.activity.captureEnded("inflight", { activity: "observed" });
    f.activity.processing({ utteranceId: "still-running", state: "cancelled" });
    expect(f.outcomes("capture").at(-1)).toMatchObject({
      captureId: "inflight",
      payload: { outcome: "cancelled" },
    });
    const before = f.outcomes("capture").length;
    f.activity.captureStarted("capture-69");
    f.activity.captureEnded("capture-69", { activity: "none" });
    expect(f.outcomes("capture")).toHaveLength(before);
    f.activity.captureStarted("capture-0");
    f.activity.speechActivity({ utteranceId: "utterance-0", state: "rejected" });
    f.activity.captureEnded("capture-0", { activity: "observed" });
    expect(f.outcomes("capture")).toHaveLength(before + 1);
  });

  it("closes once and suppresses late provider, work and output callbacks", () => {
    const f = fixture();
    f.activity.captureStarted("closing");
    f.activity.processing({ utteranceId: "decoding", state: "started" });
    f.activity.captureEnded("closing", { activity: "observed" });
    f.activity.legacyWork({ queued: 2, active: true });
    f.activity.close();
    expect(f.outcomes("capture")[0]).toMatchObject({ payload: { outcome: "cancelled" } });
    expect(f.snapshot()).toMatchObject({
      payload: {
        connection: "closed",
        input: { pending: 0 },
        work: { pending: 0, queued: 0, running: 0 },
        output: { state: "idle" },
      },
    });
    const before = f.events.length;
    f.activity.publish();
    f.activity.connection("ready");
    f.activity.captureStarted("late");
    f.activity.processing({ utteranceId: "decoding", state: "transcribed" });
    f.activity.legacyWork({ queued: 10, active: true });
    f.activity.work({ inputId: "late", phase: "pending" });
    f.activity.output(1, "streaming", "speech");
    f.activity.close();
    expect(f.events).toHaveLength(before);
  });

  it.each(["sync", "async"] as const)("keeps %s delivery failures observational", async (kind) => {
    const activity = createSpeechActivity({
      getGeneration: () => 1,
      emit: () => {
        if (kind === "sync") {
          throw new Error("Synthetic delivery failure");
        }
        return Promise.reject(new Error("Synthetic delivery failure"));
      },
    });
    expect(() => {
      activity.publish();
      activity.captureStarted("quiet");
      activity.captureEnded("quiet", { activity: "none" });
      activity.close();
    }).not.toThrow();
    await Promise.resolve();
  });
});
