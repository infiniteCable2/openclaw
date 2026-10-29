import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationKnowledgeRootCache,
  ConversationKnowledgeRootContinuation,
  readConversationKnowledgeRootSnapshot,
} from "./conversation-knowledge-root-cache.js";
import type {
  SessionTranscriptEventRow,
  SessionTranscriptRawDeltaResult,
  TranscriptEvent,
} from "./session-accessor.types.js";
import {
  createTranscriptRawDeltaCursor,
  parseRawTranscriptCursor,
} from "./session-transcript-raw-cursor.js";

function fixture(maxBytes?: number) {
  const cache = new ConversationKnowledgeRootCache(maxBytes);
  let generation = "original";
  let selected: TranscriptEvent[] | undefined;
  const rows: SessionTranscriptEventRow[] = [];
  const append = (type = "custom_message", parentId = `event-${rows.length - 1}`) => {
    const row = {
      seq: rows.length,
      event: {
        type,
        id: `event-${rows.length}`,
        parentId,
        customType: "receipt",
        details: { value: rows.length },
      },
    };
    rows.push(row);
    return row;
  };
  append("session");
  append();
  const params = {
    source: {
      agentId: "example",
      path: "/synthetic/agent.sqlite",
      databaseIdentity: "physical-original",
    },
    agentId: "example",
    sessionKey: "agent:example:root",
    sessionId: "root",
    lifecycleRevision: "life-original",
    customTypes: ["receipt"],
    continuation: undefined as ConversationKnowledgeRootContinuation | undefined,
    watermark: vi.fn(async () => ({ generation, maxSeq: rows.length - 1 })),
    raw: vi.fn(
      async (limits: {
        cursor?: string;
        maxEvents?: number;
      }): Promise<SessionTranscriptRawDeltaResult> => {
        const cursor = parseRawTranscriptCursor(limits.cursor!);
        if (!cursor || cursor.generation !== generation) {
          return { kind: "reset" as const, reason: "generation_mismatch" as const, cursor: "" };
        }
        const events = rows.filter((row) => row.seq > cursor.lastSeq).slice(0, limits.maxEvents);
        return {
          kind: "page" as const,
          cursor: createTranscriptRawDeltaCursor({
            ...cursor,
            lastSeq: events.at(-1)?.seq ?? cursor.lastSeq,
          }),
          events,
          hasMore: (events.at(-1)?.seq ?? cursor.lastSeq) < rows.length - 1,
          serializedBytes: 1,
        };
      },
    ),
    full: vi.fn(
      async (through: { maxSeq: number | null }) =>
        selected ??
        rows
          .filter(
            (row) =>
              row.seq <= through.maxSeq! && asOptionalRecord(row.event)?.type === "custom_message",
          )
          .map((row) => structuredClone(row.event)),
    ),
    assertCurrent: vi.fn(),
    revalidate: vi.fn(async () => {}),
  };
  return {
    cache,
    params,
    rows,
    append,
    rewrite: () => {
      generation = "rewritten";
    },
    select: (events: TranscriptEvent[]) => {
      selected = events;
    },
    read: () => cache.read(params),
  };
}

describe("incremental infrastructure root receipts", () => {
  it("reads only linear deltas and revalidates authority even at the same watermark", async () => {
    const f = fixture();
    expect(await f.read()).toHaveLength(1);
    f.params.raw.mockClear();
    expect(await f.read()).toHaveLength(1);
    expect(f.params.raw).not.toHaveBeenCalled();
    f.append();
    const result = await f.read();
    expect(result).toHaveLength(2);
    expect(f.params.full).toHaveBeenCalledOnce();
    expect(f.params.raw).toHaveBeenCalledOnce();
    expect(parseRawTranscriptCursor(f.params.raw.mock.calls[0]![0].cursor!)?.lastSeq).toBe(1);
    expect(f.params.revalidate).toHaveBeenCalledTimes(3);
    const retained = asOptionalRecord(result[0]);
    if (!retained) {
      throw new Error("Expected retained root receipt");
    }
    expect(() => {
      retained.details = {};
    }).toThrow();
    f.params.revalidate.mockRejectedValueOnce(new Error("Source revoked"));
    await expect(f.read()).rejects.toThrow("Source revoked");
  });

  it.each(["leaf", "reset", "compaction", "message", "unknown"])(
    "rebuilds on %s instead of trusting unchanged generation",
    async (type) => {
      const f = fixture();
      await f.read();
      f.append(type);
      const last = f.append();
      f.select([last.event]);
      expect(await f.read()).toEqual([last.event]);
      expect(f.params.full).toHaveBeenCalledTimes(2);
    },
  );

  it("rebuilds for rewritten generations, replaced roots, and non-linear custom appends", async () => {
    const f = fixture();
    await f.read();
    f.append("custom_message", "different-parent");
    await f.read();
    f.rewrite();
    await f.read();
    f.params.source.databaseIdentity = "physical-replacement";
    await f.read();
    f.params.lifecycleRevision = "life-replacement";
    await f.read();
    expect(f.params.full).toHaveBeenCalledTimes(5);
  });

  it("keeps a fixed prefix when later appends arrive and rejects concurrent controls", async () => {
    const f = fixture();
    await f.read();
    f.append();
    f.params.watermark.mockImplementationOnce(async () => {
      const captured = { generation: "original", maxSeq: f.rows.length - 1 };
      f.append();
      return captured;
    });
    expect(await f.read()).toHaveLength(2);
    expect(await f.read()).toHaveLength(3);
    f.params.watermark.mockImplementationOnce(async () => {
      const captured = { generation: "original", maxSeq: f.rows.length - 1 };
      f.append("leaf");
      return captured;
    });
    await expect(f.read()).rejects.toThrow("root changed during catch-up");
  });

  it("falls back when its bounded cache cannot retain the root", async () => {
    const f = fixture(1);
    await f.read();
    await f.read();
    expect(f.params.full).toHaveBeenCalledTimes(2);
  });

  it.each([1, 8 * 1024 * 1024])(
    "retains oversize metadata only with its live owner (cap %s)",
    async (cap) => {
      const f = fixture(cap);
      const event = asOptionalRecord(f.rows[1]!.event)!;
      event.details = { text: "x".repeat(cap === 1 ? 256 : 9 * 1024 * 1024) };
      const owner = new ConversationKnowledgeRootContinuation();
      f.params.continuation = owner;
      const initial = await f.read();
      expect(owner.retainedBytes).toBeGreaterThan(cap);
      expect(readConversationKnowledgeRootSnapshot(initial)?.events[0]).toBe(initial[0]);
      f.params.raw.mockClear();
      f.append();
      const updated = await f.read();
      expect(updated).toHaveLength(2);
      expect(updated[0]).toBe(initial[0]);
      expect(f.params.full).toHaveBeenCalledOnce();
      expect(f.params.raw).toHaveBeenCalledOnce();
      // Other recipient readers reuse the live owner's shared root continuation.
      const same = await f.cache.read({ ...f.params, continuation: undefined });
      expect(readConversationKnowledgeRootSnapshot(same)).toBe(
        readConversationKnowledgeRootSnapshot(updated),
      );
      expect(f.params.full).toHaveBeenCalledOnce();
      owner.release();
      expect(owner.retainedBytes).toBe(0);
      await expect(f.read()).rejects.toThrow("owner has closed");
      // Only weak directory entries remain above the small LRU budget; reclamation
      // itself is GC-controlled, not asserted using nondeterministic forced collection.
    },
  );

  it.each(["leaf", "reset", "compaction", "unknown"])(
    "rebuilds a live oversize continuation after %s",
    async (type) => {
      const f = fixture(1);
      const owner = new ConversationKnowledgeRootContinuation();
      f.params.continuation = owner;
      await f.read();
      f.append(type);
      const last = f.append();
      f.select([last.event]);
      expect(await f.read()).toEqual([last.event]);
      expect(f.params.full).toHaveBeenCalledTimes(2);
      f.rewrite();
      await f.read();
      expect(f.params.full).toHaveBeenCalledTimes(3);
      owner.release();
    },
  );

  it("does not cache an unavailable boundary or reuse an unavailable delta", async () => {
    const f = fixture();
    f.params.raw.mockResolvedValueOnce({ kind: "missing" });
    expect(await f.read()).toHaveLength(1);
    await f.read();
    expect(f.params.full).toHaveBeenCalledTimes(2);
    f.append();
    f.params.raw.mockResolvedValueOnce({ kind: "missing" });
    expect(await f.read()).toHaveLength(2);
    expect(f.params.full).toHaveBeenCalledTimes(3);
  });

  it("rebuilds without spinning when a delta has no rows inside the captured cutoff", async () => {
    const f = fixture();
    await f.read();
    f.append();
    f.params.raw.mockResolvedValueOnce({
      kind: "page",
      cursor: "untrusted",
      events: [{ seq: 9, event: {} }],
      hasMore: true,
      serializedBytes: 1,
    });
    expect(await f.read()).toHaveLength(2);
    expect(f.params.full).toHaveBeenCalledTimes(2);
  });
});
