import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  createConversationKnowledgeScenario,
  person,
} from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import { publishConversationPublication } from "./conversation-publication-publish.js";
import type { ConversationPublicationRow } from "./conversation-publication.types.js";
import {
  appendTranscriptEventSync,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readActiveTranscriptEntryAnchorAsync } from "./session-transcript-anchor-read.js";

it("publishes recovered exact endpoints out of order once, and refuses replacement sources", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "knowledge-publication-recovery" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      try {
        const source = await fixture.branch("source");
        const owner = await fixture.claim(source);
        const branch = await readConversationKnowledgeBranch(owner);
        if (!branch) {
          throw new Error("Expected admitted branch");
        }
        const rows: ConversationPublicationRow[] = [];
        for (const runId of ["first", "second"]) {
          const turn = await fixture.append(source, runId);
          const event = (await loadTranscriptEvents(source))
            .map(asOptionalRecord)
            .find(
              (item) =>
                asOptionalRecord(item?.message)?.idempotencyKey ===
                turn.assistantTranscriptIdempotencyKey,
            );
          if (typeof event?.id !== "string" || !turn.admission) {
            throw new Error("Expected exact committed turn anchors");
          }
          const anchor = await readActiveTranscriptEntryAnchorAsync({
            ...source,
            entryId: event.id,
          });
          if (!anchor) {
            throw new Error("Expected current terminal");
          }
          rows.push({
            id: `publication-${runId}`,
            intent: {
              version: 1,
              kind: "completed-turn",
              runId,
              sourceMode: "branches",
              source,
              root: branch.root,
              privateAudience: { participant: person, admission: turn.admission },
            },
            anchor,
            state: "ready",
            attemptCount: 0,
            nextAttemptAt: 0,
          });
        }
        const publish = (row: ConversationPublicationRow) =>
          publishConversationPublication({
            agentId: source.agentId,
            path: source.storePath,
            env: state.env,
            row,
            signal: new AbortController().signal,
            assertCurrent: owner.assertCurrent,
          });
        // Compaction must not turn a persisted, accepted endpoint into a lost
        // publication while recovery is delayed. It is not a transcript rewrite.
        expect(
          appendTranscriptEventSync(source, {
            type: "compaction",
            id: "source-compaction",
            summary: "Earlier completed exchanges.",
            firstKeptEntryId: rows[1]!.anchor.entryId,
            tokensBefore: 100,
          }).ok,
        ).toBe(true);
        await publish(rows[1]!);
        await publish(rows[0]!);
        await publish(rows[1]!);
        const receipts = await fixture.receipts();
        expect(receipts.map((receipt) => receipt.runId)).toEqual(["second", "first"]);
        expect(JSON.stringify(receipts)).not.toContain("first answer");
        const destination = await fixture.branch("recipient");
        const known = await fixture.read(await fixture.claim(destination));
        expect(known.text).toContain("first answer");
        expect(known.text).toContain("second answer");

        await upsertSessionEntryCore(fixture.root, { lifecycleRevision: "replacement-root" });
        await expect(
          publishConversationPublication({
            agentId: source.agentId,
            path: source.storePath,
            env: state.env,
            row: rows[0]!,
            signal: new AbortController().signal,
            assertCurrent: () => {},
          }),
        ).rejects.toThrow("root-replaced");
        await upsertSessionEntryCore(source, { lifecycleRevision: "replacement" });
        await expect(
          publishConversationPublication({
            agentId: source.agentId,
            path: source.storePath,
            env: state.env,
            row: rows[0]!,
            signal: new AbortController().signal,
            assertCurrent: () => {},
          }),
        ).rejects.toThrow("source-replaced");
        expect(await fixture.receipts()).toHaveLength(2);
      } finally {
        await fixture.close();
      }
    },
  );
});
