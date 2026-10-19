import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { readConversationKnowledgeReports } from "./conversation-knowledge-history.js";
import {
  CONVERSATION_KNOWLEDGE_LIMITS,
  CONVERSATION_KNOWLEDGE_SOURCE_LIMITS,
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_UTTERANCE_REPORT,
  conversationKnowledgeOrigin,
  readConversationKnowledgeReceipt,
  readConversationUtteranceObservation,
  isCompletedConversationKnowledge,
  isConversationUtteranceObservation,
  selectConversationKnowledgeReport,
  type ConversationKnowledgeFrontier,
  type ConversationKnowledgeReference,
} from "./conversation-knowledge.js";
import { appendSessionTranscriptReport } from "./session-accessor.sqlite-transcript-reports.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { assertSessionConversationRootEntry } from "./session-conversation-admission.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
  type SessionSourcePredicate,
} from "./session-source-authority.js";
import { readActiveTranscriptEntryAnchorAsync } from "./session-transcript-anchor-read.js";
import { readSessionTranscriptModelContextAsync } from "./session-transcript-context-read.js";
import { findTranscriptEvent } from "./session-transcript-match.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { InternalSessionEntry } from "./types.js";

export type ConversationKnowledgeBranch = SessionTranscriptRuntimeTarget & {
  agentId: string;
  sessionKey: string;
  storePath: string;
  lifecycleRevision: string;
  root: { sessionKey: string; sessionId: string; lifecycleRevision: string };
};

/** The admitted native reader selects metadata only; membership is never a content read grant. */
export async function readConversationKnowledgeBranch(params: {
  reader: SessionEntryCohortReader;
  assertCurrent: SessionSourceAssertion;
  sessionId: string;
}) {
  const { reader } = params;
  return reader.withRead({ sessionKeys: [reader.sessionKey] }, params.assertCurrent, (read) => {
    const entry = read.entries.find((row) => row.sessionKey === reader.sessionKey)?.entry;
    const membership = entry?.conversationTopology;
    if (
      entry?.sessionId !== params.sessionId ||
      membership?.role !== "branch" ||
      !entry.lifecycleRevision ||
      entry.incognito
    ) {
      return undefined;
    }
    return {
      agentId: reader.logicalAgentId,
      sessionKey: reader.sessionKey,
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      storePath: read.source.path,
      root: {
        sessionKey: membership.rootSessionKey,
        sessionId: membership.rootSessionId,
        lifecycleRevision: membership.rootSessionLifecycleRevision,
      },
    } satisfies ConversationKnowledgeBranch;
  });
}

/** Select the actual saved occurrence, never an ambiguous latest assistant or a forged final. */
export async function recordConversationKnowledgeTurn(params: {
  reader: SessionEntryCohortReader;
  assertCurrent: SessionSourceAssertion;
  sessionId: string;
  runId: string;
  assistantTranscriptIdempotencyKey: string;
  observed?: ConversationKnowledgeFrontier[];
  signal?: AbortSignal;
}): Promise<boolean> {
  const check = () => {
    params.signal?.throwIfAborted();
    params.reader.assertCurrent();
    params.assertCurrent();
  };
  check();
  const branch = await readConversationKnowledgeBranch(params);
  check();
  if (!branch) {
    return false;
  }
  const found = await findTranscriptEvent(branch, {
    kind: "idempotency",
    key: params.assistantTranscriptIdempotencyKey,
    assistant: true,
  });
  check();
  const event = asOptionalRecord(found?.event);
  const message = asOptionalRecord(event?.message);
  if (
    !event ||
    typeof event.id !== "string" ||
    message?.role !== "assistant" ||
    message.stopReason !== "stop" ||
    readSessionTranscriptRunId(message) !== params.runId
  ) {
    return false;
  }
  const through = await readActiveTranscriptEntryAnchorAsync(
    { ...branch, entryId: event.id },
    params.signal,
  );
  check();
  if (!through) {
    return false;
  }
  return recordConversationKnowledgeReference({
    ...params,
    branch,
    through,
    completion: { runId: params.runId },
  });
}

/** Called only after the original voice append commits; the supplied anchor grants no authority. */
export async function recordConversationUtteranceObservation(params: {
  reader: SessionEntryCohortReader;
  assertCurrent: SessionSourceAssertion;
  sessionId: string;
  anchor: TranscriptEntryAnchor;
  role: "user" | "assistant";
  observed?: ConversationKnowledgeFrontier[];
  signal?: AbortSignal;
}): Promise<boolean> {
  const { reader, assertCurrent, sessionId, role, signal } = params;
  const anchor = structuredClone(params.anchor);
  const observed = params.observed ? structuredClone(params.observed) : undefined;
  const check = () => {
    signal?.throwIfAborted();
    reader.assertCurrent();
    assertCurrent();
  };
  check();
  const branch = await readConversationKnowledgeBranch({ reader, assertCurrent, sessionId });
  check();
  if (
    !branch ||
    anchor.agentId !== branch.agentId ||
    anchor.sessionKey !== branch.sessionKey ||
    anchor.sessionId !== sessionId ||
    anchor.storePath !== branch.storePath
  ) {
    return false;
  }
  const through = await readActiveTranscriptEntryAnchorAsync(
    { ...branch, entryId: anchor.entryId },
    signal,
  );
  check();
  if (
    !through ||
    through.generation !== anchor.generation ||
    through.rawSeq !== anchor.rawSeq ||
    through.effectiveParentId !== anchor.effectiveParentId ||
    through.activeMessagePosition !== anchor.activeMessagePosition
  ) {
    return false;
  }
  return recordConversationKnowledgeReference({
    reader,
    assertCurrent,
    sessionId,
    signal,
    observed,
    branch,
    through,
    completion: { kind: "utterance-observation", role },
  });
}

/** Shared native report transaction keeps both reference kinds under the same current source. */
async function recordConversationKnowledgeReference(params: {
  reader: SessionEntryCohortReader;
  assertCurrent: SessionSourceAssertion;
  sessionId: string;
  signal?: AbortSignal;
  observed?: ConversationKnowledgeFrontier[];
  branch: ConversationKnowledgeBranch;
  through: TranscriptEntryAnchor;
  completion: { runId: string } | { kind: "utterance-observation"; role: "user" | "assistant" };
}): Promise<boolean> {
  const { branch, through } = params;
  const check = () => {
    params.signal?.throwIfAborted();
    params.reader.assertCurrent();
    params.assertCurrent();
  };
  check();
  const readContext = async (limits: { maxBytes: number; maxEvents: number }) => {
    const readContextResult = await readSessionTranscriptModelContextAsync(
      branch,
      (context) => context,
      undefined,
      params.signal,
      through,
      limits,
    );
    check();
    return readContextResult;
  };
  let sourceContext = await readContext(CONVERSATION_KNOWLEDGE_LIMITS).catch((error: unknown) => {
    check();
    if (!(error instanceof RangeError)) {
      throw error;
    }
    // A single latest entry can exceed the small validation budget entirely.
    return undefined;
  });
  const candidate = {
    version: 1,
    source: branch,
    origin: conversationKnowledgeOrigin(
      branch,
      "kind" in params.completion ? params.completion.kind : undefined,
    ),
    through,
    ...params.completion,
  } as const;
  if (
    !sourceContext ||
    (sourceContext.truncated &&
      !("kind" in candidate
        ? isConversationUtteranceObservation(candidate, sourceContext.events)
        : isCompletedConversationKnowledge(candidate, sourceContext.events)))
  ) {
    // A clipped validation tail is not evidence that a long completed exchange
    // never happened. Expand once through the same exact native source anchor.
    sourceContext = await readContext(CONVERSATION_KNOWLEDGE_SOURCE_LIMITS);
  }
  const sourceVersion = sourceContext.version;
  if (!sourceVersion) {
    return false;
  }
  return params.reader
    .withRead(
      { sessionKeys: [branch.sessionKey, branch.root.sessionKey] },
      params.assertCurrent,
      (asyncFacts) => {
        // Preparation returns immutable facts; the report owner performs the asynchronous write below.
        const source = asyncFacts.entries.find(
          (row) => row.sessionKey === branch.sessionKey,
        )?.entry;
        const root = asyncFacts.entries.find(
          (row) => row.sessionKey === branch.root.sessionKey,
        )?.entry;
        assertSessionConversationRootEntry(root, branch.root.sessionKey);
        if (
          source?.sessionId !== branch.sessionId ||
          source.lifecycleRevision !== branch.lifecycleRevision ||
          source.conversationTopology?.role !== "branch" ||
          source.conversationTopology.rootSessionKey !== branch.root.sessionKey ||
          source.conversationTopology.rootSessionId !== branch.root.sessionId ||
          source.conversationTopology.rootSessionLifecycleRevision !==
            branch.root.lifecycleRevision ||
          root.sessionId !== branch.root.sessionId ||
          root.lifecycleRevision !== branch.root.lifecycleRevision
        ) {
          throw new Error("Conversation knowledge incarnation changed");
        }
        const sourceIdentity = {
          agentId: branch.agentId,
          sessionKey: branch.sessionKey,
          sessionId: branch.sessionId,
          lifecycleRevision: branch.lifecycleRevision,
        };
        const base = {
          version: 1,
          source: sourceIdentity,
          origin: conversationKnowledgeOrigin(
            branch,
            "kind" in params.completion ? params.completion.kind : undefined,
          ),
          through,
          ...(params.observed ? { observed: structuredClone(params.observed) } : {}),
        } as const;
        const receipt: ConversationKnowledgeReference = { ...base, ...params.completion };
        const utterance = "kind" in receipt;
        if (
          utterance
            ? !readConversationUtteranceObservation(receipt)
            : !readConversationKnowledgeReceipt(receipt)
        ) {
          throw new Error("Invalid conversation knowledge reference");
        }
        if (utterance && !isConversationUtteranceObservation(receipt, sourceContext.events)) {
          return undefined;
        }
        // A terminal-looking assistant is insufficient if the actual stored path has unclosed work.
        if (!utterance && !isCompletedConversationKnowledge(receipt, sourceContext.events)) {
          return undefined;
        }
        const predicate = (
          sessionKey: string,
          entry: InternalSessionEntry,
        ): SessionSourcePredicate => ({
          source: asyncFacts.source,
          sessionKey,
          fields: [
            "sessionId",
            "lifecycleRevision",
            "conversationTopology",
            "visibility",
            "createdActor",
            "incognito",
          ],
          expected: entry,
        });
        const sourcePredicate = predicate(branch.sessionKey, source);
        sourcePredicate.transcript = { sessionId: branch.sessionId, version: sourceVersion };
        const predicates = [sourcePredicate, predicate(branch.root.sessionKey, root)];
        return { branch, receipt, predicates };
      },
    )
    .then(async (prepared) => {
      if (!prepared) {
        return false;
      }
      const { receipt, predicates } = prepared;
      const source = composeSessionSourceAssertion([
        params.assertCurrent,
        Object.assign(check, {
          prepareSessionSource: async () => ({
            assertCurrent: check,
            checks: predicates.map((predicate) => ({
              predicate,
              refuse: (): never => {
                throw new Error("Conversation knowledge source changed before report");
              },
            })),
          }),
        }),
      ]);
      check();
      const result = await appendSessionTranscriptReport(
        {
          agentId: branch.agentId,
          storePath: branch.storePath,
          sessionKey: branch.root.sessionKey,
          sessionId: branch.root.sessionId,
          expectedLifecycleRevision: branch.root.lifecycleRevision,
        },
        {
          kind: "custom",
          customTypes: [
            "kind" in receipt ? CONVERSATION_UTTERANCE_REPORT : CONVERSATION_KNOWLEDGE_REPORT,
          ],
          receipt: { field: "origin", value: receipt.origin },
          selectReport: (latest) => selectConversationKnowledgeReport(receipt, latest),
        },
        { source },
      );
      check();
      if (!result.ok) {
        throw new Error("Conversation knowledge report was refused", { cause: result.error });
      }
      return true;
    });
}

/** Host reads only opaque receipt references from its infrastructure root, never source dialogue. */
export async function readConversationKnowledgeRoot(params: {
  branch: ConversationKnowledgeBranch;
  reader: SessionEntryCohortReader;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
}) {
  const { branch, reader, assertCurrent, signal } = params;
  const validate = () =>
    reader.withRead(
      { sessionKeys: [branch.sessionKey, branch.root.sessionKey] },
      assertCurrent,
      (read) => {
        const current = read.entries.find((row) => row.sessionKey === branch.sessionKey)?.entry;
        const root = read.entries.find((row) => row.sessionKey === branch.root.sessionKey)?.entry;
        assertSessionConversationRootEntry(root, branch.root.sessionKey);
        if (
          current?.sessionId !== branch.sessionId ||
          current.lifecycleRevision !== branch.lifecycleRevision ||
          root.sessionId !== branch.root.sessionId ||
          root.lifecycleRevision !== branch.root.lifecycleRevision ||
          current.conversationTopology?.role !== "branch" ||
          current.conversationTopology.rootSessionKey !== branch.root.sessionKey ||
          current.conversationTopology.rootSessionId !== root.sessionId ||
          current.conversationTopology.rootSessionLifecycleRevision !== root.lifecycleRevision
        ) {
          throw new Error("Conversation knowledge root changed");
        }
      },
    );
  await validate();
  assertCurrent();
  const result = await readConversationKnowledgeReports({
    target: { ...branch, ...branch.root },
    customTypes: [CONVERSATION_KNOWLEDGE_REPORT, CONVERSATION_UTTERANCE_REPORT],
    assertCurrent,
    signal,
  });
  await validate();
  assertCurrent();
  return result;
}
