import { vi } from "vitest";
import * as branchCreation from "../../config/sessions/conversation-branch-creation.js";
import * as lifecycleMutation from "../../config/sessions/session-accessor.sqlite-projection.js";
import * as reportStorage from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import * as conversationActivation from "../../config/sessions/session-conversation-activation.js";
import * as initialFrame from "../../config/sessions/session-initial-context-frame.js";
import * as initialContext from "../../config/sessions/session-initial-context.js";
import * as lifecycleProjection from "../../config/sessions/session-lifecycle-projection.js";
import * as sourceAuthority from "../../config/sessions/session-source-authority.js";
import * as transcriptAnchors from "../../config/sessions/session-transcript-anchor-read.js";
import * as personalAuthority from "../../gateway/session-transcript-personal-read.js";
import * as transcriptAuthority from "../../gateway/session-transcript-read-authority.js";
import * as knowledgeInitialContext from "./conversation-knowledge-initial-context.js";
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
  const observeSync = <T>(operation: string, run: () => T): T => {
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
    try {
      return run();
    } catch (error) {
      entry.failures++;
      throw error;
    } finally {
      const duration = performance.now() - began;
      entry.totalMs += duration;
      entry.synchronousMs += duration;
      entry.maxMs = Math.max(entry.maxMs, duration);
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
      const nativeCreation = branchCreation.prepareConversationBranchCreation;
      const nativeBorrow = initialFrame.borrowPreparedConversationKnowledgeInitialFrame;
      const nativeInitialContext =
        knowledgeInitialContext.prepareConversationKnowledgeInitialContext;
      const nativeLifecycle = lifecycleMutation.applySessionEntryLifecycleMutation;
      const nativeCommit = lifecycleProjection.commitSessionLifecycleProjectionInWorker;
      const nativeActivation = conversationActivation.prepareSessionConversationActivation;
      const nativeEvents = initialContext.createProjectedInitialSessionContextEvents;
      const nativeSourceSeal = initialContext.assertInitialSessionContextReadSource;
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
        probes.push(
          vi
            .spyOn(branchCreation, "prepareConversationBranchCreation")
            .mockImplementation(function (this: unknown, ...args) {
              return observe("branchCreation", () => nativeCreation.apply(this, args));
            }),
          vi
            .spyOn(initialFrame, "borrowPreparedConversationKnowledgeInitialFrame")
            .mockImplementation(function (this: void, ...args) {
              return observe("borrowInitialFrame", () => nativeBorrow.apply(this, args));
            }),
          vi
            .spyOn(knowledgeInitialContext, "prepareConversationKnowledgeInitialContext")
            .mockImplementation(function (this: unknown, ...args) {
              return observe("initialContext", () => nativeInitialContext.apply(this, args));
            }),
          vi
            .spyOn(lifecycleMutation, "applySessionEntryLifecycleMutation")
            .mockImplementation(function (this: unknown, ...args) {
              return observe("lifecycleMutation", () => nativeLifecycle.apply(this, args));
            }),
          vi
            .spyOn(lifecycleProjection, "commitSessionLifecycleProjectionInWorker")
            .mockImplementation(function (this: unknown, ...args) {
              return observe("nativeLifecycleCommit", () => nativeCommit.apply(this, args));
            }),
          vi
            .spyOn(conversationActivation, "prepareSessionConversationActivation")
            .mockImplementation(function (this: unknown, ...args) {
              return observe("conversationActivation", () => nativeActivation.apply(this, args));
            }),
          vi
            .spyOn(initialContext, "createProjectedInitialSessionContextEvents")
            .mockImplementation(function (this: unknown, ...args) {
              return observeSync("hostInitialEvents", () => nativeEvents.apply(this, args));
            }),
          vi
            .spyOn(initialContext, "assertInitialSessionContextReadSource")
            .mockImplementation(function (this: unknown, ...args) {
              return observeSync("hostInitialSourceSeal", () => nativeSourceSeal.apply(this, args));
            }),
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
