import { isDeepStrictEqual } from "node:util";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { admitSessionConversationBranch } from "./session-conversation-admission.js";
import type { SessionConversationTopology } from "./session-conversation-topology.js";
import type { InternalSessionEntry } from "./types.js";

/** Metadata validation on the actual writer connection; this grants no transcript access. */
export function assertSessionConversationBranchInTransaction(
  database: OpenClawAgentDatabase,
  params: {
    sessionKey: string;
    entry: InternalSessionEntry;
    admission: Extract<SessionConversationTopology, { role: "branch" }>;
  },
): void {
  if (!database.db.isTransaction) {
    throw new Error("Conversation branch admission requires its native writer transaction.");
  }
  const root = readExactSessionEntryRow(database, params.admission.rootSessionKey)?.entry;
  let selected: Extract<SessionConversationTopology, { role: "branch" }>;
  try {
    selected = admitSessionConversationBranch({
      agentId: database.agentId,
      sessionKey: params.sessionKey,
      rootSessionKey: params.admission.rootSessionKey,
      rootEntry: root,
    });
  } catch (cause) {
    throw new Error("Conversation root changed before branch admission.", { cause });
  }
  if (
    !isDeepStrictEqual(selected, params.admission) ||
    !isDeepStrictEqual(params.entry.conversationTopology, selected)
  ) {
    throw new Error("Conversation root changed before branch admission.");
  }
}
