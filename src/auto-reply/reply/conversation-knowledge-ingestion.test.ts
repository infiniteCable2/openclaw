import { describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../../agents/sessions/messages.js";
import {
  createConversationKnowledgeIngestion,
  type ConversationKnowledgeIngestionMaintenance,
} from "./conversation-knowledge-ingestion.js";

const fits = { compacted: false, complete: true, canAdmitPending: true };
const tooLarge = { compacted: false, complete: true, canAdmitPending: false };
const probe = { checkOnly: true };
function messages(count = 1): CustomMessage[] {
  return Array.from({ length: count }, (_, timestamp) => ({
    role: "custom",
    customType: "synthetic-observation",
    content: "x".repeat(4_000),
    display: false,
    timestamp,
  }));
}
function progress(count: number) {
  return {
    accepted: count,
    appended: count,
    deferred: false,
    packetIds: Array.from({ length: count }, (_, index) => `packet-${index}`),
  };
}
function fixture(activePacketIds: string[] = []) {
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
      activePacketIds,
    }),
  };
}

describe("conversation knowledge batch admission", () => {
  it("preflights a fitting 32-packet batch once before its only write", async () => {
    const { ingestion, maintainContext, source } = fixture();
    maintainContext.mockResolvedValue(fits);
    const pending = messages(32);
    const result = progress(32);
    const write = vi.fn(async () => result);
    await expect(ingestion.tryBatch(pending, write)).resolves.toBe(result);
    expect(write).toHaveBeenCalledExactlyOnceWith(32);
    expect(maintainContext).toHaveBeenCalledExactlyOnceWith(source, [], undefined, pending, probe);
    expect(ingestion.incomplete).toBe(false);
  });

  it("admits the first fitting ordered prefix without compacting or losing its tail", async () => {
    const { ingestion, maintainContext, source, captureSources } = fixture();
    maintainContext
      .mockResolvedValueOnce(tooLarge)
      .mockResolvedValueOnce(tooLarge)
      .mockResolvedValueOnce(fits);
    const pending = messages(32);
    const write = vi.fn(async (count: number) => progress(count));
    await expect(ingestion.tryBatch(pending, write)).resolves.toEqual({
      ...progress(8),
      deferred: true,
    });
    expect(write).toHaveBeenCalledExactlyOnceWith(8);
    expect(maintainContext.mock.calls).toEqual(
      [32, 16, 8].map((count) => [source, [], undefined, pending.slice(0, count), probe]),
    );
    expect(captureSources).toHaveBeenCalledTimes(3);
    expect(ingestion.incomplete).toBe(true);
  });

  it("compacts only after one packet proves oversized, then rechecks its unadmitted text", async () => {
    const { ingestion, maintainContext, source } = fixture(["prior-carrier"]);
    maintainContext
      .mockResolvedValueOnce(tooLarge)
      .mockResolvedValueOnce({ compacted: true, complete: true })
      .mockResolvedValueOnce(fits);
    const pending = messages();
    const write = vi.fn(async () => progress(1));
    expect((await ingestion.tryBatch(pending, write)).accepted).toBe(1);
    expect(maintainContext.mock.calls).toEqual([
      [source, ["prior-carrier"], undefined, pending, probe],
      [source, ["prior-carrier"], undefined, pending],
      [source, [], undefined, pending, probe],
    ]);
    expect(write).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("bounds an oversized 32-packet search and never writes a still-oversized packet", async () => {
    const { ingestion, maintainContext } = fixture();
    maintainContext.mockResolvedValue(tooLarge);
    const write = vi.fn();
    await expect(ingestion.tryBatch(messages(32), write)).resolves.toEqual({
      accepted: 0,
      appended: 0,
      deferred: true,
      packetIds: [],
    });
    expect(maintainContext.mock.calls.map((call) => call[3]?.length)).toEqual([
      32, 16, 8, 4, 2, 1, 1,
    ]);
    expect(maintainContext.mock.calls.filter((call) => !call[4]?.checkOnly)).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { compacted: false, complete: true },
    { compacted: false, complete: false, canAdmitPending: false },
    { compacted: false, complete: false, pending: "maintenance-deferred" as const },
  ])(
    "does not shrink, compact, or write without a complete explicit pressure result (%j)",
    async (decision) => {
      const { ingestion, maintainContext } = fixture();
      maintainContext.mockResolvedValue(decision);
      const write = vi.fn();
      await expect(ingestion.tryBatch(messages(32), write)).resolves.toMatchObject({
        accepted: 0,
        deferred: true,
      });
      expect(maintainContext).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
      expect(ingestion.incomplete).toBe(true);
    },
  );

  it("retains writer-accepted carriers and checks their coverage on the next batch", async () => {
    const { ingestion, maintainContext, source } = fixture();
    maintainContext.mockResolvedValue(fits);
    const accepted = { accepted: 1, appended: 1, deferred: true, packetIds: ["accepted-prefix"] };
    await expect(ingestion.tryBatch(messages(2), async () => accepted)).resolves.toBe(accepted);
    const next = messages();
    await ingestion.tryBatch(next, async () => progress(1));
    expect(maintainContext).toHaveBeenLastCalledWith(
      source,
      ["accepted-prefix"],
      undefined,
      next,
      probe,
    );
    expect(ingestion.incomplete).toBe(true);
  });

  it("stops immediately if source authority is revoked during a shrinking check", async () => {
    const { ingestion, maintainContext } = fixture();
    maintainContext
      .mockResolvedValueOnce(tooLarge)
      .mockRejectedValueOnce(new Error("Source retired"));
    const write = vi.fn();
    await expect(ingestion.tryBatch(messages(32), write)).rejects.toThrow("Source retired");
    expect(maintainContext).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not repeat deferred maintenance or inspect unchanged history", async () => {
    const { ingestion, maintainContext, captureSources } = fixture(["already-admitted"]);
    await ingestion.tryBatch([], vi.fn());
    expect(captureSources).not.toHaveBeenCalled();
    maintainContext.mockResolvedValue({
      compacted: false,
      complete: false,
      pending: "maintenance-deferred",
    });
    await ingestion.tryBatch(messages(), vi.fn());
    await ingestion.tryBatch(messages(), vi.fn());
    expect(maintainContext).toHaveBeenCalledOnce();
    expect(ingestion.pending).toBe("maintenance-deferred");
  });
});
