import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readConversationKnowledgeReports } from "./conversation-knowledge-history.js";
import { appendTranscriptEventSync, upsertSessionEntryCore } from "./session-accessor.js";
import { withSessionTranscriptDeltaReader } from "./session-transcript-delta-read.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";

describe("native conversation knowledge history catch-up", () => {
  it("reads every raw page, fixes the admitted prefix, and survives a compacted model view", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "knowledge-history" },
      async (state) => {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const target = {
          agentId: "main",
          storePath: database.path,
          env: state.env,
          sessionKey: "agent:main:knowledge-history",
          sessionId: "knowledge-history-original",
        };
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          updatedAt: 1,
          lifecycleRevision: "original",
        });
        const customType = "synthetic-knowledge-history";
        expect(
          appendTranscriptEventSync(target, {
            type: "custom_message",
            id: "unrelated-large-body",
            customType: "synthetic-unrelated",
            content: "x".repeat(1_100_000),
            display: false,
          }).ok,
        ).toBe(true);
        const append = (index: number) =>
          appendTranscriptEventSync(target, {
            type: "custom_message",
            id: `report-${index}`,
            customType,
            content: `Observation ${index}`,
            display: false,
            details: { index },
          });
        for (let index = 0; index < 100; index += 1) {
          expect(append(index).ok).toBe(true);
        }
        await waitForSessionTranscriptProjection(target);
        await withSessionTranscriptDeltaReader(target, async (reader) => {
          const page = await reader.raw({
            customTypes: [customType],
            activePathOnly: true,
            maxBytes: 1_000,
            maxEvents: 96,
          });
          expect(page.kind).toBe("page");
          if (page.kind !== "page") {
            throw new Error("Synthetic selective native page missing");
          }
          // Filtering must precede payload hydration: this tiny page budget cannot
          // load the unrelated body, but must still reach later matching reports.
          expect(page.requiredBytes).toBeUndefined();
          expect(page.events.length).toBeGreaterThan(0);
          expect(page.events[0]?.event).toMatchObject({ id: "report-0", customType });
          expect(
            page.events.every((row) => asOptionalRecord(row.event)?.customType === customType),
          ).toBe(true);
        });
        let checks = 0;
        const first = await readConversationKnowledgeReports({
          target,
          customTypes: [customType],
          assertCurrent() {
            // The second check follows watermark capture. This synchronous native
            // append cannot be accidentally included merely because paging continues.
            if (++checks === 2) {
              expect(append(100).ok).toBe(true);
            }
          },
        });
        expect(first).toHaveLength(100);
        expect(first.map((event) => asOptionalRecord(event)?.id)).toEqual(
          Array.from({ length: 100 }, (_, index) => `report-${index}`),
        );
        expect(
          appendTranscriptEventSync(target, {
            type: "compaction",
            id: "history-compaction",
            summary: "Earlier observations are compacted in the model view.",
            firstKeptEntryId: "report-100",
            tokensBefore: 10_000,
          }).ok,
        ).toBe(true);
        const second = await readConversationKnowledgeReports({
          target,
          customTypes: [customType],
          assertCurrent() {},
        });
        expect(second).toHaveLength(101);
        expect(second[0]).toMatchObject({ id: "report-0" });
        expect(second.at(-1)).toMatchObject({ id: "report-100" });
        expect(
          appendTranscriptEventSync(target, {
            type: "custom_message",
            id: "abandoned-report",
            customType,
            content: "This contribution belongs to an abandoned native leaf.",
            display: false,
          }).ok,
        ).toBe(true);
        expect(
          appendTranscriptEventSync(target, {
            type: "leaf",
            id: "select-prior-path",
            parentId: "abandoned-report",
            targetId: "history-compaction",
          }).ok,
        ).toBe(true);
        expect(append(101).ok).toBe(true);
        const selectedPath = await readConversationKnowledgeReports({
          target,
          customTypes: [customType],
          assertCurrent() {},
        });
        expect(selectedPath).toHaveLength(102);
        expect(selectedPath[0]).toMatchObject({ id: "report-0" });
        expect(selectedPath.at(-1)).toMatchObject({ id: "report-101" });
        expect(
          selectedPath.some((event) => asOptionalRecord(event)?.id === "abandoned-report"),
        ).toBe(false);
        let reads = 0;
        await expect(
          readConversationKnowledgeReports({
            target,
            customTypes: [customType],
            assertCurrent() {
              if (++reads === 3) {
                throw new Error("Synthetic retained authority revoked");
              }
            },
          }),
        ).rejects.toThrow("Synthetic retained authority revoked");
      },
    );
  });
});
