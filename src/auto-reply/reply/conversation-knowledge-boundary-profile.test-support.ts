import { vi } from "vitest";
import * as reportStorage from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import * as sourceAuthority from "../../config/sessions/session-source-authority.js";
import * as transcriptAnchors from "../../config/sessions/session-transcript-anchor-read.js";
import * as personalAuthority from "../../gateway/session-transcript-personal-read.js";
import * as transcriptAuthority from "../../gateway/session-transcript-read-authority.js";
import * as knowledgeSource from "./conversation-knowledge-source-reader.js";

/** Observe the real native handoff without substituting results, errors, or worker calls. */
export function createConversationKnowledgeBoundaryProfiler() {
  let measuring = false;
  const timings: Record<
    string,
    { calls: number; failures: number; totalMs: number; maxMs: number; synchronousMs: number }
  > = {};
  // Return the original promise. Inclusive nested/background times overlap and
  // must not be added together or described as exclusive foreground CPU usage.
  const observe = <T extends Promise<unknown>>(operation: string, run: () => T): T => {
    if (!measuring) {
      return run();
    }
    const entry = (timings[operation] ??= {
      calls: 0,
      failures: 0,
      totalMs: 0,
      maxMs: 0,
      synchronousMs: 0,
    });
    entry.calls++;
    const began = performance.now();
    const settled = (failed: boolean) => {
      const duration = performance.now() - began;
      entry.failures += Number(failed);
      entry.totalMs += duration;
      entry.maxMs = Math.max(entry.maxMs, duration);
    };
    try {
      const result = run();
      entry.synchronousMs += performance.now() - began;
      void result.then(
        () => settled(false),
        () => settled(true),
      );
      return result;
    } catch (error) {
      settled(true);
      throw error;
    }
  };
  return {
    observe,
    snapshot() {
      return Object.fromEntries(
        Object.entries(timings).map(([name, values]) => [
          name,
          Object.fromEntries(
            Object.entries(values).map(([key, value]) => [key, Math.round(value * 1000) / 1000]),
          ),
        ]),
      );
    },
    async measure<T>(recipientSessionId: string, run: () => Promise<T>): Promise<T> {
      const nativeAuthority = transcriptAuthority.prepareTranscriptReadAuthority;
      const nativePersonalRead = personalAuthority.preparePersonalConversationRead;
      const nativePersonalGroup = personalAuthority.preparePersonalConversationContributionGroup;
      const nativeAnchors = transcriptAnchors.readSessionTranscriptAnchorsAsync;
      const nativePrepareTarget = knowledgeSource.prepareConversationKnowledgeTarget;
      const nativeInputs = knowledgeSource.readConversationKnowledgeInputs;
      const nativeObserve = reportStorage.readSessionTranscriptReportReceipts;
      const nativeAppend = reportStorage.appendSessionTranscriptReportBatch;
      const nativeSourceAuthority = sourceAuthority.prepareSessionSourceAuthority;
      const probes: Array<{ mockRestore(): void }> = [];
      try {
        probes.push(
          vi
            .spyOn(personalAuthority, "preparePersonalConversationRead")
            .mockImplementation((input) =>
              observe("personalRead", () => nativePersonalRead(input)),
            ),
          vi
            .spyOn(personalAuthority, "preparePersonalConversationContributionGroup")
            .mockImplementation((input) =>
              observe("personalGroup", () => nativePersonalGroup(input)),
            ),
        );
        probes.push(
          vi
            .spyOn(transcriptAuthority, "prepareTranscriptReadAuthority")
            .mockImplementation((input) => observe("readAuthority", () => nativeAuthority(input))),
        );
        probes.push(
          vi
            .spyOn(transcriptAnchors, "readSessionTranscriptAnchorsAsync")
            .mockImplementation((...args) =>
              observe(
                args[0].sessionId === recipientSessionId ? "recipientAnchors" : "donorAnchors",
                () => nativeAnchors(...args),
              ),
            ),
        );
        probes.push(
          vi
            .spyOn(knowledgeSource, "prepareConversationKnowledgeTarget")
            .mockImplementation((input) =>
              observe("recipientAuthority", () => nativePrepareTarget(input)),
            ),
        );
        probes.push(
          vi
            .spyOn(knowledgeSource, "readConversationKnowledgeInputs")
            .mockImplementation((input) => observe("knowledgeInputs", () => nativeInputs(input))),
        );
        probes.push(
          vi
            .spyOn(reportStorage, "readSessionTranscriptReportReceipts")
            .mockImplementation((...args) =>
              observe("nativeReceiptObservation", () => nativeObserve(...args)),
            ),
        );
        probes.push(
          vi
            .spyOn(sourceAuthority, "prepareSessionSourceAuthority")
            .mockImplementation((input) =>
              observe("preparedSourceAuthority", () => nativeSourceAuthority(input)),
            ),
        );
        probes.push(
          vi
            .spyOn(reportStorage, "appendSessionTranscriptReportBatch")
            .mockImplementation((...args) =>
              observe("nativeReportAppend", () => nativeAppend(...args)),
            ),
        );
        measuring = true;
        return await run();
      } finally {
        measuring = false;
        for (const probe of probes.toReversed()) {
          probe.mockRestore();
        }
      }
    },
  };
}
