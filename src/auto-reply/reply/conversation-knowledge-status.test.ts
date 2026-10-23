import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ isEnabled: vi.fn(), debug: vi.fn() }));
// mock-isolation: Observe operational diagnostics without creating log files or console sinks.
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));

import {
  createConversationKnowledgeGapCollector,
  logConversationKnowledgeDiagnostic,
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
});
