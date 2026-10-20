import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const CONVERSATION_PUBLICATIONS_TABLE = "session_conversation_publications";

/** Additive Session-owned journal; older readers leave its pending references intact. */
export const ensureConversationPublicationsSchema = createSqliteSchemaEnsurer(
  () =>
    extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, CONVERSATION_PUBLICATIONS_TABLE, {
      endMarker: "CREATE TABLE IF NOT EXISTS context_engine_turn_outbox (",
      includeEndMarker: false,
      errorMessage: "Conversation publication schema markers are missing.",
    }),
  {
    tables: [CONVERSATION_PUBLICATIONS_TABLE],
    indexes: [
      "idx_agent_conversation_publications_ready",
      "idx_agent_conversation_publications_origin",
    ],
  },
);
