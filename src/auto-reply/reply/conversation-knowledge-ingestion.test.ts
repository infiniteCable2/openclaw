import { describe, expect, it, vi } from "vitest";
import {
  createConversationKnowledgeIngestion,
  type ConversationKnowledgeIngestionMaintenance,
} from "./conversation-knowledge-ingestion.js";

function fixture() {
  const maintainContext = vi.fn<ConversationKnowledgeIngestionMaintenance["maintainContext"]>();
  const source = vi.fn();
  const captureSources = vi.fn(() => source);
  return {
    maintainContext,
    captureSources,
    source,
    ingestion: createConversationKnowledgeIngestion({
      maintenance: { maintainContext },
      captureSources,
    }),
  };
}

describe("conversation knowledge ingestion pacing", () => {
  it("does not request compaction maintenance for unchanged history", async () => {
    const { ingestion, maintainContext, captureSources } = fixture();
    await ingestion.finish();
    expect(maintainContext).not.toHaveBeenCalled();
    expect(captureSources).not.toHaveBeenCalled();
  });

  it("tracks every new packet across no-op maintenance with fresh authority capture", async () => {
    const { ingestion, maintainContext, captureSources, source } = fixture();
    maintainContext
      .mockResolvedValueOnce({ compacted: false, complete: false })
      .mockResolvedValueOnce({ compacted: false, complete: true });
    await ingestion.tryPacket("a".repeat(24_000), async () => "first");
    await ingestion.tryPacket("a", async () => "second");
    expect(ingestion.incomplete).toBe(true);
    expect(ingestion.coverageNotice(false)).toHaveLength(1);
    await ingestion.finish();
    expect(ingestion.incomplete).toBe(false);
    expect(ingestion.coverageNotice(false)).toEqual([]);
    expect(ingestion.coverageNotice(true)).toHaveLength(1);
    expect(maintainContext).toHaveBeenNthCalledWith(1, source, ["first"], undefined);
    expect(maintainContext).toHaveBeenNthCalledWith(2, source, ["first", "second"], undefined);
    expect(captureSources).toHaveBeenCalledTimes(2);
  });

  it("retires packet carrier checks only after native compaction committed", async () => {
    const { ingestion, maintainContext, source } = fixture();
    maintainContext
      .mockResolvedValueOnce({ compacted: true, complete: true })
      .mockResolvedValueOnce({ compacted: false, complete: false });
    await ingestion.tryPacket("a".repeat(24_000), async () => "summarized");
    await ingestion.tryPacket("a", async () => "new");
    await ingestion.finish();
    expect(maintainContext).toHaveBeenNthCalledWith(2, source, ["new"], undefined);
    expect(ingestion.incomplete).toBe(true);
  });

  it("defers without advancing admission when the native window cannot preserve its preimage", async () => {
    const { ingestion, maintainContext, source } = fixture();
    maintainContext.mockResolvedValue({ compacted: false, complete: true });
    const write = vi.fn(async () => undefined);
    expect(await ingestion.tryPacket("pending quoted text", write)).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(maintainContext).toHaveBeenCalledExactlyOnceWith(source, [], "pending quoted text");
    expect(ingestion.coverageNotice(false)).toHaveLength(1);
    const later = vi.fn(async () => "later");
    expect(await ingestion.tryPacket("later", later)).toBe(false);
    await ingestion.finish();
    expect(later).not.toHaveBeenCalled();
    expect(maintainContext).toHaveBeenCalledTimes(1);
  });

  it("rechecks an intentional no-write once after successful native compaction", async () => {
    const { ingestion, maintainContext } = fixture();
    maintainContext.mockResolvedValue({ compacted: true, complete: true });
    const write = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("now-admitted");
    expect(await ingestion.tryPacket("observation", write)).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(ingestion.incomplete).toBe(false);
  });
});
