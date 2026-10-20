import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  CONVERSATION_PUBLICATIONS_TABLE,
  ensureConversationPublicationsSchema,
} from "./openclaw-agent-conversation-publication-schema.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";

it("adds the publication journal to an admitted older database and retains its native session FK", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "publication-schema" },
    async (state) => {
      const options = { agentId: "main", env: state.env };
      const original = openOpenClawAgentDatabase(options);
      const databasePath = original.path;
      await upsertSessionEntryCore(
        { ...options, storePath: databasePath, sessionKey: "agent:main:synthetic" },
        { sessionId: "synthetic", lifecycleRevision: "life", updatedAt: 1 },
      );
      await closeOpenClawAgentDatabasesAsync(state.root);
      const older = new DatabaseSync(databasePath);
      older.exec(`DROP TABLE ${CONVERSATION_PUBLICATIONS_TABLE}`);
      older.close();

      const reopened = openOpenClawAgentDatabase(options);
      expect(
        reopened.db
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(CONVERSATION_PUBLICATIONS_TABLE),
      ).toBeUndefined();
      ensureConversationPublicationsSchema(reopened.db);
      expect(
        reopened.db.prepare(`PRAGMA foreign_key_list(${CONVERSATION_PUBLICATIONS_TABLE})`).all(),
      ).toEqual([
        expect.objectContaining({
          table: "session_windows",
          from: "session_id",
          to: "session_id",
          on_delete: "CASCADE",
        }),
      ]);
      // Schema-level fixtures prove capture order without clocks or random endpoint IDs.
      reopened.db.exec(`
      INSERT INTO session_conversation_publications
        (publication_id,session_id,session_key,lifecycle_revision,origin,entry_id,state,payload_json,created_at)
      VALUES ('z-first','synthetic','agent:main:synthetic','life','origin','first','ready','{}',100),
             ('a-second','synthetic','agent:main:synthetic','life','origin','second','ready','{}',100),
             ('b-third','synthetic','agent:main:synthetic','life','origin','third','ready','{}',1);
    `);
      await closeOpenClawAgentDatabasesAsync(state.root);
      const recovered = openOpenClawAgentDatabase(options);
      expect(
        recovered.db
          .prepare(
            "SELECT publication_id FROM session_conversation_publications ORDER BY capture_sequence",
          )
          .all(),
      ).toEqual([
        { publication_id: "z-first" },
        { publication_id: "a-second" },
        { publication_id: "b-third" },
      ]);
      recovered.db.exec("DELETE FROM session_windows WHERE session_id = 'synthetic'");
      expect(
        recovered.db
          .prepare("SELECT count(*) AS count FROM session_conversation_publications")
          .get(),
      ).toEqual({ count: 0 });
    },
  );
});
