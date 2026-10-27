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
    expect(ingestion.pending).toBe("context-window");
    await ingestion.finish();
    expect(ingestion.incomplete).toBe(false);
    expect(ingestion.pending).toBeUndefined();
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

  it("defers an oversized addition without starving an independent later source", async () => {
    const { ingestion, maintainContext, source } = fixture();
    maintainContext.mockResolvedValue({ compacted: false, complete: true });
    const write = vi.fn(async () => undefined);
    expect(await ingestion.tryPacket("pending quoted text", write)).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(maintainContext).toHaveBeenCalledExactlyOnceWith(source, [], "pending quoted text");
    expect(ingestion.incomplete).toBe(true);
    const later = vi.fn(async () => "later");
    expect(await ingestion.tryPacket("later", later)).toBe(true);
    await ingestion.finish();
    expect(later).toHaveBeenCalledOnce();
    expect(maintainContext).toHaveBeenCalledTimes(2);
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

  it("does not rehydrate existing active carriers until new data is admitted", async () => {
    const maintainContext = vi.fn(async () => ({ compacted: false, complete: true }));
    const source = vi.fn();
    const captureSources = vi.fn(() => source);
    const create = (activePacketIds: string[]) =>
      createConversationKnowledgeIngestion({
        maintenance: { maintainContext },
        captureSources,
        activePacketIds,
      });
    for (let turn = 0; turn < 2; turn++) {
      const ingestion = create(["already-admitted"]);
      await ingestion.finish();
      expect(ingestion.pending).toBeUndefined();
    }
    await create([]).finish();
    expect(maintainContext).not.toHaveBeenCalled();
    expect(captureSources).not.toHaveBeenCalled();

    const ingestion = create(["already-admitted"]);
    const write = vi.fn(async () => "newly-admitted");
    expect(await ingestion.tryPacket("new observation", write)).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    await ingestion.finish();
    expect(maintainContext).toHaveBeenCalledExactlyOnceWith(
      source,
      ["already-admitted", "newly-admitted"],
      undefined,
    );
    await ingestion.finish();
    expect(maintainContext).toHaveBeenCalledOnce();
  });

  it("does not repeat failed maintenance for each later source", async () => {
    const maintainContext = vi.fn(async () => ({
      compacted: false,
      complete: false,
      pending: "maintenance-deferred" as const,
    }));
    const ingestion = createConversationKnowledgeIngestion({
      maintenance: { maintainContext },
      captureSources: () => () => {},
    });
    await ingestion.tryPacket("too large", async () => undefined);
    await ingestion.tryPacket("also too large", async () => undefined);
    await ingestion.tryPacket("small enough", async () => "accepted");
    await ingestion.finish();
    expect(maintainContext).toHaveBeenCalledOnce();
    expect(ingestion.pending).toBe("maintenance-deferred");
  });
});
