import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../sessions/transcript-events.js";
import { readConversationKnowledgeReports } from "./conversation-knowledge-history.js";
import {
  readConversationKnowledgeBranch,
  recordConversationKnowledgeTurn,
  recordConversationUtteranceObservation,
  type ConversationKnowledgeBranch,
} from "./conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_KNOWLEDGE_SOURCE_LIMITS,
  CONVERSATION_UTTERANCE_REPORT,
  conversationKnowledgeOrigin,
  isConversationUtteranceObservation,
  readConversationKnowledgeReceipt,
  readConversationUtteranceObservation,
  type ConversationUtteranceObservation,
} from "./conversation-knowledge.js";
import { appendSessionTranscriptReport } from "./session-accessor.sqlite-transcript-reports.js";
import { assertSessionConversationRootEntry } from "./session-conversation-admission.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
  type SessionSourcePredicate,
} from "./session-source-authority.js";
import { readActiveTranscriptEntryAnchorAsync } from "./session-transcript-anchor-read.js";
import { readSessionTranscriptModelContextAsync } from "./session-transcript-context-read.js";
import { withSessionTranscriptDeltaReader } from "./session-transcript-delta-read.js";
import { isSessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";
import { readSessionTranscriptWatermarkAsync } from "./session-transcript-watermark.js";
import type { InternalSessionEntry } from "./types.js";

export const CONVERSATION_KNOWLEDGE_SEED = "openclaw.conversation-knowledge-seed.v1";
const fields = [
  "sessionId",
  "lifecycleRevision",
  "conversationTopology",
  "incognito",
  "chatType",
  "publicShare",
  "participantCount",
  "participants",
  "createdVia",
  "createdActor",
  "visibility",
  "delivery",
  "owner",
  "parentSessionKey",
  "parentSessionId",
  "parentSessionLifecycleRevision",
  "spawnedBy",
  "spawnedBySessionId",
  "spawnDepth",
  "forkSource",
  "forkedFromParent",
] as const satisfies readonly (keyof InternalSessionEntry)[];

async function captureSeedSources(
  reader: SessionEntryCohortReader,
  branch: ConversationKnowledgeBranch,
  assertCurrent: SessionSourceAssertion,
) {
  return reader.withRead(
    { sessionKeys: [branch.sessionKey, branch.root.sessionKey], includeMembers: true },
    assertCurrent,
    (facts) => {
      const source = facts.entries.find((row) => row.sessionKey === branch.sessionKey)?.entry;
      const root = facts.entries.find((row) => row.sessionKey === branch.root.sessionKey)?.entry;
      assertSessionConversationRootEntry(root, branch.root.sessionKey);
      if (
        source?.sessionId !== branch.sessionId ||
        source.lifecycleRevision !== branch.lifecycleRevision ||
        source.incognito ||
        source.conversationTopology?.role !== "branch" ||
        source.conversationTopology.rootSessionKey !== branch.root.sessionKey ||
        source.conversationTopology.rootSessionId !== root.sessionId ||
        source.conversationTopology.rootSessionLifecycleRevision !== root.lifecycleRevision ||
        root.sessionId !== branch.root.sessionId ||
        root.lifecycleRevision !== branch.root.lifecycleRevision
      ) {
        throw new Error("Conversation knowledge seed enrollment changed");
      }
      return [branch.sessionKey, branch.root.sessionKey].map(
        (sessionKey) =>
          ({
            source: facts.source,
            sessionKey,
            fields: [...fields],
            expected: structuredClone(sessionKey === branch.sessionKey ? source : root),
            members: facts.members?.[sessionKey]?.map((member) => member.identityId) ?? [],
          }) satisfies SessionSourcePredicate,
      );
    },
  );
}

/** One-off explicit enrollment only; no ongoing native sharing or inferred history ownership. */
export async function ensureConversationKnowledgeSeed(params: {
  reader: SessionEntryCohortReader;
  sessionId: string;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
}): Promise<{
  status: "not-enrolled" | "already-seeded" | "seeded" | "resumed";
  recorded: number;
  skipped: number;
}> {
  const check = () => {
    params.signal?.throwIfAborted();
    params.reader.assertCurrent();
    params.assertCurrent();
  };
  check();
  const branch = await readConversationKnowledgeBranch(params);
  check();
  if (!branch) {
    return { status: "not-enrolled", recorded: 0, skipped: 0 };
  }
  const expected = await captureSeedSources(params.reader, branch, params.assertCurrent);
  check();
  const root = { ...branch, sessionKey: branch.root.sessionKey, sessionId: branch.root.sessionId };
  const seedId = sha256Hex(
    JSON.stringify([branch.sessionKey, branch.sessionId, branch.lifecycleRevision]),
  );
  const reports = await readConversationKnowledgeReports({
    target: root,
    customTypes: [
      CONVERSATION_KNOWLEDGE_SEED,
      CONVERSATION_KNOWLEDGE_REPORT,
      CONVERSATION_UTTERANCE_REPORT,
    ],
    assertCurrent: check,
    signal: params.signal,
  });
  check();
  if (
    reports.some((event) => {
      const record = asOptionalRecord(event);
      const detail = asOptionalRecord(record?.details);
      return (
        record?.customType === CONVERSATION_KNOWLEDGE_SEED &&
        detail?.version === 1 &&
        detail.seedId === seedId &&
        detail.complete === true
      );
    })
  ) {
    const current = await captureSeedSources(params.reader, branch, params.assertCurrent);
    check();
    if (!isDeepStrictEqual(current, expected)) {
      throw new Error("Conversation knowledge seed authority changed");
    }
    return { status: "already-seeded", recorded: 0, skipped: 0 };
  }
  const resumed = reports.some((event) => {
    const record = asOptionalRecord(event);
    const receipt =
      readConversationKnowledgeReceipt(record?.details) ??
      readConversationUtteranceObservation(record?.details);
    return (
      receipt?.sourceMode === "native" &&
      receipt.source.sessionId === branch.sessionId &&
      receipt.source.lifecycleRevision === branch.lifecycleRevision
    );
  });
  const through = await readSessionTranscriptWatermarkAsync(branch);
  check();
  let recorded = 0;
  let skipped = 0;
  // A newly admitted row can legitimately have no transcript yet. Its empty
  // version is still captured below and fenced by the native marker writer.
  if (through.generation !== null || through.maxSeq !== null) {
    await withSessionTranscriptDeltaReader(
      branch,
      async (reader) => {
        let cursor: string | undefined;
        let maxBytes = 1_000_000;
        for (;;) {
          check();
          const limits = { cursor, maxEvents: 96, maxBytes, activePathOnly: true };
          const page = await reader.raw(limits).catch(async (error: unknown) => {
            if (!isSessionTranscriptProjectionUnavailableError(error)) {
              throw error;
            }
            check();
            await waitForSessionTranscriptProjection(branch, params.signal);
            check();
            return reader.raw(limits);
          });
          check();
          if (page.kind !== "page") {
            throw new Error("Conversation knowledge seed history changed");
          }
          if (page.requiredBytes !== undefined) {
            if (
              page.requiredBytes <= maxBytes ||
              page.requiredBytes > CONVERSATION_KNOWLEDGE_SOURCE_LIMITS.maxBytes
            ) {
              throw new Error(
                "Conversation knowledge seed remains pending: oversized source entry",
              );
            }
            maxBytes = page.requiredBytes;
            continue;
          }
          for (const row of page.events) {
            if (row.seq > (through.maxSeq ?? -1)) {
              break;
            }
            const event = asOptionalRecord(row.event);
            const message = asOptionalRecord(event?.message);
            if (event?.type !== "message" || !message || typeof event.id !== "string") {
              continue;
            }
            const runId = readSessionTranscriptRunId(message);
            let accepted: boolean | undefined;
            if (
              message.role === "assistant" &&
              message.stopReason === "stop" &&
              message.endTurn !== false &&
              runId &&
              resolveTerminalAssistantTranscriptRunId(message, runId) &&
              typeof message.idempotencyKey === "string" &&
              message.idempotencyKey.trim()
            ) {
              accepted = await recordConversationKnowledgeTurn({
                ...params,
                sourceMode: "native",
                runId,
                assistantTranscriptIdempotencyKey: message.idempotencyKey,
              });
            } else if (
              asOptionalRecord(message.provenance)?.kind === "realtime_voice" &&
              (message.role === "user" || message.role === "assistant")
            ) {
              const anchor = await readActiveTranscriptEntryAnchorAsync(
                { ...branch, entryId: event.id },
                params.signal,
              );
              check();
              if (!anchor) {
                throw new Error("Conversation knowledge seed source anchor disappeared");
              }
              const candidate = {
                version: 1 as const,
                sourceMode: "native" as const,
                source: branch,
                origin: conversationKnowledgeOrigin(branch, "utterance-observation"),
                kind: "utterance-observation" as const,
                role: message.role,
                through: anchor,
              } satisfies ConversationUtteranceObservation;
              if (isConversationUtteranceObservation(candidate, [row.event])) {
                accepted = await recordConversationUtteranceObservation({
                  ...params,
                  sourceMode: "native",
                  anchor,
                  role: message.role,
                });
              }
            }
            check();
            if (accepted) {
              recorded += 1;
            } else if (message.role === "assistant" || message.role === "user") {
              skipped += 1;
            }
          }
          if (
            !page.hasMore ||
            (page.events.at(-1)?.seq ?? -1) >= (through.maxSeq ?? -1) ||
            page.events.length === 0
          ) {
            break;
          }
          if (cursor === page.cursor) {
            throw new Error("Conversation knowledge seed made no progress");
          }
          cursor = page.cursor;
        }
      },
      params.signal,
    );
  }
  check();
  const version = await readSessionTranscriptModelContextAsync(
    branch,
    (context) => {
      if (context.truncated) {
        throw new Error("Conversation knowledge seed remains pending: source exceeds seed budget");
      }
      return context.version;
    },
    undefined,
    params.signal,
    undefined,
    CONVERSATION_KNOWLEDGE_SOURCE_LIMITS,
  );
  check();
  if (!version || version.generation !== through.generation || version.rawSeq !== through.maxSeq) {
    throw new Error("Conversation knowledge seed source changed before completion");
  }
  const current = await captureSeedSources(params.reader, branch, params.assertCurrent);
  check();
  if (!isDeepStrictEqual(current, expected)) {
    throw new Error("Conversation knowledge seed authority changed");
  }
  const predicates = expected.map((predicate, index) =>
    index === 0
      ? { ...predicate, transcript: { sessionId: branch.sessionId, version } }
      : predicate,
  );
  const source = composeSessionSourceAssertion([
    params.assertCurrent,
    Object.assign(check, {
      prepareSessionSource: async () => ({
        assertCurrent: check,
        checks: predicates.map((predicate) => ({
          predicate,
          refuse: (): never => {
            throw new Error("Conversation knowledge seed source changed before commit");
          },
        })),
      }),
    }),
  ]);
  const result = await appendSessionTranscriptReport(
    { ...root, expectedLifecycleRevision: branch.root.lifecycleRevision },
    {
      kind: "custom",
      customTypes: [CONVERSATION_KNOWLEDGE_SEED],
      receipt: { field: "seedId", value: seedId },
      selectReport: (latest) =>
        asOptionalRecord(latest?.details)?.complete === true
          ? undefined
          : {
              customType: CONVERSATION_KNOWLEDGE_SEED,
              display: false,
              content:
                "Explicit native conversation seed traversal completed; no task was executed.",
              details: {
                version: 1,
                seedId,
                complete: true,
                sourceSessionId: branch.sessionId,
                sourceLifecycleRevision: branch.lifecycleRevision,
                through,
              },
            },
    },
    { source },
  );
  check();
  if (!result.ok) {
    throw new Error("Conversation knowledge seed completion was refused");
  }
  return { status: resumed ? "resumed" : "seeded", recorded, skipped };
}
