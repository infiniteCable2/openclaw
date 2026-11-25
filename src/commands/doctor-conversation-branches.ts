import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds } from "../agents/agent-roster.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import { conversationKnowledgeLegacySourceNeedsPrivateProof } from "../config/sessions/conversation-audience.js";
import {
  CONVERSATION_KNOWLEDGE_CHECKPOINT,
  prepareConversationKnowledgeCheckpointCoverage,
  readConversationKnowledgeCheckpoint,
  type ConversationKnowledgeCheckpoint,
} from "../config/sessions/conversation-knowledge-checkpoint.js";
import { selectConversationKnowledgeReceipts } from "../config/sessions/conversation-knowledge-selection.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_UTTERANCE_REPORT,
  readConversationKnowledgeReceipt,
  readConversationUtteranceObservation,
  type ConversationKnowledgeReference,
} from "../config/sessions/conversation-knowledge.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { resolveSessionChannelParticipant } from "../config/sessions/session-channel-participant.js";
import { assertSessionConversationRootEntry } from "../config/sessions/session-conversation-admission.js";
import { resolveAgentConversationRootSessionKey } from "../config/sessions/session-conversation-root-key.js";
import { captureSessionConversationTopology } from "../config/sessions/session-conversation-topology.js";
import { sessionTranscriptIndexNeedsReconcile } from "../config/sessions/session-transcript-index.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import {
  transcriptEventJsonSql,
  transcriptEventNavigationSql,
} from "../config/sessions/transcript-payload.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { jsonExtractText } from "../infra/database-engine/json-values.js";
import { executeSqliteQueryTakeFirstSync, iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import { resolveTargetSqliteOptions } from "../infra/session-sqlite-migration-readers.js";
import { resolveSqliteInspectionSignal } from "../infra/sqlite-readonly-worker.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../state/openclaw-agent-db-readonly.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
} from "../state/openclaw-state-db-readonly.js";
import { inspectUserChannelIdentityLinkInDatabase } from "../state/user-channel-identities.js";
import type { UserChannelIdentity } from "../state/user-profiles.types.js";

const CHECK_ID = "core/doctor/conversation-branches";

const findingsByCode = {
  "root-missing": ["info", "The configured conversation root has not been found."],
  "root-invalid": ["warning", "The conversation root does not meet native admission rules."],
  "branch-root-binding": ["warning", "Live branch entries have invalid or stale root membership."],
  "reference-invalid": [
    "warning",
    "Active root reports contain unreadable contribution references.",
  ],
  "source-missing": ["warning", "Contribution references have no retained source transcript."],
  "source-historical": [
    "info",
    "Contribution references have retained history for a source session instance that is no longer current.",
  ],
  "source-audience-unavailable": [
    "warning",
    "Retained contribution references lack both a saved private scope and a verifiable private source participant.",
  ],
  "anchor-unresolved": [
    "info",
    "Contribution anchors do not match the current source projection. Native history reads may still recover the range.",
  ],
  "checkpoint-invalid": [
    "warning",
    "Active root checkpoints include invalid records or broken coverage chains.",
  ],
  "source-not-checked": [
    "info",
    "Some contribution ranges could not be checked in the current source projection.",
  ],
  "inspection-unavailable": [
    "warning",
    "The complete conversation-branch inspection was unavailable.",
  ],
} as const;

type FindingCode = keyof typeof findingsByCode;
type SubjectGroup = { identity: UserChannelIdentity; references: number };
type BranchScan = {
  counts: Map<FindingCode, number>;
  missingSourceSessions: Set<string>;
  unattributedSourceSessions: Set<string>;
  historicalWithoutPrivateRange: number;
  subjects: Map<string, SubjectGroup>;
};

function readSource(
  database: OpenClawAgentReadOnlyDatabase,
  source: ConversationKnowledgeReference["source"],
) {
  const db = getSessionKysely(database.db);
  const first = executeSqliteQueryTakeFirstSync;
  const entry = readExactSessionEntryRow(database, source.sessionKey)?.entry;
  const hot = first(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", source.sessionId)
      .limit(1),
  );
  const cold = first(
    database.db,
    db
      .selectFrom("session_transcript_cold_archives")
      .select("session_id")
      .where("session_id", "=", source.sessionId)
      .limit(1),
  );
  const retained =
    hot ||
    cold ||
    first(
      database.db,
      db
        .selectFrom("session_transcript_archives")
        .select("session_id")
        .where("session_id", "=", source.sessionId)
        .limit(1),
    );
  return {
    retained: Boolean(retained),
    current:
      entry?.sessionId === source.sessionId && entry.lifecycleRevision === source.lifecycleRevision
        ? entry
        : undefined,
    anchorsReadable: Boolean(
      hot && !cold && !sessionTranscriptIndexNeedsReconcile(database.db, source.sessionId),
    ),
    anchors: new Map<string, TranscriptEntryAnchor | undefined>(),
  };
}

function scanAgent(
  database: OpenClawAgentReadOnlyDatabase,
  agentId: string,
  rootKey: string,
  signal?: AbortSignal,
): BranchScan {
  const scan: BranchScan = {
    counts: new Map(),
    missingSourceSessions: new Set(),
    unattributedSourceSessions: new Set(),
    historicalWithoutPrivateRange: 0,
    subjects: new Map(),
  };
  const { counts, missingSourceSessions, subjects } = scan;
  const count = (code: FindingCode) => counts.set(code, (counts.get(code) ?? 0) + 1);
  const db = getSessionKysely(database.db);
  const rootPresent = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_nodes").select("session_key").where("session_key", "=", rootKey),
  );
  let validRoot: (InternalSessionEntry & { lifecycleRevision: string }) | undefined;
  if (rootPresent) {
    try {
      const root = readExactSessionEntryRow(database, rootKey)?.entry;
      assertSessionConversationRootEntry(root, rootKey);
      validRoot = root;
    } catch {
      count("root-invalid");
    }
  } else {
    count("root-missing");
  }

  const topologyRows = db
    .selectFrom("session_nodes")
    .select("session_key")
    .select((eb) =>
      jsonExtractText(database.db, eb.ref("entry_json"), "conversationTopology").as("topology"),
    )
    .where("entry_valid", "=", 1)
    .where("archived_at", "is", null)
    .where(
      (eb) => jsonExtractText(database.db, eb.ref("entry_json"), "conversationTopology"),
      "is not",
      null,
    );
  for (const row of iterateSqliteQuerySync(database.db, topologyRows)) {
    signal?.throwIfAborted();
    if (resolveAgentIdFromSessionKey(row.session_key) !== agentId) {
      continue;
    }
    try {
      const topology = captureSessionConversationTopology(JSON.parse(row.topology!));
      if (
        !topology ||
        (topology.role === "root"
          ? row.session_key !== rootKey
          : topology.rootSessionKey !== rootKey ||
            topology.rootSessionId !== validRoot?.sessionId ||
            topology.rootSessionLifecycleRevision !== validRoot?.lifecycleRevision)
      ) {
        count("branch-root-binding");
      }
    } catch {
      count("branch-root-binding");
    }
  }
  if (!validRoot) {
    return scan;
  }
  const { sessionId, lifecycleRevision } = validRoot;
  const coldRoot = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_transcript_cold_archives")
      .select("session_id")
      .where("session_id", "=", sessionId),
  );
  if (coldRoot || sessionTranscriptIndexNeedsReconcile(database.db, sessionId)) {
    count("inspection-unavailable");
    return scan;
  }
  // Read only the current root's known reports. The native payload reader also decodes compressed rows.
  const reportRows = db
    .selectFrom("transcript_events as event")
    .innerJoin("session_transcript_active_events as active", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .select(transcriptEventJsonSql(database.db, "event").as("event_json"))
    .where("event.session_id", "=", sessionId)
    .where(
      jsonExtractText(
        database.db,
        transcriptEventNavigationSql(database.db, "event"),
        "customType",
      ),
      "in",
      [
        CONVERSATION_KNOWLEDGE_REPORT,
        CONVERSATION_UTTERANCE_REPORT,
        CONVERSATION_KNOWLEDGE_CHECKPOINT,
      ],
    )
    .orderBy("event.seq");
  const events: Record<string, unknown>[] = [];
  const checkpoints: ConversationKnowledgeCheckpoint[] = [];
  const heads = new Map<string, ConversationKnowledgeCheckpoint>();
  for (const row of iterateSqliteQuerySync(database.db, reportRows)) {
    signal?.throwIfAborted();
    const event = asOptionalRecord(JSON.parse(row.event_json));
    if (event?.customType === CONVERSATION_KNOWLEDGE_CHECKPOINT) {
      const checkpoint = readConversationKnowledgeCheckpoint(event.details);
      if (!checkpoint || event.type !== "custom_message") {
        count("checkpoint-invalid");
      } else if (
        checkpoint.root.sessionId === sessionId &&
        checkpoint.root.lifecycleRevision === lifecycleRevision &&
        checkpoint.root.agentId === agentId
      ) {
        checkpoints.push(checkpoint);
        heads.set(checkpoint.audienceKey, checkpoint);
      }
    } else if (
      event?.type === "custom_message" &&
      (event.customType === CONVERSATION_KNOWLEDGE_REPORT
        ? readConversationKnowledgeReceipt(event.details)
        : readConversationUtteranceObservation(event.details))
    ) {
      events.push(event);
    } else {
      count("reference-invalid");
    }
  }
  for (const checkpoint of heads.values()) {
    try {
      prepareConversationKnowledgeCheckpointCoverage({
        checkpoint,
        records: checkpoints,
        assertCurrent: () => signal?.throwIfAborted(),
      });
    } catch {
      signal?.throwIfAborted();
      count("checkpoint-invalid");
    }
  }
  const sources = new Map<string, ReturnType<typeof readSource> | undefined>();
  for (const reference of selectConversationKnowledgeReceipts(
    events,
    sessionId,
    rootKey,
    "branches",
    lifecycleRevision,
  )) {
    signal?.throwIfAborted();
    const source = reference.source;
    if (source.agentId !== agentId) {
      count("source-not-checked");
      continue;
    }
    const key = JSON.stringify([source.sessionKey, source.sessionId, source.lifecycleRevision]);
    if (!sources.has(key)) {
      try {
        sources.set(key, readSource(database, source));
      } catch {
        signal?.throwIfAborted();
        sources.set(key, undefined);
      }
    }
    const facts = sources.get(key);
    if (!facts) {
      count("source-not-checked");
      continue;
    }
    if (!facts.retained) {
      missingSourceSessions.add(source.sessionId);
      count("source-missing");
      continue;
    }
    if (!facts.current) {
      count("source-historical");
      if (!reference.privateAudience) {
        scan.historicalWithoutPrivateRange++;
      }
      continue;
    }
    if (
      !reference.privateAudience &&
      !reference.readRange &&
      conversationKnowledgeLegacySourceNeedsPrivateProof(facts.current)
    ) {
      count("source-audience-unavailable");
      scan.unattributedSourceSessions.add(key);
    }
    const participant = reference.privateAudience?.participant;
    const identity = participant && resolveSessionChannelParticipant(facts.current, participant);
    if (identity) {
      const subject = JSON.stringify(identity);
      const group = subjects.get(subject) ?? { identity, references: 0 };
      group.references++;
      subjects.set(subject, group);
    }
    if (!facts.anchorsReadable) {
      count("source-not-checked");
      continue;
    }
    const through = reference.readRange?.through ?? reference.through;
    const from = reference.readRange?.admission ?? reference.privateAudience?.admission;
    if (
      [through, ...(from ? [from] : [])].some((expected) => {
        if (!facts.anchors.has(expected.entryId)) {
          facts.anchors.set(
            expected.entryId,
            readActiveTranscriptEntryAnchorInTransaction({
              database,
              resolved: source,
              entryId: expected.entryId,
            }),
          );
        }
        const current = facts.anchors.get(expected.entryId);
        // A copied store may have a different physical path. Compare the logical endpoint.
        return (
          !current ||
          current.generation !== expected.generation ||
          current.rawSeq !== expected.rawSeq ||
          current.effectiveParentId !== expected.effectiveParentId ||
          current.activeMessagePosition !== expected.activeMessagePosition
        );
      })
    ) {
      count("anchor-unresolved");
    }
  }
  return scan;
}

export async function detectConversationBranchFindings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<HealthFinding[]> {
  const signal = resolveSqliteInspectionSignal();
  const env = params.env ?? process.env;
  return withArtifactPreservingStateReads(
    async () => {
      const findings: HealthFinding[] = [];
      const scans = new Map<string, BranchScan>();
      for (const agentId of listAgentIds(params.cfg)) {
        signal?.throwIfAborted();
        if (resolveAgentConversationMode(params.cfg, agentId) !== "branches") {
          continue;
        }
        try {
          const rootKey = resolveAgentConversationRootSessionKey({ cfg: params.cfg, agentId });
          const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
            agentId,
            env,
          });
          const read = withOpenClawAgentDatabaseReadOnly(
            (database) => scanAgent(database, agentId, rootKey, signal),
            resolveTargetSqliteOptions({ agentId, storePath }, env),
            { snapshot: true },
          );
          if (read.found) {
            scans.set(agentId, read.value);
            for (const [code, count] of read.value.counts) {
              const [severity, message] = findingsByCode[code];
              const details: Record<string, number> = { count };
              let summary = `${message} Count: ${count}.`;
              if (code === "source-missing" || code === "source-audience-unavailable") {
                const sourceSessions =
                  code === "source-missing"
                    ? read.value.missingSourceSessions.size
                    : read.value.unattributedSourceSessions.size;
                details.sourceSessions = sourceSessions;
                summary = `${message} References: ${count}. Source sessions: ${sourceSessions}.`;
              }
              if (code === "source-historical") {
                const withoutPrivateRange = read.value.historicalWithoutPrivateRange;
                details.referencesWithoutPrivateRange = withoutPrivateRange;
                if (withoutPrivateRange > 0) {
                  summary += ` References without a saved private range: ${withoutPrivateRange}.`;
                }
              }
              findings.push({
                checkId: CHECK_ID,
                severity,
                message: summary,
                target: agentId,
                errorCode: code,
                details,
              });
            }
          } else {
            const code =
              read.reason === "database-missing" ? "root-missing" : "inspection-unavailable";
            const [severity, message] = findingsByCode[code];
            findings.push({
              checkId: CHECK_ID,
              severity,
              message,
              target: agentId,
              errorCode: code,
            });
          }
        } catch {
          signal?.throwIfAborted();
          findings.push({
            checkId: CHECK_ID,
            severity: "warning",
            message: findingsByCode["inspection-unavailable"][1],
            target: agentId,
            errorCode: "inspection-unavailable",
          });
        }
      }
      const subjects = new Map<string, SubjectGroup>();
      for (const scan of scans.values()) {
        for (const [subject, group] of scan.subjects) {
          subjects.set(subject, group);
        }
      }
      if (subjects.size === 0) {
        return findings;
      }
      let links:
        | Map<string, ReturnType<typeof inspectUserChannelIdentityLinkInDatabase>>
        | undefined;
      try {
        links = await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
          ({ db }) =>
            runSqliteReadSnapshotSync(
              db,
              () => {
                return new Map(
                  [...subjects].map(([subject, group]) => {
                    signal?.throwIfAborted();
                    return [subject, inspectUserChannelIdentityLinkInDatabase(db, group.identity)];
                  }),
                );
              },
              { operationLabel: "doctor.conversation-branches.profile-links" },
            ),
          { env },
        );
      } catch {
        signal?.throwIfAborted();
      }
      for (const [agentId, scan] of scans) {
        if (scan.subjects.size === 0) {
          continue;
        }
        const unavailable = [...scan.subjects.keys()].filter(
          (subject) => !links || links.get(subject) === "unavailable",
        );
        if (unavailable.length > 0) {
          findings.push({
            checkId: CHECK_ID,
            severity: "info",
            target: agentId,
            errorCode: "identity-check-unavailable",
            message: "Canonical channel profile links could not be verified.",
            details: { identityGroups: unavailable.length },
          });
        }
        const unusable = [...scan.subjects].filter(
          ([subject]) => links?.get(subject) === "unusable",
        );
        if (unusable.length > 0) {
          findings.push({
            checkId: CHECK_ID,
            severity: "warning",
            target: agentId,
            errorCode: "channel-identity-link-unusable",
            message:
              "Stored channel identity links point to profiles that cannot be used for attribution.",
            fixHint:
              "Inspect the stored profile links through user profile administration before changing them.",
            details: { identityGroups: unusable.length },
          });
        }
        const counts = [...scan.subjects]
          .filter(([subject]) => links?.get(subject) === "unlinked")
          .map(([, group]) => group.references)
          .toSorted((a, b) => b - a);
        if (counts.length > 0) {
          const references = counts.reduce((sum, count) => sum + count, 0);
          findings.push({
            checkId: CHECK_ID,
            severity: "info",
            target: agentId,
            errorCode: "channel-identity-unlinked",
            message: `${references} private contribution references across ${counts.length} channel identities have no canonical profile link for cross-channel attribution.`,
            fixHint:
              "If cross-channel attribution is intended, verify the channel account and sender independently and link the verified identity through user profile administration. Rerun Doctor to confirm.",
            details: { references, identityGroups: counts.length, referencesPerGroup: counts },
          });
        }
      }
      return findings;
    },
    { agentDatabases: true },
  );
}
