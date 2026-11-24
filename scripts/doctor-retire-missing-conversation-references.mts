import fs from "node:fs";
import { parseArgs } from "node:util";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { withDoctorSqliteMaintenanceLock } from "../src/commands/doctor-sqlite-maintenance-lock.js";
import { resolveAgentConversationMode } from "../src/config/agent-conversation-mode.js";
import { loadConfig } from "../src/config/config.js";
import { conversationKnowledgeContributionId } from "../src/config/sessions/conversation-knowledge-identity.js";
import { selectConversationKnowledgeReceipts } from "../src/config/sessions/conversation-knowledge-selection.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_UTTERANCE_REPORT,
  readConversationKnowledgeReceipt,
  readConversationUtteranceObservation,
} from "../src/config/sessions/conversation-knowledge.js";
import {
  resolveSessionStorePathCore,
  resolveSessionTranscriptsDirForAgent,
} from "../src/config/sessions/paths.js";
import { readExactSessionEntryRow } from "../src/config/sessions/session-accessor.sqlite-entry-read.js";
import { getSessionKysely } from "../src/config/sessions/session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "../src/config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../src/config/sessions/session-accessor.sqlite-transcript-store.js";
import { assertSessionConversationRootEntry } from "../src/config/sessions/session-conversation-admission.js";
import { resolveAgentConversationRootSessionKey } from "../src/config/sessions/session-conversation-root-key.js";
import { sessionTranscriptIndexNeedsReconcile } from "../src/config/sessions/session-transcript-index.js";
import { sameTranscriptEntryAnchor } from "../src/config/sessions/transcript-entry-anchor.js";
import {
  transcriptEventJsonSql,
  transcriptEventNavigationSql,
} from "../src/config/sessions/transcript-payload.js";
import { jsonExtractText } from "../src/infra/database-engine/json-values.js";
import { ignoreMissingPath } from "../src/infra/errno.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../src/infra/kysely-sync.js";
import { resolveTargetSqliteOptions } from "../src/infra/session-sqlite-migration-readers.js";
import { backupDoctorSqliteRepair } from "../src/infra/sqlite-index-recovery.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../src/state/openclaw-agent-db-readonly.js";
import { runOpenClawAgentWriteTransaction } from "../src/state/openclaw-agent-db.js";
import {
  isSameOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "../src/state/openclaw-agent-db.paths.js";
import { withArtifactPreservingStateReads } from "../src/state/openclaw-state-db-readonly.js";

const operation = "doctor.retire-missing-conversation-references";
type PlannedReason = "source-missing-confirmed" | "historical-private-range-unverified";

function planRetirement(
  database: OpenClawAgentReadOnlyDatabase,
  agentId: string,
  rootKey: string,
  ownerPath: string,
  includeHistorical: boolean,
) {
  const sql = getSessionKysely(database.db);
  const one = executeSqliteQueryTakeFirstSync;
  const root = readExactSessionEntryRow(database, rootKey)?.entry;
  assertSessionConversationRootEntry(root, rootKey);
  if (
    sessionTranscriptIndexNeedsReconcile(database.db, root.sessionId) ||
    one(
      database.db,
      sql
        .selectFrom("session_transcript_cold_archives")
        .select("session_id")
        .where("session_id", "=", root.sessionId),
    )
  ) {
    throw new Error("Conversation root must have a current, readable projection.");
  }
  const rows = executeSqliteQuerySync(
    database.db,
    sql
      .selectFrom("transcript_events as event")
      .innerJoin("session_transcript_active_events as active", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select("event.seq")
      .select(transcriptEventJsonSql(database.db, "event").as("event_json"))
      .where("event.session_id", "=", root.sessionId)
      .where(
        jsonExtractText(
          database.db,
          transcriptEventNavigationSql(database.db, "event"),
          "customType",
        ),
        "in",
        [CONVERSATION_KNOWLEDGE_REPORT, CONVERSATION_UTTERANCE_REPORT],
      )
      .orderBy("event.seq"),
  ).rows.map((row) => {
    const event = asOptionalRecord(JSON.parse(row.event_json));
    const details = asOptionalRecord(event?.details);
    const reference =
      event?.customType === CONVERSATION_KNOWLEDGE_REPORT
        ? readConversationKnowledgeReceipt(details)
        : readConversationUtteranceObservation(details);
    if (event?.type !== "custom_message" || !details || !reference) {
      throw new Error("Conversation root contains a malformed reference.");
    }
    return { event, details, reference, seq: row.seq, expectedEventJson: row.event_json };
  });

  let retainedFiles: string[];
  try {
    retainedFiles = fs.readdirSync(resolveSessionTranscriptsDirForAgent(agentId));
  } catch (error) {
    retainedFiles = ignoreMissingPath(error) ?? [];
  }
  const isRetained = new Map<string, boolean>();
  const decisions = new Map<string, PlannedReason>();
  const missingSources = new Set<string>();
  const historicalSources = new Set<string>();
  const currentRows = new Map<string, ReturnType<typeof readExactSessionEntryRow>>();
  const checkedProjections = new Map<string, boolean>();
  for (const reference of selectConversationKnowledgeReceipts(
    rows.map(({ event }) => event),
    root.sessionId,
    rootKey,
    "branches",
    root.lifecycleRevision,
  )) {
    const { sessionId, agentId: sourceAgent } = reference.source;
    if (
      sourceAgent !== agentId ||
      // Artifact-preserving inspection may give the reader a private snapshot path.
      !isSameOpenClawAgentDatabasePath(reference.through.storePath, ownerPath)
    ) {
      continue;
    }
    if (!isRetained.has(sessionId)) {
      const retained =
        retainedFiles.some((file) => file === sessionId || file.startsWith(`${sessionId}.`)) ||
        [
          sql
            .selectFrom("session_nodes")
            .select("current_session_id")
            .where("current_session_id", "=", sessionId)
            .limit(1),
          sql
            .selectFrom("session_windows")
            .select("session_id")
            .where("session_id", "=", sessionId)
            .limit(1),
          sql
            .selectFrom("transcript_events")
            .select("session_id")
            .where("session_id", "=", sessionId)
            .limit(1),
          sql
            .selectFrom("session_transcript_archives")
            .select("session_id")
            .where("session_id", "=", sessionId)
            .limit(1),
          sql
            .selectFrom("session_transcript_cold_archives")
            .select("session_id")
            .where("session_id", "=", sessionId)
            .limit(1),
        ].some((query) => Boolean(one(database.db, query)));
      isRetained.set(sessionId, retained);
    }
    if (isRetained.get(sessionId) === false) {
      decisions.set(conversationKnowledgeContributionId(reference), "source-missing-confirmed");
      missingSources.add(sessionId);
      continue;
    }
    if (!includeHistorical || reference.privateAudience) {
      continue;
    }
    const { sessionKey, lifecycleRevision } = reference.source;
    if (!currentRows.has(sessionKey)) {
      currentRows.set(sessionKey, readExactSessionEntryRow(database, sessionKey));
    }
    const current = currentRows.get(sessionKey)?.entry;
    if (
      current?.sessionId !== sessionId ||
      !current.lifecycleRevision ||
      current.lifecycleRevision === lifecycleRevision
    ) {
      continue;
    }
    if (!checkedProjections.has(sessionId)) {
      checkedProjections.set(
        sessionId,
        !sessionTranscriptIndexNeedsReconcile(database.db, sessionId),
      );
    }
    if (!checkedProjections.get(sessionId)) {
      continue;
    }
    const through = reference.readRange?.through ?? reference.through;
    const currentAnchor = readActiveTranscriptEntryAnchorInTransaction({
      database,
      resolved: { agentId, sessionKey, sessionId },
      entryId: through.entryId,
    });
    if (
      currentAnchor &&
      sameTranscriptEntryAnchor(through, { ...currentAnchor, storePath: ownerPath })
    ) {
      decisions.set(
        conversationKnowledgeContributionId(reference),
        "historical-private-range-unverified",
      );
      historicalSources.add(JSON.stringify([sessionKey, sessionId, lifecycleRevision]));
    }
  }

  const changes = rows.filter(
    ({ reference }) =>
      !reference.retirement && decisions.has(conversationKnowledgeContributionId(reference)),
  );
  const scope = { agentId, path: ownerPath, sessionKey: rootKey, sessionId: root.sessionId };
  const planSha256 = sha256Hex(
    JSON.stringify([
      scope,
      root.lifecycleRevision,
      includeHistorical,
      changes.map(({ seq, expectedEventJson }) => [seq, sha256Hex(expectedEventJson)]),
    ]),
  );
  const historicalReferences = [...decisions.values()].filter(
    (reason) => reason === "historical-private-range-unverified",
  ).length;
  return {
    scope,
    summary: {
      references: decisions.size,
      sources: missingSources.size,
      historicalReferences,
      historicalSources: historicalSources.size,
      rows: changes.length,
      planSha256,
      targetsSha256: sha256Hex(JSON.stringify([...decisions].toSorted())),
    },
    changes: changes.map(({ event, details, reference, seq, expectedEventJson }) => ({
      seq,
      expectedEventJson,
      event: {
        ...event,
        details: {
          ...details,
          retirement: {
            reason: decisions.get(conversationKnowledgeContributionId(reference)),
            generation: reference.readRange?.through.generation ?? reference.through.generation,
            repairPlanSha256: planSha256,
          },
        },
      },
    })),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      agent: { type: "string" },
      apply: { type: "string" },
      "include-historical": { type: "boolean", default: false },
    },
  });
  const agentId = values.agent;
  if (
    !agentId ||
    normalizeAgentId(agentId) !== agentId ||
    (values.apply !== undefined && !/^[a-f0-9]{64}$/u.test(values.apply))
  ) {
    throw new Error(
      "Use --agent <canonical-agent-id> [--include-historical] [--apply <reviewed-plan-sha256>].",
    );
  }
  const includeHistorical = values["include-historical"];
  const cfg = loadConfig();
  if (
    resolveAgentConversationMode(cfg, agentId) !== "branches" ||
    cfg.session?.store !== undefined
  ) {
    throw new Error("This repair requires branch mode and the default native session store.");
  }
  const rootKey = resolveAgentConversationRootSessionKey({ cfg, agentId });
  const storePath = resolveSessionStorePathCore(undefined, { agentId });
  const options = resolveTargetSqliteOptions({ agentId, storePath });
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  const readPlan = () =>
    withArtifactPreservingStateReads(
      () => {
        const result = withOpenClawAgentDatabaseReadOnly(
          (db) => planRetirement(db, agentId, rootKey, databasePath, includeHistorical),
          options,
          { snapshot: true },
        );
        if (!result.found) {
          throw new Error("An existing native session database is required.");
        }
        return result.value;
      },
      { agentDatabases: true },
    );
  if (!values.apply) {
    console.log(JSON.stringify({ mode: "plan", ...readPlan().summary }));
    return;
  }
  await withDoctorSqliteMaintenanceLock({
    operation,
    protectedPaths: [databasePath],
    run: async (authority) => {
      const planned = readPlan().summary;
      if (planned.planSha256 !== values.apply || planned.rows === 0) {
        throw new Error("The reviewed plan no longer matches the eligible references.");
      }
      authority.assertCurrent();
      await backupDoctorSqliteRepair(databasePath, "conversation-retirement");
      const summary = runOpenClawAgentWriteTransaction(
        (database) => {
          authority.assertCurrent();
          if (!isSameOpenClawAgentDatabasePath(database.path, databasePath)) {
            throw new Error("The writer no longer owns the reviewed session database.");
          }
          const current = planRetirement(
            database,
            agentId,
            rootKey,
            databasePath,
            includeHistorical,
          );
          if (current.summary.planSha256 !== values.apply) {
            throw new Error("The reviewed plan changed before the write transaction.");
          }
          rewriteSqliteTranscriptEventRowsInTransaction(database, current.scope, current.changes);
          return current.summary;
        },
        options,
        {
          operationLabel: operation,
          repairAdmission: { integrityCheck: "quick", assertCurrent: authority.assertCurrent },
        },
      );
      console.log(JSON.stringify({ mode: "applied", ...summary }));
    },
  });
}

await main();
