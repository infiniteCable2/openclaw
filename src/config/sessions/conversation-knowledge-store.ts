import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
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

export {
  assertNativeKnowledgeRootContribution,
  assertNativeKnowledgeRootContributionGroup,
  issuePreparedKnowledgeRootCandidates,
  prepareNativeKnowledgeRootContributionGroup,
  readConversationKnowledgeRoot,
  readPreparedConversationKnowledgeRoot,
  readPreparedConversationKnowledgeRootEvidence,
  type NativeKnowledgeRootContributionGroup,
  type NativeKnowledgeRootEvidence,
  type PreparedKnowledgeRootCandidates,
} from "./conversation-knowledge-root-store.js";

export type ConversationKnowledgeBranch = SessionTranscriptRuntimeTarget & {
  agentId: string;
  sessionKey: string;
  storePath: string;
  lifecycleRevision: string;
  root: { sessionKey: string; sessionId: string; lifecycleRevision: string };
};

/** The bounded source view cannot prove this occurrence; it is not an invalid occurrence. */
export class ConversationKnowledgeSourceCapacityError extends Error {
  constructor() {
    super("Conversation knowledge source validation exceeds its bounded context");
    this.name = "ConversationKnowledgeSourceCapacityError";
  }
}

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
  assistantTranscriptEntryId?: string;
  assistantTranscriptIdempotencyKey?: string;
  /** Captured from this turn's admitted configuration, never from settlement-time config. */
  sourceMode: "native" | "branches";
  privateAudience?: ConversationKnowledgeReference["privateAudience"];
  observed?: ConversationKnowledgeFrontier[];
  signal?: AbortSignal;
}): Promise<boolean> {
  const privateAudience = params.privateAudience && structuredClone(params.privateAudience);
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
  let entryId = params.assistantTranscriptEntryId;
  if (params.assistantTranscriptIdempotencyKey) {
    const found = await findTranscriptEvent(branch, {
      kind: "idempotency",
      key: params.assistantTranscriptIdempotencyKey,
      assistant: true,
      runId: params.runId,
    });
    check();
    const event = asOptionalRecord(found?.event);
    const message = asOptionalRecord(event?.message);
    if (
      !event ||
      typeof event.id !== "string" ||
      (entryId !== undefined && entryId !== event.id) ||
      message?.role !== "assistant" ||
      message.stopReason !== "stop" ||
      readSessionTranscriptRunId(message) !== params.runId
    ) {
      return false;
    }
    entryId = event.id;
  }
  if (!entryId?.trim() || entryId !== entryId.trim()) {
    return false;
  }
  // The exact active anchor selects one committed occurrence. The shared report
  // owner still validates that entry's run, completion, audience range and COMMIT.
  const through = await readActiveTranscriptEntryAnchorAsync({ ...branch, entryId }, params.signal);
  check();
  if (!through) {
    return false;
  }
  return recordConversationKnowledgeReference({
    ...params,
    branch,
    through,
    completion: { runId: params.runId },
    privateAudience,
  });
}

/** Called only after the original voice append commits; the supplied anchor grants no authority. */
export async function recordConversationUtteranceObservation(params: {
  reader: SessionEntryCohortReader;
  assertCurrent: SessionSourceAssertion;
  sessionId: string;
  anchor: TranscriptEntryAnchor;
  role: "user" | "assistant";
  sourceMode: "native" | "branches";
  privateAudience?: ConversationKnowledgeReference["privateAudience"];
  observed?: ConversationKnowledgeFrontier[];
  signal?: AbortSignal;
}): Promise<boolean> {
  const { reader, assertCurrent, sessionId, role, signal, sourceMode } = params;
  const anchor = structuredClone(params.anchor);
  const privateAudience = params.privateAudience && structuredClone(params.privateAudience);
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
    sourceMode,
    privateAudience,
  });
}

/** Shared native report transaction keeps both reference kinds under the same current source. */
export async function recordConversationKnowledgeReference(params: {
  reader: SessionEntryCohortReader;
  assertCurrent: SessionSourceAssertion;
  sessionId: string;
  signal?: AbortSignal;
  observed?: ConversationKnowledgeFrontier[];
  branch: ConversationKnowledgeBranch;
  through: TranscriptEntryAnchor;
  sourceMode: "native" | "branches";
  completion: { runId: string } | { kind: "utterance-observation"; role: "user" | "assistant" };
  privateAudience?: ConversationKnowledgeReference["privateAudience"];
  readRange?: ConversationKnowledgeReference["readRange"];
  /** Durable journal identity selects an exact endpoint, not a source's latest report. */
  publicationId?: string;
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
      params.readRange?.through ?? through,
      {
        ...limits,
        ...(params.privateAudience
          ? { from: params.readRange?.admission ?? params.privateAudience.admission }
          : {}),
      },
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
    sourceMode: params.sourceMode,
    source: branch,
    origin: conversationKnowledgeOrigin(
      branch,
      "kind" in params.completion ? params.completion.kind : undefined,
    ),
    through,
    ...(params.readRange ? { readRange: structuredClone(params.readRange) } : {}),
    ...params.completion,
    ...(params.privateAudience ? { privateAudience: structuredClone(params.privateAudience) } : {}),
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
        if (params.privateAudience && source.publicShare !== undefined) {
          return undefined;
        }
        const sourceIdentity = {
          agentId: branch.agentId,
          sessionKey: branch.sessionKey,
          sessionId: branch.sessionId,
          lifecycleRevision: branch.lifecycleRevision,
        };
        const base = {
          version: 1,
          sourceMode: params.sourceMode,
          source: sourceIdentity,
          origin: conversationKnowledgeOrigin(
            branch,
            "kind" in params.completion ? params.completion.kind : undefined,
          ),
          through,
          ...(params.readRange ? { readRange: structuredClone(params.readRange) } : {}),
          ...(params.observed ? { observed: structuredClone(params.observed) } : {}),
          ...(params.privateAudience
            ? { privateAudience: structuredClone(params.privateAudience) }
            : {}),
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
        // A terminal-looking assistant is insufficient if the actual stored path has unclosed work.
        const valid = utterance
          ? isConversationUtteranceObservation(receipt, sourceContext.events)
          : isCompletedConversationKnowledge(receipt, sourceContext.events);
        if (!valid) {
          if (sourceContext.truncated) {
            throw new ConversationKnowledgeSourceCapacityError();
          }
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
            "publicShare",
          ],
          expected: entry,
        });
        const sourcePredicate = predicate(branch.sessionKey, source);
        sourcePredicate.transcript = {
          sessionId: branch.sessionId,
          version: sourceVersion,
          consistency: "prefix",
        };
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
          receipt: params.publicationId
            ? { field: "publicationId", value: params.publicationId }
            : { field: "origin", value: receipt.origin },
          selectReport: (latest) => {
            const report = selectConversationKnowledgeReport(receipt, latest);
            return report && params.publicationId
              ? { ...report, details: { ...receipt, publicationId: params.publicationId } }
              : report;
          },
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
