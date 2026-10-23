import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { afterEach, expect, it, vi } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../../state/openclaw-agent-session-transcript-archive-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { selectConversationKnowledgeReceipts } from "./conversation-knowledge-selection.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  conversationKnowledgeOrigin,
  readConversationKnowledgeReceipt,
  type ConversationKnowledgeReceipt,
} from "./conversation-knowledge.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { appendSessionTranscriptReport } from "./session-accessor.sqlite-transcript-reports.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import { ensureAgentConversationRoot } from "./session-conversation-root.js";
import type { PublishedSessionTranscriptArchive } from "./session-history-archive-pruning.types.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";

afterEach(() => vi.restoreAllMocks());

const hash = sha256Hex("synthetic canonical archive");

function reference(storePath = "/synthetic/agent.sqlite"): ConversationKnowledgeReceipt {
  const source = {
    agentId: "main",
    sessionKey: "agent:main:old-source",
    sessionId: "old-source-id",
    lifecycleRevision: "original-incarnation",
  };
  const through = {
    agentId: source.agentId,
    sessionKey: source.sessionKey,
    sessionId: source.sessionId,
    storePath,
    generation: "original-generation",
    entryId: "terminal",
    rawSeq: 2,
    activeMessagePosition: 1,
    effectiveParentId: "admission",
  };
  const admission = {
    ...through,
    entryId: "admission",
    rawSeq: 1,
    activeMessagePosition: 0,
    effectiveParentId: null,
  };
  return {
    version: 1,
    sourceMode: "branches",
    source,
    origin: conversationKnowledgeOrigin(source),
    runId: "original-run",
    through,
    privateAudience: { participant: { type: "profile", id: "person-alpha" }, admission },
    readRange: {
      through: { ...through, generation: "archived-generation" },
      admission: { ...admission, generation: "archived-generation" },
    },
    observed: [
      {
        origin: "other-origin",
        generation: "other-generation",
        throughRawSeq: 4,
        throughEntryId: "seen",
      },
    ],
  };
}

it("excludes only generation-bound producer retirement, never marks it delivered or revives duplicates", () => {
  const receipt = reference();
  const retirement = {
    reason: "source-archive-pruned",
    generation: "archived-generation",
    archiveSha256: hash,
  };
  const event = (details: unknown) => ({
    type: "custom_message",
    customType: CONVERSATION_KNOWLEDGE_REPORT,
    details,
  });
  const retired = { ...receipt, retirement };
  expect(readConversationKnowledgeReceipt(retired)).toEqual(retired);
  expect(
    selectConversationKnowledgeReceipts(
      [event(receipt), event(retired), event(receipt)],
      "recipient",
    ),
  ).toEqual([]);
  for (const patch of [
    { generation: "original-generation" },
    { reason: "read-failed" },
    { archiveSha256: "unverified" },
  ]) {
    const details = { ...receipt, retirement: { ...retirement, ...patch } };
    expect(readConversationKnowledgeReceipt(details)).toEqual(receipt);
    expect(selectConversationKnowledgeReceipts([event(details)], "recipient")).toEqual([receipt]);
  }
});

async function withFixture(
  run: (fixture: {
    options: { agentId: string; path: string; env: NodeJS.ProcessEnv };
    archive: PublishedSessionTranscriptArchive;
    directory: string;
    receipt: ConversationKnowledgeReceipt;
    rootKey: string;
    read: () => Promise<TranscriptEvent[]>;
    remove: (retention?: boolean) => Promise<void>;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { scenario: "minimal", label: "knowledge-retirement" },
    async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const cfg = { agents: { entries: { main: { conversationMode: "branches" as const } } } };
      await state.writeConfig(cfg);
      const admitted = await ensureAgentConversationRoot({ cfg, agentId: "main", env: state.env });
      const root = {
        agentId: "main",
        storePath: database.path,
        env: state.env,
        sessionKey: admitted.sessionKey,
        sessionId: admitted.entry.sessionId,
      };
      const receipt = reference(database.path);
      const report = await appendSessionTranscriptReport(root, {
        kind: "custom",
        customTypes: [CONVERSATION_KNOWLEDGE_REPORT],
        selectReport: () => ({
          customType: CONVERSATION_KNOWLEDGE_REPORT,
          content: "Synthetic source reference.",
          display: false,
          details: receipt,
        }),
      });
      expect(report.ok).toBe(true);
      ensureSessionTranscriptArchiveSchema(database.db);
      const archive: PublishedSessionTranscriptArchive = {
        archive_name: "source.synthetic-archive",
        archive_sha256: hash,
        created_at: 1,
        encoding: "identity",
        generation: "archived-generation",
        published_at: 1,
        reason: "deleted",
        session_id: receipt.source.sessionId,
        session_key: receipt.source.sessionKey,
      };
      executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .insertInto("session_transcript_archives")
          .values({ ...archive, archive_blob: Buffer.from("synthetic canonical archive") }),
      );
      const options = { agentId: "main", path: database.path, env: state.env };
      const directory = state.sessionsDir();
      fs.mkdirSync(directory, { recursive: true });
      await run({
        options,
        archive,
        directory,
        receipt,
        rootKey: root.sessionKey,
        read: () => loadTranscriptEvents(root),
        remove: (retention = false) =>
          withSqliteSessionPageReclamation(options, (_reclaim, _assert, _options, archives) =>
            archives.withWriter(async () => {
              if (retention) {
                await archives.pruneRetention({
                  candidates: [archive],
                  archiveDirectory: directory,
                });
              } else {
                await archives.deletePublished({ archive, archiveDirectory: directory });
              }
            }),
          ),
      });
    },
  );
}

it.each([false, true])(
  "retires last-copy references atomically through the native archive worker (retention: %s)",
  async (retention) => {
    await withFixture(async (f) => {
      const before = await f.read();
      // Reusing the old key must not move its historical reference to a new incarnation/root.
      replaceSessionEntrySync(
        {
          agentId: "main",
          storePath: f.options.path,
          env: f.options.env,
          sessionKey: f.archive.session_key,
        },
        { sessionId: "new-incarnation", lifecycleRevision: "new-life", updatedAt: 1 },
      );
      await f.remove(retention);
      const after = await f.read();
      const report = after.find(
        (event) =>
          event &&
          typeof event === "object" &&
          "customType" in event &&
          event.customType === CONVERSATION_KNOWLEDGE_REPORT,
      );
      expect(report).toMatchObject({
        details: {
          ...f.receipt,
          retirement: {
            reason: "source-archive-pruned",
            generation: f.archive.generation,
            archiveSha256: hash,
          },
        },
      });
      expect(after).toHaveLength(before.length);
      expect(selectConversationKnowledgeReceipts(after, "recipient")).toEqual([]);
      const database = openOpenClawAgentDatabase(f.options);
      expect(
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("session_transcript_archives")
            .select("session_id")
            .where("session_id", "=", f.archive.session_id),
        ).rows,
      ).toEqual([]);
    });
  },
);

it.each(["hot", "empty-window", "cold", "other-archive", "wrong-generation", "wrong-key"])(
  "does not retire when another copy or mismatched source remains: %s",
  async (kind) => {
    await withFixture(async (f) => {
      const database = openOpenClawAgentDatabase(f.options);
      const db = getSessionKysely(database.db);
      const before = await f.read();
      if (kind === "hot" || kind === "empty-window") {
        runOpenClawAgentWriteTransaction(
          (owner) =>
            appendTranscriptEventInTransaction(
              owner,
              { ...f.options, sessionKey: f.archive.session_key, sessionId: f.archive.session_id },
              { type: "session", id: f.archive.session_id },
            ),
          f.options,
        );
        if (kind === "empty-window") {
          executeSqliteQuerySync(
            database.db,
            db.deleteFrom("transcript_events").where("session_id", "=", f.archive.session_id),
          );
        }
      } else if (kind === "cold") {
        // A canonical cold copy is owned by a real session window, even when
        // its hot events have already been evicted. Keep native FK enforcement.
        runOpenClawAgentWriteTransaction(
          (owner) =>
            appendTranscriptEventInTransaction(
              owner,
              { ...f.options, sessionKey: f.archive.session_key, sessionId: f.archive.session_id },
              { type: "session", id: f.archive.session_id },
            ),
          f.options,
        );
        executeSqliteQuerySync(
          database.db,
          db.deleteFrom("transcript_events").where("session_id", "=", f.archive.session_id),
        );
        executeSqliteQuerySync(
          database.db,
          db.insertInto("session_transcript_cold_archives").values({
            session_id: f.archive.session_id,
            generation: f.archive.generation,
            archive_name: "another-copy",
            archive_sha256: hash,
            event_count: 1,
            raw_bytes: 1,
            archive_bytes: 1,
            last_seq: 0,
            archived_at: 1,
            storage: "sqlite",
            archive_blob: Buffer.from("x"),
          }),
        );
      } else if (kind === "other-archive") {
        executeSqliteQuerySync(
          database.db,
          db.insertInto("session_transcript_archives").values({
            ...f.archive,
            generation: "another-generation",
            archive_name: "another-canonical-copy",
            archive_blob: Buffer.from("retained"),
          }),
        );
      } else {
        const update =
          kind === "wrong-key"
            ? { session_key: "agent:main:different-key" }
            : { generation: "different-generation" };
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("session_transcript_archives")
            .set(update)
            .where("session_id", "=", f.archive.session_id),
        );
        Object.assign(f.archive, update);
      }
      await f.remove();
      expect(await f.read()).toEqual(before);
    });
  },
);

it("compares every selected archive metadata field before issuing loss evidence", async () => {
  await withFixture(async (f) => {
    const database = openOpenClawAgentDatabase(f.options);
    const db = getSessionKysely(database.db);
    const before = await f.read();
    const changes = [
      { archive_name: "changed-name" },
      { archive_sha256: "b".repeat(64) },
      { created_at: 2 },
      { encoding: "zstd" },
      { generation: "changed-generation" },
      { published_at: 2 },
      { reason: "reset" },
      { session_key: "agent:main:changed-key" },
    ];
    for (const change of changes) {
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("session_transcript_archives")
          .set(change)
          .where("session_id", "=", f.archive.session_id),
      );
      await expect(f.remove()).rejects.toThrow("changed during pruning");
      expect(await f.read()).toEqual(before);
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("session_transcript_archives")
          .set(f.archive)
          .where("session_id", "=", f.archive.session_id),
      );
    }
  });
});

it("preserves canonical loss proof when an existing root is malformed", async () => {
  await withFixture(async (f) => {
    replaceSessionEntrySync(
      { agentId: "main", storePath: f.options.path, env: f.options.env, sessionKey: f.rootKey },
      { sessionId: "malformed-root", updatedAt: 1 },
    );
    await expect(f.remove()).rejects.toThrow("Conversation root is not admitted");
    const database = openOpenClawAgentDatabase(f.options);
    expect(
      executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_transcript_archives")
          .select("session_id")
          .where("session_id", "=", f.archive.session_id),
      ).rows,
    ).toHaveLength(1);
  });
});

it("allows native archive pruning without requiring or manufacturing a conversation root", async () => {
  await withFixture(async (f) => {
    const database = openOpenClawAgentDatabase(f.options);
    const db = getSessionKysely(database.db);
    const [root] = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select("current_session_id")
        .where("session_key", "=", f.rootKey),
    ).rows;
    if (!root?.current_session_id) {
      throw new Error("Expected the synthetic root before removing its test-owned row");
    }
    const rootSessionId = root.current_session_id;
    const history = () =>
      executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .selectAll()
          .where("session_id", "=", rootSessionId)
          .orderBy("seq"),
      ).rows;
    expect(history()).not.toEqual([]);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_nodes").where("session_key", "=", f.rootKey),
    );
    // Native FK cascades remove this synthetic root's window and transcript.
    // Establish the absent-root baseline before the archive operation under test.
    const before = history();
    expect(before).toEqual([]);
    await f.remove();
    expect(history()).toEqual(before);
    expect(
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("session_nodes").select("session_key").where("session_key", "=", f.rootKey),
      ).rows,
    ).toEqual([]);
    expect(
      executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_transcript_archives")
          .select("session_id")
          .where("session_id", "=", f.archive.session_id),
      ).rows,
    ).toEqual([]);
  });
});

it("rolls back both archive deletion and root retirement when native commit authority refuses", async () => {
  await withFixture(async (f) => {
    const before = await f.read();
    let refused = false;
    const probe = sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, admit) => {
      if (!refused && request.stage === "commit") {
        refused = true;
        throw new Error("Synthetic archive commit refusal");
      }
      admit(request, grant);
    });
    await expect(f.remove()).rejects.toThrow("Synthetic archive commit refusal");
    probe.mockRestore();
    expect(refused).toBe(true);
    expect(await f.read()).toEqual(before);
    const database = openOpenClawAgentDatabase(f.options);
    expect(
      executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_transcript_archives")
          .select("session_id")
          .where("session_id", "=", f.archive.session_id),
      ).rows,
    ).toHaveLength(1);
  });
});

it("refuses final deletion until the exact derived archive file is absent", async () => {
  await withFixture(async (f) => {
    const before = await f.read();
    fs.writeFileSync(path.join(f.directory, f.archive.archive_name), "derived copy");
    await expect(f.remove()).rejects.toThrow("file removal is not confirmed");
    expect(await f.read()).toEqual(before);
  });
});
