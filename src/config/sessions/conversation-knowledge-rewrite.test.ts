import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  createConversationKnowledgeScenario,
  person,
} from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { deriveConversationKnowledgeReadRange } from "./conversation-knowledge-rewrite.js";
import { readConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import { openConversationPublicationStore } from "./conversation-publication.js";
import { appendTranscriptMessage, upsertSessionEntryCore } from "./session-accessor.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "./session-message-rewrite.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

const admission: TranscriptEntryAnchor = {
  agentId: "main",
  storePath: "/synthetic/agent.sqlite",
  sessionKey: "agent:main:source",
  sessionId: "source",
  generation: "original",
  entryId: "user",
  rawSeq: 1,
  effectiveParentId: null,
  activeMessagePosition: 0,
};
const terminal: TranscriptEntryAnchor = {
  ...admission,
  entryId: "assistant",
  rawSeq: 2,
  effectiveParentId: "user",
  activeMessagePosition: 1,
};
const reference = {
  through: terminal,
  privateAudience: { participant: person, admission },
};
const next = {
  through: { ...terminal, generation: "next" },
  admission: { ...admission, generation: "next" },
};
const derive = (
  overrides: Partial<Parameters<typeof deriveConversationKnowledgeReadRange>[0]> = {},
) =>
  deriveConversationKnowledgeReadRange({
    reference,
    previousGeneration: "original",
    firstChangedSeq: 3,
    ...next,
    ...overrides,
  });

describe("producer-issued unchanged-prefix continuity", () => {
  it("renews only physical reads and can chain another proven rewrite", () => {
    expect(derive()).toEqual(next);
    expect(reference.through.generation).toBe("original");
    expect(reference.privateAudience.admission.generation).toBe("original");
    expect(
      derive({
        reference: { ...reference, readRange: next },
        previousGeneration: "next",
        through: { ...terminal, generation: "third" },
        admission: { ...admission, generation: "third" },
      })?.through.generation,
    ).toBe("third");
  });

  it.each([0, 1, 2])(
    "does not renew when the rewrite touches the range at %s",
    (firstChangedSeq) => {
      expect(derive({ firstChangedSeq })).toBeUndefined();
    },
  );

  it("does not retrospectively repair an already stale generation", () => {
    expect(derive({ previousGeneration: "unproven" })).toBeUndefined();
    expect(derive({ through: terminal, admission })).toBeUndefined();
  });

  it.each([
    { entryId: "different" },
    { rawSeq: 8 },
    { effectiveParentId: null },
    { activeMessagePosition: 8 },
    { storePath: "/synthetic/replaced.sqlite" },
    { sessionId: "replacement" },
  ])("refuses changed native occurrence identity %j", (change) => {
    expect(derive({ through: { ...next.through, ...change } })).toBeUndefined();
  });

  it("requires the private lower bound in the same current generation", () => {
    expect(derive({ admission: undefined })).toBeUndefined();
    expect(derive({ admission: { ...next.admission, generation: "other" } })).toBeUndefined();
    expect(derive({ admission: { ...next.admission, activeMessagePosition: 4 } })).toBeUndefined();
  });

  it("does not invent private proof and ignores only the parser's optional idempotency field", () => {
    expect(derive({ reference: { through: terminal } })).toBeUndefined();
    expect(
      derive({
        through: { ...next.through, idempotencyKey: "native-key" },
      })?.through.idempotencyKey,
    ).toBe("native-key");
  });
});

// The actual worker rewrite must atomically renew pending journal reads. A pure anchor
// comparison cannot prove that this runs inside the original transcript transaction.
it("renews a pending native publication without changing its identity or accepting stale failures", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "conversation-rewrite-continuity" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      try {
        const source = await fixture.branch("rewrite");
        const owner = await fixture.claim(source);
        const branch = await readConversationKnowledgeBranch(owner);
        if (!branch) {
          throw new Error("Expected enrolled branch");
        }
        const journal = openConversationPublicationStore({
          agentId: source.agentId,
          path: source.storePath,
          env: source.env,
          assertCurrent: owner.assertCurrent,
        });
        const user = await appendTranscriptMessage(source, {
          message: { role: "user", content: "Original private exchange.", timestamp: 1 },
        });
        if (!user.anchor) {
          throw new Error("Expected original admission");
        }
        await upsertSessionEntryCore(source, { activeWriterRunId: "writer-first" });
        const answer = await appendTranscriptMessage(source, {
          message: {
            role: "assistant",
            content: "Original answer.",
            stopReason: "stop",
            timestamp: 2,
            idempotencyKey: "first:terminal",
            __openclaw: { runId: "first" },
          },
          conversationPublication: {
            version: 1,
            kind: "completed-turn",
            runId: "first",
            sourceMode: "branches",
            source,
            root: branch.root,
            privateAudience: { participant: person, admission: user.anchor },
          },
        });
        if (!answer.anchor) {
          throw new Error("Expected original terminal");
        }
        await journal.accept({
          sessionKey: source.sessionKey,
          sessionId: source.sessionId,
          lifecycleRevision: source.lifecycleRevision,
          runId: "first",
          entryId: answer.anchor.entryId,
          idempotencyKey: "first:terminal",
        });
        const [before] = await journal.readReadyHeads({ now: Date.now(), limit: 8 });
        expect(before).toBeDefined();
        const later = await appendTranscriptMessage(source, {
          message: { role: "user", content: "A later independent turn.", timestamp: 3 },
        });
        if (!later.anchor) {
          throw new Error("Expected later native input");
        }
        const rewritten = await rewritePreparedTranscriptMessageAtAnchor(
          later.anchor,
          (message) => ({
            ...asOptionalRecord(message),
            modelPromptProjection: "Later turn's derived prompt only.",
          }),
        );
        expect(rewritten).not.toBeNull();
        const [after] = await journal.readReadyHeads({ now: Date.now(), limit: 8 });
        expect(after).toMatchObject({
          id: before!.id,
          intent: before!.intent,
          anchor: before!.anchor,
        });
        expect(after!.readRange).toEqual({
          through: { ...answer.anchor, generation: rewritten!.generation },
          admission: { ...user.anchor, generation: rewritten!.generation },
        });
        await journal.block(before!.id, {
          errorCode: "endpoint-unavailable",
          expectedGeneration: before!.anchor.generation,
        });
        expect(await journal.readReadyHeads({ now: Date.now(), limit: 8 })).toEqual([after]);

        // A content change inside the admitted range is not a continuity proof.
        const overlap = await rewritePreparedTranscriptMessageAtAnchor(
          after!.readRange!.through,
          (message) => ({ ...asOptionalRecord(message), content: "Changed historical answer." }),
        );
        expect(overlap).not.toBeNull();
        const [invalidated] = await journal.readReadyHeads({ now: Date.now(), limit: 8 });
        expect(invalidated!.readRange).toEqual(after!.readRange);
        expect(invalidated!.readRange!.through.generation).not.toBe(overlap!.generation);
      } finally {
        await fixture.close();
      }
    },
  );
});
