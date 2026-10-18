import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readConversationKnowledgeBranch,
  readConversationKnowledgeRoot,
  recordConversationKnowledgeTurn,
  recordConversationUtteranceObservation,
} from "./conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_UTTERANCE_REPORT,
  readConversationKnowledgeReceipt,
  readConversationUtteranceObservation,
  projectConversationKnowledge,
} from "./conversation-knowledge.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import type { SessionSourceAssertion, SessionSourcePredicate } from "./session-source-authority.js";

describe("native completed-turn root consolidation", () => {
  it("reports the exact saved occurrence once, without duplicating dialogue in its root", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "conversation-knowledge" },
      async (state) => {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const root = {
          agentId: "main",
          storePath: database.path,
          env: state.env,
          sessionKey: "agent:main:main",
          sessionId: "root-original",
        };
        const branch = {
          ...root,
          sessionKey: "agent:main:conversation-a",
          sessionId: "branch-original",
        };
        await upsertSessionEntryCore(root, {
          sessionId: root.sessionId,
          updatedAt: 1,
          lifecycleRevision: "root-lifecycle",
          createdVia: "internal",
          createdActor: { type: "system", id: "conversation-root" },
          visibility: "draft",
          delivery: { kind: "none" },
          conversationTopology: { version: 1, role: "root" },
        });
        await upsertSessionEntryCore(branch, {
          sessionId: branch.sessionId,
          updatedAt: 1,
          lifecycleRevision: "branch-lifecycle",
          chatType: "direct",
          conversationTopology: {
            version: 1,
            role: "branch",
            rootSessionKey: root.sessionKey,
            rootSessionId: root.sessionId,
            rootSessionLifecycleRevision: "root-lifecycle",
          },
        });
        const question = appendTranscriptMessageSync(branch, {
          message: { role: "user", content: "The example colour is blue.", timestamp: 1 },
        });
        const answer = appendTranscriptMessageSync(branch, {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "The example is blue." }],
            stopReason: "stop",
            timestamp: 2,
            idempotencyKey: "run-original:assistant",
            __openclaw: { runId: "run-original" },
          },
        });
        expect(question.ok && answer.ok).toBe(true);
        const { databaseClaim } = await loadSessionEntryForAdmission(branch);
        if (
          !("kind" in databaseClaim) ||
          databaseClaim.kind !== "worker" ||
          !databaseClaim.reader
        ) {
          await databaseClaim.release();
          throw new Error("Expected a real native admitted cohort reader");
        }
        const reader = databaseClaim.reader;
        const captured = captureSessionEntryReadSource(database, state.env);
        const assertCurrent: SessionSourceAssertion = Object.assign(
          () => databaseClaim.assertCurrent(),
          {
            prepareSessionSource: async () => ({
              assertCurrent: () => databaseClaim.assertCurrent(),
              checks: [
                {
                  predicate: {
                    source: captured,
                    sessionKey: branch.sessionKey,
                    fields: ["sessionId", "lifecycleRevision"],
                    expected: {
                      sessionId: branch.sessionId,
                      lifecycleRevision: "branch-lifecycle",
                    },
                  } satisfies SessionSourcePredicate,
                  refuse: (): never => {
                    throw new Error("Original admitted source changed");
                  },
                },
              ],
            }),
          },
        );
        const completed = {
          reader,
          assertCurrent,
          sessionId: branch.sessionId,
          runId: "run-original",
          assistantTranscriptIdempotencyKey: "run-original:assistant",
        };
        try {
          await expect(
            recordConversationKnowledgeTurn({ ...completed, runId: "unrelated" }),
          ).resolves.toBe(false);
          await expect(
            recordConversationKnowledgeTurn({
              ...completed,
              assistantTranscriptIdempotencyKey: "missing",
            }),
          ).resolves.toBe(false);
          await expect(recordConversationKnowledgeTurn(completed)).resolves.toBe(true);
          await expect(recordConversationKnowledgeTurn(completed)).resolves.toBe(true);
          const events = await loadTranscriptEvents(root);
          const reports = events
            .map(asOptionalRecord)
            .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_REPORT);
          expect(reports).toHaveLength(1);
          expect(JSON.stringify(reports)).not.toContain("example is blue");
          expect(JSON.stringify(reports)).not.toContain("example colour");
          const receipt = readConversationKnowledgeReceipt(reports[0]?.details);
          expect(receipt?.source).toMatchObject({
            sessionId: branch.sessionId,
            lifecycleRevision: "branch-lifecycle",
          });
          expect(receipt?.runId).toBe("run-original");
          const selected = await readConversationKnowledgeBranch(completed);
          if (!selected) throw new Error("Native branch missing");
          expect(
            await readConversationKnowledgeRoot({ branch: selected, reader, assertCurrent }),
          ).toEqual(events);
          const voice = appendTranscriptMessageSync(branch, {
            message: {
              role: "user",
              content: "A separate realtime utterance.",
              timestamp: 3,
              provenance: { kind: "realtime_voice", sourceChannel: "talk" },
            },
          });
          if (!voice.ok || !voice.value?.anchor) throw new Error("Native voice anchor missing");
          const observation = {
            reader,
            assertCurrent,
            sessionId: branch.sessionId,
            anchor: voice.value.anchor,
            role: "user" as const,
          };
          await expect(
            recordConversationUtteranceObservation({
              ...observation,
              anchor: { ...observation.anchor, rawSeq: observation.anchor.rawSeq + 1 },
            }),
          ).resolves.toBe(false);
          await expect(
            recordConversationUtteranceObservation({ ...observation, role: "assistant" }),
          ).resolves.toBe(false);
          await expect(recordConversationUtteranceObservation(observation)).resolves.toBe(true);
          await expect(recordConversationUtteranceObservation(observation)).resolves.toBe(true);
          const references = (await loadTranscriptEvents(root))
            .map(asOptionalRecord)
            .filter((event) => event?.customType === CONVERSATION_UTTERANCE_REPORT);
          expect(references).toHaveLength(1);
          expect(JSON.stringify(references)).not.toContain("separate realtime");
          const observed = readConversationUtteranceObservation(references[0]?.details);
          expect(observed?.kind).toBe("utterance-observation");
          expect(observed).not.toHaveProperty("runId");
          if (!observed) throw new Error("Native utterance reference missing");
          expect(
            projectConversationKnowledge(observed, await loadTranscriptEvents(branch))?.text,
          ).toContain("A separate realtime utterance.");
        } finally {
          await databaseClaim.release();
        }
      },
    );
  });
});
