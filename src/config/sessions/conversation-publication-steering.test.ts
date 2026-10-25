import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  createConversationKnowledgeScenario,
  person,
} from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import { withConversationPublicationContext } from "./conversation-publication-context.js";
import { openConversationPublicationStore } from "./conversation-publication.js";
import type { ConversationPublicationIntent } from "./conversation-publication.types.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "./session-message-rewrite.js";
import { readPreparedSessionTranscriptChange } from "./session-transcript-authority.js";

async function withSteeringFixture(
  run: (fixture: {
    context<T>(work: () => T): T;
    original: UserTurnTranscriptRecorder;
    steer(): Promise<void>;
    overlap(): Promise<void>;
    answer(label: string): ReturnType<typeof appendTranscriptMessage>;
    revoke(): void;
    journal: ReturnType<typeof openConversationPublicationStore>;
    source: { sessionKey: string; sessionId: string; lifecycleRevision: string };
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { scenario: "minimal", label: "publication-steering-continuity" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      try {
        const source = await fixture.branch("steering");
        const owner = await fixture.claim(source);
        const branch = await readConversationKnowledgeBranch(owner);
        if (!branch) {
          throw new Error("Expected an enrolled conversation branch");
        }
        await upsertSessionEntryCore(source, { activeWriterRunId: "active-run" });
        const target = { ...source, sessionEntry: undefined, cwd: state.root, config: fixture.cfg };
        const message = {
          role: "user" as const,
          content: "Original private instruction.",
          timestamp: 1,
        };
        const admitted = await appendTranscriptMessage(source, { message });
        if (!admitted.anchor) {
          throw new Error("Expected original admitted user anchor");
        }
        const original = createUserTurnTranscriptRecorder({ message, target });
        original.markRuntimePersisted(admitted.message, admitted.anchor, { appended: true });
        const journal = openConversationPublicationStore({
          agentId: source.agentId,
          path: source.storePath,
          env: source.env,
          assertCurrent: owner.assertCurrent,
        });
        let current = true;
        const assertCurrent = () => {
          owner.assertCurrent();
          if (!current) {
            throw new Error("Original steering run retired");
          }
        };
        const context = <T>(work: () => T): T =>
          withConversationPublicationContext(
            {
              source,
              storePath: source.storePath,
              recorder: original,
              runId: "active-run",
              capture: () => {
                const admission = original.getAdmissionReceipt();
                if (!admission) {
                  throw new Error("Original admission unavailable");
                }
                const intent: ConversationPublicationIntent = {
                  version: 1,
                  kind: "completed-turn",
                  sourceMode: "branches",
                  source,
                  root: branch.root,
                  runId: "active-run",
                  privateAudience: { participant: person, admission },
                };
                return { intent, assertCurrent };
              },
            },
            work,
          );
        const steer = async () => {
          const input = {
            role: "user" as const,
            content: "Continue with this additional instruction.",
            timestamp: 2,
          };
          const committed = await appendTranscriptMessage(source, { message: input });
          if (!committed.anchor) {
            throw new Error("Expected second admitted user anchor");
          }
          const recorder = createUserTurnTranscriptRecorder({ message: input, target });
          recorder.markRuntimePersisted(committed.message, committed.anchor, { appended: true });
          await recorder.confirmSteerTargetRunIdForPersistence?.("active-run");
          expect(recorder.getPersistedMessage?.()?.__openclaw?.steerTargetRunId).toBe("active-run");
        };
        await run({
          context,
          original,
          steer,
          journal,
          source,
          revoke: () => {
            current = false;
          },
          overlap: async () => {
            const anchor = original.getAdmissionReceipt();
            if (!anchor) {
              throw new Error("Expected original admission");
            }
            await rewritePreparedTranscriptMessageAtAnchor(anchor, (candidate) => ({
              ...asOptionalRecord(candidate),
              __openclaw: {
                ...asOptionalRecord(asOptionalRecord(candidate)?.__openclaw),
                testAnnotation: true,
              },
            }));
          },
          answer: (label) =>
            appendTranscriptMessage(source, {
              message: {
                role: "assistant",
                content: label,
                stopReason: "stop",
                timestamp: 3,
                idempotencyKey: label,
                __openclaw: { runId: "active-run" },
              },
            }),
        });
      } finally {
        await fixture.close();
      }
    },
  );
}

it("keeps an active original admission continuous when a rapid second input confirms steering", async () => {
  await withSteeringFixture(async (f) => {
    const original = f.original.getAdmissionReceipt();
    await f.context(async () => {
      await f.answer("first-provisional-answer");
      await f.steer();
      const refreshed = f.original.getAdmissionReceipt();
      expect(refreshed?.generation).not.toBe(original?.generation);
      expect(refreshed).toEqual({ ...original, generation: refreshed?.generation });
      const final = await f.answer("final-after-steering");
      expect(final.appended).toBe(true);
      expect(
        await f.journal.accept({ ...f.source, runId: "active-run", entryId: final.messageId }),
      ).toBeTypeOf("string");
      const [ready] = await f.journal.readReadyHeads({ now: Date.now(), limit: 4 });
      expect(ready?.intent.privateAudience?.admission).toMatchObject({
        entryId: original?.entryId,
        rawSeq: original?.rawSeq,
        generation: final.anchor?.generation,
      });
      expect(await f.journal.stats()).toEqual(
        expect.arrayContaining([
          { state: "ready", count: 1 },
          { state: "blocked", count: 1 },
        ]),
      );
    });
  });
});

it("does not renew an overlapping original admission or bridge a subsequent missing generation", async () => {
  await withSteeringFixture(async (f) => {
    const original = f.original.getAdmissionReceipt();
    await f.context(async () => {
      await f.overlap();
      expect(f.original.getAdmissionReceipt()).toEqual(original);
      await f.steer();
      expect(f.original.getAdmissionReceipt()).toEqual(original);
      await expect(f.answer("unverified-terminal")).rejects.toThrow("not its admitted terminal");
    });
    expect(await f.journal.stats()).toEqual([]);
  });
});

it.each(["settled", "failed"] as const)(
  "does not renew a %s publication owner's admission",
  async (outcome) => {
    await withSteeringFixture(async (f) => {
      const original = f.original.getAdmissionReceipt();
      if (outcome === "settled") {
        await f.context(async () => {});
      } else {
        await expect(
          f.context(async () => {
            throw new Error("Synthetic run failure");
          }),
        ).rejects.toThrow("Synthetic run failure");
      }
      await f.steer();
      expect(f.original.getAdmissionReceipt()).toEqual(original);
    });
  },
);

it("retires revoked optional continuity without invalidating a legitimate steering commit", async () => {
  await withSteeringFixture(async (f) => {
    const original = f.original.getAdmissionReceipt();
    const invalidated: SessionRowChange[] = [];
    let committed = 0;
    const release = sessionChanges.subscribeFacts((change) => {
      if (!("sessionKey" in change) || change.sessionKey !== f.source.sessionKey) {
        return;
      }
      if (change.factsInvalidated) {
        invalidated.push(change);
      } else {
        const fact = readPreparedSessionTranscriptChange(change);
        if (fact?.kind === "postimage" && fact.value.unchangedPrefix) {
          committed += 1;
        }
      }
    });
    try {
      await f.context(async () => {
        f.revoke();
        await f.steer();
        expect(committed).toBeGreaterThan(0);
        expect(invalidated).toEqual([]);
        expect(f.original.getAdmissionReceipt()).toEqual(original);
        await expect(f.answer("revoked-terminal")).rejects.toThrow("Original steering run retired");
      });
    } finally {
      release();
    }
  });
});

it("never renews from an invalidation retaining its original native postimage", async () => {
  await withSteeringFixture(async (f) => {
    const original = f.original.getAdmissionReceipt();
    let committed: SessionRowChange | undefined;
    let invalidated: SessionRowChange | undefined;
    const release = sessionChanges.subscribeFacts((change) => {
      if (!("sessionKey" in change) || change.sessionKey !== f.source.sessionKey) {
        return;
      }
      const fact = readPreparedSessionTranscriptChange(change);
      if (fact?.kind !== "postimage" || !fact.value.unchangedPrefix) {
        return;
      }
      if (change.factsInvalidated) {
        invalidated = change;
      } else {
        committed = change;
        throw new Error("Synthetic native fact installation failure");
      }
    });
    try {
      await f.steer();
    } finally {
      release();
    }
    if (!committed || !invalidated) {
      throw new Error("Expected native postimage and retained-origin invalidation");
    }
    const commit = committed;
    const invalidation = invalidated;
    expect(readPreparedSessionTranscriptChange(invalidation)).toBe(
      readPreparedSessionTranscriptChange(commit),
    );
    await f.context(async () => {
      sessionChanges.invalidate(invalidation);
      expect(f.original.getAdmissionReceipt()).toEqual(original);
      // Once fenced, replay of that original postimage cannot resurrect continuity.
      sessionChanges.emit(commit);
      expect(f.original.getAdmissionReceipt()).toEqual(original);
    });
  });
});
