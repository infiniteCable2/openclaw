import type { RealtimeTranscriptionSessionCallbacks } from "../../realtime-transcription/provider-types.js";
import type { TalkEventInput } from "../talk-events.js";

type Outcome = "no-input" | "rejected" | "transcribed" | "failed" | "cancelled" | "unknown";
type InputPhase = "listening" | "receiving" | "candidate" | "speech" | "transcribing" | "unknown";
type Capture = {
  id: string;
  ended: boolean;
  audio: boolean;
  observed: boolean;
  evidence?: { activity: "none" | "observed" };
  outcomes: Set<Outcome>;
  pending: Set<string>;
  outcome?: Outcome;
};
type Utterance = { id: string; capture: Capture; phase: InputPhase; processing: boolean };
type Work = {
  inputId: string;
  phase: "pending" | "queued" | "running" | "settled";
  runId?: string;
};
type Output = {
  generation: number;
  state: "idle" | "preparing" | "streaming" | "submitted";
  purpose?: "speech" | "waiting" | "greeting";
};
type Purpose = NonNullable<Output["purpose"]>;

/** Projects existing owner callbacks only; never admits, schedules or cancels their work. */
export function createSpeechActivity(params: {
  emit: (event: TalkEventInput) => void | Promise<void>;
  getGeneration: () => number;
}) {
  let connection: "preparing" | "ready" | "closed" = "preparing";
  let closed = false;
  let inputAvailable = false;
  let current: Capture | undefined;
  let previousSnapshot: string | undefined;
  let outputGeneration = 0;
  let outputOrdinal = 0;
  const outputFacts = new Map<Purpose, { state: Output["state"]; ordinal: number }>();
  let legacyQueued = 0;
  let legacyActive = false;
  const captures = new Map<string, Capture>();
  const utterances = new Map<string, Utterance>();
  const settledCaptures = new Set<string>();
  const settledUtterances = new Set<string>();
  const settledWork = new Set<string>();
  const work = new Map<string, Work>();
  const remember = (set: Set<string>, id: string) => {
    set.add(id);
    while (set.size > 64) {
      set.delete(set.values().next().value!);
    }
  };
  const generation = () => {
    try {
      const value = params.getGeneration();
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const emit = (event: TalkEventInput) => {
    try {
      void Promise.resolve(params.emit(event)).catch(() => {});
    } catch {
      // Observations must not fail admission, decoding, native work or output.
    }
  };
  const projectOutput = (value: number): Output => {
    if (value === outputGeneration) {
      for (const state of ["streaming", "preparing", "submitted"] as const) {
        const latest = [...outputFacts]
          .filter(([, fact]) => fact.state === state)
          .toSorted((a, b) => b[1].ordinal - a[1].ordinal)[0];
        if (latest) {
          return { generation: value, state, purpose: latest[0] };
        }
      }
    }
    return { generation: value, state: "idle" };
  };
  const publish = (force = false) => {
    const value = generation();
    if (value === undefined) {
      return;
    }
    const pending = current && [...current.pending].map((id) => utterances.get(id)).filter(Boolean);
    const latest = pending?.at(-1);
    const phase =
      latest?.phase ??
      (current?.outcome === "unknown"
        ? "unknown"
        : current && !current.ended && current.audio
          ? "receiving"
          : "listening");
    const records = [...work.values()];
    const payload = {
      version: 1,
      connection,
      input: {
        phase,
        available: connection === "ready" && inputAvailable,
        ...(current ? { captureId: current.id } : {}),
        ...(latest ? { utteranceId: latest.id } : {}),
        pending: utterances.size,
      },
      work: {
        pending:
          records.filter((record) => record.phase === "pending").length + Number(legacyActive),
        queued: Math.min(
          Number.MAX_SAFE_INTEGER,
          records.filter((record) => record.phase === "queued").length + legacyQueued,
        ),
        running: new Set(
          records.filter((record) => record.phase === "running").map((record) => record.runId),
        ).size,
      },
      output: projectOutput(value),
    };
    const encoded = JSON.stringify(payload);
    if (force || encoded !== previousSnapshot) {
      previousSnapshot = encoded;
      emit({ type: "session.activity", payload });
    }
  };
  const outcome = (capture: Capture, value: Outcome, utteranceId?: string) => {
    emit({
      type: "input.outcome",
      captureId: capture.id,
      final: true,
      payload: {
        version: 1,
        scope: utteranceId ? "utterance" : "capture",
        outcome: value,
        ...(utteranceId ? { utteranceId } : {}),
      },
    });
  };
  const settleCapture = (capture: Capture) => {
    if (!capture.ended || capture.pending.size || capture.outcome) {
      return false;
    }
    const summary =
      (["transcribed", "failed", "cancelled", "rejected"] as const).find((value) =>
        capture.outcomes.has(value),
      ) ?? (capture.evidence?.activity === "none" && !capture.observed ? "no-input" : "unknown");
    capture.outcome = summary;
    captures.delete(capture.id);
    remember(settledCaptures, capture.id);
    outcome(capture, summary);
    publish(true);
    return true;
  };
  const getUtterance = (id: string) => {
    const existing = utterances.get(id);
    if (existing || settledUtterances.has(id)) {
      return existing;
    }
    if (!current || current.ended) {
      return undefined;
    }
    const value: Utterance = { id, capture: current, phase: "candidate", processing: false };
    current.observed = true;
    current.pending.add(id);
    utterances.set(id, value);
    return value;
  };
  const settleUtterance = (value: Utterance, result: Outcome) => {
    utterances.delete(value.id);
    remember(settledUtterances, value.id);
    value.capture.pending.delete(value.id);
    value.capture.outcomes.add(result);
    outcome(value.capture, result, value.id);
    if (!settleCapture(value.capture)) {
      publish();
    }
  };
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    connection = "closed";
    work.clear();
    legacyQueued = 0;
    legacyActive = false;
    outputFacts.clear();
    outputGeneration = generation() ?? outputGeneration;
    for (const value of utterances.values()) {
      settleUtterance(value, "cancelled");
    }
    captures.clear();
    current = undefined;
    publish(true);
  };

  return {
    publish: () => {
      if (!closed) {
        publish(true);
      }
    },
    connection: (state: "preparing" | "ready" | "closed") => {
      if (state === "closed") {
        close();
      } else if (!closed && state !== connection) {
        connection = state;
        publish();
      }
    },
    inputAvailable: (available: boolean) => {
      if (!closed && inputAvailable !== available) {
        inputAvailable = available;
        publish();
      }
    },
    captureStarted: (id: string) => {
      if (closed || settledCaptures.has(id)) {
        return;
      }
      let capture = captures.get(id);
      if (!capture) {
        capture = {
          id,
          ended: false,
          audio: false,
          observed: false,
          outcomes: new Set(),
          pending: new Set(),
        };
        captures.set(id, capture);
      }
      current = capture;
      publish();
    },
    audio: (id: string) => {
      const capture = captures.get(id);
      if (closed || !capture || capture.ended || capture.audio) {
        return;
      }
      capture.audio = true;
      publish();
    },
    speechActivity: (
      event: Parameters<NonNullable<RealtimeTranscriptionSessionCallbacks["onSpeechActivity"]>>[0],
    ) => {
      if (closed) {
        return;
      }
      const value = getUtterance(event.utteranceId);
      if (!value) {
        return;
      }
      if (event.state === "rejected") {
        settleUtterance(value, "rejected");
      } else {
        // Sustained energy remains reversible candidate evidence.
        publish();
      }
    },
    processing: (
      event: Parameters<NonNullable<RealtimeTranscriptionSessionCallbacks["onProcessing"]>>[0],
    ) => {
      if (closed) {
        return;
      }
      const value = getUtterance(event.utteranceId);
      if (!value) {
        return;
      }
      if (event.state === "started" || event.state === "speech-confirmed") {
        value.processing = true;
        value.phase = event.state === "speech-confirmed" ? "speech" : "transcribing";
        publish();
      } else {
        settleUtterance(value, event.state === "empty" ? "rejected" : event.state);
      }
    },
    transcript: (utteranceId?: string) => {
      if (closed) {
        return;
      }
      const value = utteranceId ? getUtterance(utteranceId) : undefined;
      const capture =
        value?.capture ?? (utteranceId && settledUtterances.has(utteranceId) ? undefined : current);
      if (!capture || capture.outcome) {
        return;
      }
      capture.outcomes.add("transcribed");
      if (value && !value.processing) {
        settleUtterance(value, "transcribed");
      } else if (!settleCapture(capture)) {
        publish();
      }
    },
    captureEnded: (id: string, evidence?: { activity: "none" | "observed" }, failure?: boolean) => {
      const capture = captures.get(id);
      if (closed || !capture || capture.ended) {
        return;
      }
      capture.ended = true;
      capture.evidence = evidence;
      if (failure) {
        capture.outcomes.add("failed");
      }
      if (!settleCapture(capture)) {
        publish();
      }
    },
    work: (event: Work) => {
      if (closed || settledWork.has(event.inputId)) {
        return;
      }
      const existing = work.get(event.inputId);
      if (event.phase === "settled") {
        if (event.runId && existing?.runId && event.runId !== existing.runId) {
          return;
        }
        work.delete(event.inputId);
        remember(settledWork, event.inputId);
      } else {
        if (
          (event.phase === "running" && !event.runId) ||
          (existing?.phase === "running" && event.phase !== "running")
        ) {
          return;
        }
        work.set(event.inputId, { ...event });
      }
      publish();
    },
    legacyWork: (event: { queued: number; active: boolean }) => {
      if (
        closed ||
        !Number.isSafeInteger(event.queued) ||
        event.queued < 0 ||
        (legacyQueued === event.queued && legacyActive === event.active)
      ) {
        return;
      }
      legacyQueued = event.queued;
      legacyActive = event.active;
      publish();
    },
    output: (value: number, state: Output["state"], purpose?: Output["purpose"]) => {
      if (closed || value !== generation()) {
        return;
      }
      if (value !== outputGeneration) {
        outputFacts.clear();
        outputGeneration = value;
        outputOrdinal = 0;
      }
      const key = purpose ?? "speech";
      if (state === "idle") {
        if (purpose) {
          outputFacts.delete(purpose);
        } else {
          outputFacts.clear();
        }
      } else {
        const previous = outputFacts.get(key);
        if (
          (state === "preparing" && previous?.state === "streaming") ||
          (state === "submitted" && key !== "speech" && !previous)
        ) {
          return;
        }
        outputFacts.set(key, { state, ordinal: ++outputOrdinal });
      }
      publish();
    },
    close,
  };
}
