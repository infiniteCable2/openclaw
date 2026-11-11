import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  debug: vi.fn(),
  info: vi.fn<(message: string, fields: Record<string, unknown>) => void>(),
}));
// mock-isolation: Observe operational diagnostics without creating log files or console sinks.
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));

import {
  createConversationKnowledgeGapCollector,
  logConversationKnowledgeAdmission,
  logConversationKnowledgeCheckpointAdmission,
  logConversationKnowledgeDiagnostic,
  logConversationKnowledgeIdleDeferral,
  logConversationKnowledgePreparedRanges,
  logConversationKnowledgeReusedAdmission,
  logConversationKnowledgeTransfer,
} from "./conversation-knowledge-status.js";

beforeEach(() => {
  log.debug.mockClear();
  log.info.mockClear();
  log.isEnabled.mockReturnValue(true);
});

function transferReceipt(sessionId: string, rawSeq = 17) {
  const source = {
    agentId: "example",
    sessionId,
    sessionKey: "agent:example:private-source",
    lifecycleRevision: "original",
  };
  return {
    version: 1,
    sourceMode: "branches",
    runId: "fixture-run",
    source,
    origin: "private-origin",
    through: {
      ...source,
      storePath: "/synthetic/state.sqlite",
      generation: "private-generation",
      rawSeq,
      entryId: "private-entry",
      activeMessagePosition: rawSeq,
      effectiveParentId: null,
    },
  } satisfies Parameters<typeof logConversationKnowledgeTransfer>[0]["receipt"];
}

describe("operational-only conversation diagnostics", () => {
  it("reports exact prepared ranges even when aggregate info logging is disabled", () => {
    log.isEnabled.mockImplementation((level) => level === "debug");
    const ranges = [8, 9].map((sequence) => ({
      receipt: transferReceipt("private-exact-source", sequence),
      offset: 0,
      complete: true,
    }));
    logConversationKnowledgePreparedRanges({ recipient: "private-exact-target", ranges });
    expect(log.debug.mock.calls.map(([, event]) => event)).toEqual(
      [8, 9].map((throughSeq) =>
        expect.objectContaining({ phase: "prepared", throughSeq, offset: 0, complete: true }),
      ),
    );
    expect(log.info).not.toHaveBeenCalled();
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain("private-");
    log.debug.mockClear();
    log.isEnabled.mockReturnValue(false);
    logConversationKnowledgePreparedRanges({ recipient: "private-exact-target", ranges });
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("reports acknowledged batch totals and source sessions separately from reused receipts", () => {
    log.isEnabled.mockImplementation((level) => level === "info");
    const receipt = transferReceipt("private-committed-source");
    const packets = [0, 32].map((offset) => ({ receipt, offset, complete: offset > 0 }));
    logConversationKnowledgeAdmission({ recipient: "private-batch-target", packets, appended: 1 });
    expect(log.info).toHaveBeenCalledExactlyOnceWith("Conversation knowledge transfer outcome", {
      outcome: "admitted",
      cause: "native-transcript-commit",
      recipientHash: redactIdentifier("private-batch-target"),
      packets: 2,
      appendedPackets: 1,
      reusedPackets: 1,
      sourceCount: 1,
      sourceChunk: 1,
      sourceChunks: 1,
      sources: [
        {
          sourceHash: redactIdentifier(receipt.source.sessionId),
          packets: 2,
          completePackets: 1,
          throughSeq: 17,
          firstOffset: 0,
          lastOffset: 32,
        },
      ],
    });
    logConversationKnowledgeAdmission({ recipient: "private-batch-target", packets, appended: 0 });
    logConversationKnowledgeAdmission({ recipient: "private-batch-target", packets, appended: 0 });
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info.mock.calls[1]?.[1]).toMatchObject({
      cause: "existing-native-receipt",
      appendedPackets: 0,
    });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("private-");
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("correlates native reused admission across aggregate and per-packet observations", () => {
    const receipt = transferReceipt("private-reused-source");
    logConversationKnowledgeReusedAdmission({
      recipient: "private-reused-recipient",
      receipt,
      offset: 16,
      complete: true,
    });
    expect(log.info).toHaveBeenCalledOnce();
    expect(log.info.mock.calls[0]?.[1]).toMatchObject({
      cause: "existing-native-receipt",
      appendedPackets: 0,
      reusedPackets: 1,
    });
    expect(log.debug).toHaveBeenCalledExactlyOnceWith(
      "Conversation knowledge transfer",
      expect.objectContaining({ phase: "admitted", offset: 16 }),
    );
  });

  it("keeps prepared state and checkpoint commits distinct and suppresses empty or repeated preparation", () => {
    const params = {
      recipient: "private-prepared-target",
      ranges: [
        { receipt: transferReceipt("private-prepared-source", 8), offset: 0, complete: true },
      ],
    };
    logConversationKnowledgePreparedRanges({ ...params, ranges: [] });
    logConversationKnowledgePreparedRanges(params);
    logConversationKnowledgePreparedRanges(params);
    expect(log.info).toHaveBeenCalledOnce();
    expect(log.info.mock.calls[0]?.[1]).toMatchObject({
      outcome: "prepared",
      ranges: 1,
      sourceCount: 1,
    });
    logConversationKnowledgeCheckpointAdmission({
      recipient: params.recipient,
      root: "private-root",
      checkpointId: "private-checkpoint",
      appended: true,
      coveredRanges: 14,
    });
    expect(log.info.mock.calls[1]?.[1]).toMatchObject({
      outcome: "admitted",
      cause: "native-checkpoint-commit",
      sourceHash: redactIdentifier("private-root"),
      appendedCheckpoints: 1,
      coveredRanges: 14,
    });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("private-");
  });

  it("uses the same session identity for prepared, committed and deferred sources", () => {
    const receipt = transferReceipt("private-correlated-session");
    const { gaps, gap } = createConversationKnowledgeGapCollector();
    gap(receipt, "source-range-unverified");
    logConversationKnowledgePreparedRanges({
      recipient: "private-correlated-target",
      ranges: [{ receipt, offset: 0, complete: true }],
    });
    logConversationKnowledgeAdmission({
      recipient: "private-correlated-target",
      packets: [{ receipt, offset: 0, complete: true }],
      appended: 1,
    });
    logConversationKnowledgeDiagnostic({ recipient: "private-correlated-target", gaps });
    for (const index of [0, 1]) {
      expect(log.info.mock.calls[index]?.[1]).toMatchObject({
        sources: [
          expect.objectContaining({ sourceHash: redactIdentifier(receipt.source.sessionId) }),
        ],
      });
    }
    expect(log.info.mock.calls[2]?.[1]).toMatchObject({
      outcome: "deferred",
      unresolvedRanges: 1,
      sources: [
        {
          sourceHash: redactIdentifier(receipt.source.sessionId),
          cause: "source-range-unverified",
          ranges: 1,
        },
      ],
    });
  });

  it("bounds source detail and deduplication, and exposes only closed failure causes", () => {
    const { gaps, gap } = createConversationKnowledgeGapCollector();
    for (let index = 0; index < 5; index++) {
      gap(transferReceipt(`private-bounded-${index}`), "admission-deferred");
    }
    logConversationKnowledgeDiagnostic({ recipient: "private-bounded-target", gaps });
    logConversationKnowledgeDiagnostic({ recipient: "private-bounded-target", gaps });
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info.mock.calls[0]?.[1]).toMatchObject({
      sourceCauseGroups: 5,
      sourceChunks: 2,
    });
    for (let index = 0; index < 5; index++) {
      expect(log.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sources: expect.arrayContaining([
            expect.objectContaining({ sourceHash: redactIdentifier(`private-bounded-${index}`) }),
          ]),
        }),
      );
    }
    const failure = new Error("private error text https://private.example.test");
    failure.name = "SessionMutationFactsUnavailableError";
    logConversationKnowledgeDiagnostic({ recipient: "private-error-target", failure });
    expect(log.info.mock.calls[2]?.[1]).toMatchObject({ cause: "session-facts-unavailable" });
    failure.name = "private-arbitrary-name";
    logConversationKnowledgeDiagnostic({ recipient: "private-error-target", failure });
    expect(log.info.mock.calls[3]?.[1]).toMatchObject({ cause: "native-outcome-unavailable" });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("private-");
    for (let index = 0; index < 256; index++) {
      logConversationKnowledgeDiagnostic({
        recipient: `private-eviction-${index}`,
        pending: "context-window",
      });
    }
    const before = log.info.mock.calls.length;
    logConversationKnowledgeDiagnostic({ recipient: "private-bounded-target", gaps });
    expect(log.info).toHaveBeenCalledTimes(before + 2);
  });

  it("covers every prepared source in bounded records and preserves A to B to A after progress", () => {
    const recipient = "private-all-prepared-target";
    const ranges = Array.from({ length: 10 }, (_, index) => ({
      receipt: transferReceipt(`private-prepared-${index}`),
      offset: 0,
      complete: true,
    }));
    logConversationKnowledgePreparedRanges({ recipient, ranges });
    expect(log.info).toHaveBeenCalledTimes(4);
    for (let index = 0; index < 4; index++) {
      expect(log.info.mock.calls[index]?.[1]).toMatchObject({
        sources: ranges
          .slice(index * 3, (index + 1) * 3)
          .map(({ receipt }) =>
            expect.objectContaining({ sourceHash: redactIdentifier(receipt.source.sessionId) }),
          ),
      });
    }
    logConversationKnowledgePreparedRanges({ recipient, ranges: ranges.slice(0, 1) });
    log.info.mockClear();
    logConversationKnowledgePreparedRanges({ recipient, ranges });
    expect(log.info).toHaveBeenCalledTimes(4);
    log.info.mockClear();
    const target = "private-transition-target";
    const first = {
      receipt: transferReceipt("private-transition-source", 1),
      offset: 0,
      complete: true,
    };
    const second = { ...first, receipt: transferReceipt(first.receipt.source.sessionId, 2) };
    for (const range of [first, second, first]) {
      logConversationKnowledgePreparedRanges({ recipient: target, ranges: [range] });
    }
    expect(log.info).toHaveBeenCalledTimes(3);
    logConversationKnowledgeAdmission({ recipient: target, packets: [first], appended: 1 });
    logConversationKnowledgePreparedRanges({ recipient: target, ranges: [first] });
    expect(log.info).toHaveBeenCalledTimes(5);
  });

  it("does not report absent work or emit operational logs when disabled", () => {
    logConversationKnowledgeIdleDeferral({
      recipient: "private-no-work",
      reason: "no-prepared",
      preparedPackets: 0,
      checkpoint: false,
    });
    logConversationKnowledgeAdmission({ recipient: "private-no-work", packets: [], appended: 0 });
    expect(log.info).not.toHaveBeenCalled();
    log.isEnabled.mockReturnValue(false);
    logConversationKnowledgePreparedRanges({
      recipient: "private-no-work",
      ranges: [{ receipt: transferReceipt("private-no-work-source"), offset: 0, complete: true }],
    });
    expect(log.info).not.toHaveBeenCalled();
  });

  it("reports only correlated idle reasons and observed numeric progress", () => {
    logConversationKnowledgeIdleDeferral({
      recipient: "private-idle-recipient",
      reason: "capacity",
      preparedPackets: 2,
      checkpoint: false,
      consumptionChanges: 1,
      capacityChecks: 3,
      capacityRefusals: 2,
    });
    expect(log.debug).toHaveBeenCalledExactlyOnceWith(
      "Conversation knowledge idle admission deferred",
      {
        recipientHash: redactIdentifier("private-idle-recipient"),
        reason: "capacity",
        preparedPackets: 2,
        checkpoint: false,
        consumptionChanges: 1,
        capacityChecks: 3,
        capacityRefusals: 2,
      },
    );
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain("private-idle-recipient");
    log.debug.mockClear();
    log.isEnabled.mockReturnValue(false);
    logConversationKnowledgeIdleDeferral({
      recipient: "private-idle-recipient",
      reason: "missing-budget",
      preparedPackets: 2,
      checkpoint: false,
    });
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("logs one bounded, correlated event without raw source or endpoint identifiers", () => {
    const { gaps, gap } = createConversationKnowledgeGapCollector();
    for (let index = 0; index < 5; index++) {
      const receipt = {
        source: { sessionId: `private-session-${index}` },
        through: { entryId: `private-endpoint-${index}` },
      };
      gap(receipt, "source-range-unverified");
      gap(receipt, "source-range-unverified");
    }
    expect(
      logConversationKnowledgeDiagnostic({ recipient: "private-recipient", gaps }),
    ).toBeUndefined();
    expect(log.debug).toHaveBeenCalledExactlyOnceWith(
      "Supplementary conversation catch-up deferred",
      {
        recipientHash: redactIdentifier("private-recipient"),
        unresolvedRanges: 10,
        gaps: [0, 1, 2].map((index) => ({
          sourceHash: redactIdentifier(`private-session-${index}`),
          endpointHash: redactIdentifier(`private-endpoint-${index}`),
          reason: "source-range-unverified",
          ranges: 2,
        })),
        additionalGapGroups: 2,
      },
    );
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain("private-");
  });

  it("records seed, audience and capacity deferrals without producing context fragments", () => {
    for (const reason of [
      "initial-history-not-yet-verified",
      "original-participant-unconfirmed",
      "private-destination-audience-unconfirmed",
    ] as const) {
      expect(logConversationKnowledgeDiagnostic({ recipient: "example", reason })).toBeUndefined();
    }
    logConversationKnowledgeDiagnostic({ recipient: "example", pending: "maintenance-deferred" });
    expect(log.debug).toHaveBeenCalledTimes(4);
    expect(log.debug.mock.calls[3]?.[1]).toMatchObject({ pending: "maintenance-deferred" });
  });

  it("is silent for complete catch-up and when debug logging is disabled", () => {
    logConversationKnowledgeDiagnostic({ recipient: "example" });
    log.isEnabled.mockReturnValue(false);
    logConversationKnowledgeDiagnostic({ recipient: "example", pending: "context-window" });
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("correlates prepared and admitted packets without exposing their identities or text", () => {
    const source = {
      agentId: "example",
      sessionId: "private-source",
      sessionKey: "agent:example:source",
      lifecycleRevision: "original",
    };
    const receipt = {
      version: 1,
      sourceMode: "branches",
      runId: "synthetic-run",
      source,
      origin: "private-origin",
      through: {
        ...source,
        storePath: "/synthetic/state.sqlite",
        generation: "private-generation",
        rawSeq: 17,
        entryId: "private-entry",
        activeMessagePosition: 17,
        effectiveParentId: null,
      },
    } satisfies Parameters<typeof logConversationKnowledgeTransfer>[0]["receipt"];
    for (const phase of ["prepared", "admitted"] as const) {
      logConversationKnowledgeTransfer({
        phase,
        receipt,
        recipient: "private-recipient",
        offset: 0,
        complete: true,
      });
    }
    const events = log.debug.mock.calls.map(([, event]) => event);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ phase: "prepared", throughSeq: 17 });
    expect(events[1]).toEqual({ ...events[0], phase: "admitted" });
    expect(JSON.stringify(events)).not.toContain("private-");
    log.debug.mockClear();
    log.isEnabled.mockReturnValue(false);
    logConversationKnowledgeTransfer({
      phase: "prepared",
      receipt,
      recipient: "private-recipient",
      offset: 0,
      complete: true,
    });
    expect(log.debug).not.toHaveBeenCalled();
  });
});
