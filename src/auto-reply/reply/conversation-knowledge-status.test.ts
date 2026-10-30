import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ isEnabled: vi.fn(), debug: vi.fn() }));
// mock-isolation: Observe operational diagnostics without creating log files or console sinks.
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));

import {
  createConversationKnowledgeGapCollector,
  logConversationKnowledgeDiagnostic,
  logConversationKnowledgeTransfer,
} from "./conversation-knowledge-status.js";

beforeEach(() => {
  log.debug.mockClear();
  log.isEnabled.mockReturnValue(true);
});

describe("operational-only conversation diagnostics", () => {
  it("logs one bounded, correlated event without raw source or endpoint identifiers", () => {
    const { gaps, gap } = createConversationKnowledgeGapCollector();
    for (let index = 0; index < 5; index++) {
      const receipt = {
        source: { sessionKey: `agent:example:private-${index}` },
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
          sourceHash: redactIdentifier(`agent:example:private-${index}`),
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
