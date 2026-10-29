import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { LruCache } from "../../infra/lru-cache.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
  TranscriptEvent,
} from "./session-accessor.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionTranscriptWatermark } from "./session-history-read.types.js";
import { createTranscriptRawDeltaCursor } from "./session-transcript-raw-cursor.js";

type Boundary = { generation: string; maxSeq: number; tailId?: string };
type Snapshot = Boundary & { events: readonly TranscriptEvent[]; bytes: number };
type ContinuationState = { snapshot: Snapshot };
const resultSnapshots = new WeakMap<readonly TranscriptEvent[], Snapshot>();
const continuationStates = new WeakMap<
  ConversationKnowledgeRootContinuation,
  { key: string; state: ContinuationState }
>();

/** Receipt metadata only; its existing live root owner determines retention, never read authority. */
export class ConversationKnowledgeRootContinuation {
  #active = true;
  get retainedBytes(): number {
    return continuationStates.get(this)?.state.snapshot.bytes ?? 0;
  }
  release(): void {
    this.#active = false;
    continuationStates.delete(this);
  }
  assertCurrent(): void {
    if (!this.#active) {
      throw new Error("Root continuation owner has closed");
    }
  }
}

/** Only arrays returned by this native reader can expose an immutable shared snapshot. */
export function readConversationKnowledgeRootSnapshot(events: readonly TranscriptEvent[]) {
  return resultSnapshots.get(events);
}
type RootCacheRead = {
  source: CapturedSessionEntryReadSource;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  customTypes: readonly string[];
  watermark(): Promise<SessionTranscriptWatermark>;
  raw(limits: SessionTranscriptRawDeltaLimits): Promise<SessionTranscriptRawDeltaResult>;
  full(through: SessionTranscriptWatermark): Promise<TranscriptEvent[]>;
  assertCurrent(): void;
  revalidate(): Promise<void>;
  continuation?: ConversationKnowledgeRootContinuation;
};

function freezeJson(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    freezeJson(child);
  }
  Object.freeze(value);
}

/** Disposable receipt metadata only. Current caller authority remains mandatory on every read. */
export class ConversationKnowledgeRootCache {
  readonly #cache: LruCache<Snapshot>;
  readonly #live = new Map<string, WeakRef<ContinuationState>>();

  constructor(maxBytes = 8 * 1024 * 1024) {
    this.#cache = new LruCache(16, { maxBytes, sizeOf: (snapshot) => snapshot.bytes });
  }

  async read(params: RootCacheRead): Promise<TranscriptEvent[]> {
    params.assertCurrent();
    params.continuation?.assertCurrent();
    // In-memory owners have no stable cross-reader physical identity; use the native path.
    if (typeof params.source.databaseIdentity !== "string") {
      const events = await params.full(await params.watermark());
      await params.revalidate();
      params.assertCurrent();
      return events;
    }
    const key = JSON.stringify([
      params.source.agentId,
      params.source.path,
      params.source.databaseIdentity,
      params.source.databaseBirthtime,
      params.agentId,
      params.sessionKey,
      params.sessionId,
      params.lifecycleRevision,
      [...params.customTypes].toSorted(),
    ]);
    const through = await params.watermark();
    params.assertCurrent();
    if (!through.generation || through.maxSeq === null) {
      this.#cache.delete(key);
      this.#live.delete(key);
      if (params.continuation) {
        continuationStates.delete(params.continuation);
      }
      await params.revalidate();
      params.assertCurrent();
      return [];
    }
    params.continuation?.assertCurrent();
    const owned = params.continuation && continuationStates.get(params.continuation);
    let state = (owned?.key === key ? owned.state : undefined) ?? this.#live.get(key)?.deref();
    const previous = state?.snapshot ?? this.#cache.get(key);
    let snapshot: Snapshot | undefined;
    if (previous?.generation === through.generation && previous.maxSeq <= through.maxSeq) {
      if (previous.maxSeq === through.maxSeq) {
        snapshot = previous;
      } else {
        const delta = await this.#linearDelta(params, previous, through.maxSeq);
        if (delta) {
          snapshot = {
            ...delta.boundary,
            events: [...previous.events, ...delta.events],
            bytes: previous.bytes + delta.bytes,
          };
        }
      }
    }
    if (!snapshot) {
      this.#cache.delete(key);
      this.#live.delete(key);
      // The exact raw boundary is independent of the filtered active-path report list.
      const boundary = await params.raw({
        cursor: this.#cursor(params, through.generation, through.maxSeq - 1),
        maxEvents: 1,
        maxBytes: 64 * 1024 * 1024,
      });
      params.assertCurrent();
      const last = boundary.kind === "page" ? boundary.events[0] : undefined;
      const lastEvent = asOptionalRecord(last?.event);
      const events = await params.full(through);
      for (const event of events) {
        freezeJson(event);
      }
      snapshot = {
        generation: through.generation,
        maxSeq: through.maxSeq,
        tailId:
          last?.seq === through.maxSeq && typeof lastEvent?.id === "string"
            ? lastEvent.id
            : undefined,
        events,
        bytes: events.reduce<number>(
          (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)),
          0,
        ),
      };
    }
    params.assertCurrent();
    const current = await params.watermark();
    params.assertCurrent();
    if (
      current.generation !== through.generation ||
      current.maxSeq === null ||
      current.maxSeq < through.maxSeq ||
      (current.maxSeq > through.maxSeq &&
        !(await this.#linearDelta(params, snapshot, current.maxSeq)))
    ) {
      this.#cache.delete(key);
      this.#live.delete(key);
      throw new Error("Conversation knowledge root changed during catch-up");
    }
    await params.revalidate();
    params.assertCurrent();
    Object.freeze(snapshot.events);
    Object.freeze(snapshot);
    // A concurrent read may already have published a later validated prefix.
    const concurrentState = this.#live.get(key)?.deref();
    const latest = concurrentState?.snapshot ?? this.#cache.peek(key);
    if (
      snapshot.tailId &&
      (latest?.generation !== snapshot.generation || latest.maxSeq <= snapshot.maxSeq)
    ) {
      this.#cache.set(key, snapshot);
      if (concurrentState || state || params.continuation) {
        state = concurrentState ?? state ?? { snapshot };
        state.snapshot = snapshot;
        this.#live.set(key, new WeakRef(state));
      }
      for (const [oldKey, reference] of this.#live) {
        if (!reference.deref()) {
          this.#live.delete(oldKey);
        }
      }
      while (this.#live.size > 128) {
        this.#live.delete(this.#live.keys().next().value!);
      }
    } else if (concurrentState) {
      state = concurrentState;
    }
    if (state && params.continuation) {
      params.continuation.assertCurrent();
      continuationStates.set(params.continuation, { key, state });
    }
    const result = [...snapshot.events];
    resultSnapshots.set(result, snapshot);
    return result;
  }

  #cursor(params: RootCacheRead, generation: string, lastSeq: number) {
    return createTranscriptRawDeltaCursor({
      agentId: params.agentId,
      sessionId: params.sessionId,
      generation,
      lastSeq,
    });
  }

  async #linearDelta(params: RootCacheRead, from: Boundary, maxSeq: number) {
    if (!from.tailId) {
      return undefined;
    }
    let lastSeq = from.maxSeq;
    let tailId = from.tailId;
    const events: TranscriptEvent[] = [];
    let bytes = 0;
    while (lastSeq < maxSeq) {
      const startSeq = lastSeq;
      params.assertCurrent();
      // Never filter types here: leaf/reset/control records invalidate append reuse.
      const page = await params.raw({
        cursor: this.#cursor(params, from.generation, lastSeq),
        maxEvents: 96,
        maxBytes: 1_000_000,
      });
      params.assertCurrent();
      if (page.kind !== "page" || page.requiredBytes !== undefined || !page.events.length) {
        return undefined;
      }
      for (const row of page.events) {
        if (row.seq > maxSeq) {
          break;
        }
        const event = asOptionalRecord(row.event);
        if (
          row.seq !== lastSeq + 1 ||
          event?.type !== "custom_message" ||
          typeof event.id !== "string" ||
          event.parentId !== tailId
        ) {
          return undefined;
        }
        lastSeq = row.seq;
        tailId = event.id;
        if (typeof event.customType === "string" && params.customTypes.includes(event.customType)) {
          freezeJson(row.event);
          events.push(row.event);
          bytes += Buffer.byteLength(JSON.stringify(row.event));
        }
      }
      if (lastSeq === startSeq || (!page.hasMore && lastSeq < maxSeq)) {
        return undefined;
      }
    }
    return { boundary: { generation: from.generation, maxSeq, tailId }, events, bytes };
  }
}
