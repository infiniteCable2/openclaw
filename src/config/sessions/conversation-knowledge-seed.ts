import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../sessions/transcript-events.js";
import { readConversationKnowledgeReports } from "./conversation-knowledge-history.js";
import {
  ConversationKnowledgeSourceCapacityError,
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
import { withSessionTranscriptDeltaReader } from "./session-transcript-delta-read.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { isSessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";
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
            // Host rechecks and native COMMIT must compare the same authority,
            // not unrelated activity/usage metadata changed by concurrent work.
            expected: structuredClone(
              Object.fromEntries(
                fields.map((field) => [
                  field,
                  (sessionKey === branch.sessionKey ? source : root)[field],
                ]),
              ),
            ),
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
  status: "not-enrolled" | "already-seeded" | "seeded" | "resumed" | "pending";
  reason?: "source-capacity";
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
  // Completed enrollment is the steady-state path. Filter in the native reader
  // so checking its marker does not hydrate every contribution in the root.
  const markers = await readConversationKnowledgeReports({
    target: root,
    customTypes: [CONVERSATION_KNOWLEDGE_SEED],
    assertCurrent: check,
    signal: params.signal,
  });
  check();
  if (
    markers.some((event) => {
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
  const reports = await readConversationKnowledgeReports({
    target: root,
    customTypes: [CONVERSATION_KNOWLEDGE_REPORT, CONVERSATION_UTTERANCE_REPORT],
    assertCurrent: check,
    signal: params.signal,
  });
  check();
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
  // Pin the complete native version before paging, including opaque navigation
  // changes that preserve generation and sequence but advance updatedAt.
  const metadata = prepareSessionTranscriptHydration(branch, undefined, params.signal);
  const initial = await metadata.readMaintenance({ operation: "version" });
  metadata.assertCurrent();
  check();
  if (!initial.version) {
    throw new Error("Conversation knowledge seed source version is unavailable");
  }
  const sourceVersion = structuredClone(initial.version);
  const through = { generation: sourceVersion.generation, maxSeq: sourceVersion.rawSeq };
  let recorded = 0;
  let skipped = 0;
  let pendingCapacity = false;
  const inheritedSource = asOptionalRecord(
    expected.find((predicate) => predicate.sessionKey === branch.sessionKey)?.expected.forkSource,
  );
  let inheritedEndpointPending =
    typeof inheritedSource?.entryId === "string" ? inheritedSource.entryId : undefined;
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
            if (!Number.isSafeInteger(page.requiredBytes) || page.requiredBytes <= maxBytes) {
              throw new Error("Conversation knowledge seed byte request made no progress");
            }
            if (page.requiredBytes > CONVERSATION_KNOWLEDGE_SOURCE_LIMITS.maxBytes) {
              pendingCapacity = true;
              break;
            }
            maxBytes = page.requiredBytes;
            continue;
          }
          for (const row of page.events) {
            if (row.seq > (through.maxSeq ?? -1)) {
              break;
            }
            const event = asOptionalRecord(row.event);
            // Native copies retain the donor's run metadata. Its exact copied
            // endpoint is fenced above; only the child's subsequent tail is ours.
            if (inheritedEndpointPending !== undefined) {
              if (event?.id === inheritedEndpointPending) {
                inheritedEndpointPending = undefined;
              }
              continue;
            }
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
              resolveTerminalAssistantTranscriptRunId(message, runId)
            ) {
              try {
                accepted = await recordConversationKnowledgeTurn({
                  ...params,
                  sourceMode: "native",
                  runId,
                  assistantTranscriptEntryId: event.id,
                  ...(typeof message.idempotencyKey === "string" && message.idempotencyKey.trim()
                    ? { assistantTranscriptIdempotencyKey: message.idempotencyKey }
                    : {}),
                });
              } catch (error) {
                check();
                if (!(error instanceof ConversationKnowledgeSourceCapacityError)) {
                  throw error;
                }
                pendingCapacity = true;
                break;
              }
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
                try {
                  accepted = await recordConversationUtteranceObservation({
                    ...params,
                    sourceMode: "native",
                    anchor,
                    role: message.role,
                  });
                } catch (error) {
                  check();
                  if (!(error instanceof ConversationKnowledgeSourceCapacityError)) {
                    throw error;
                  }
                  pendingCapacity = true;
                  break;
                }
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
            pendingCapacity ||
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
  // Traversal, not a second bounded model-context view, proves the prefix was
  // visited. The metadata version fences that traversal through marker COMMIT.
  const { version } = await metadata.readMaintenance({ operation: "version" });
  metadata.assertCurrent();
  check();
  if (!version || !isDeepStrictEqual(version, sourceVersion)) {
    throw new Error("Conversation knowledge seed source changed before completion");
  }
  const current = await captureSeedSources(params.reader, branch, params.assertCurrent);
  check();
  if (!isDeepStrictEqual(current, expected)) {
    throw new Error("Conversation knowledge seed authority changed");
  }
  if (pendingCapacity) {
    return { status: "pending", reason: "source-capacity", recorded, skipped };
  }
  if (inheritedEndpointPending !== undefined) {
    // A rewritten path may no longer contain the recorded copy boundary. Never
    // acknowledge traversal or relabel donor history when that boundary is lost.
    return { status: "pending", recorded, skipped };
  }
  const predicates = expected.map((predicate, index) =>
    index === 0
      ? Object.assign({}, predicate, { transcript: { sessionId: branch.sessionId, version } })
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
