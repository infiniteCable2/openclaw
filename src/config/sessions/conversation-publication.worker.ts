import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";
import {
  acceptConversationPublicationInTransaction,
  acknowledgeConversationPublication,
  failConversationPublication,
  nextConversationPublicationAttempt,
  readConversationPublicationReadyHeads,
  readConversationPublicationStats,
} from "./conversation-publication.kernel.js";
import type { ConversationPublicationAcceptance } from "./conversation-publication.types.js";

type Context = AgentWorkerOperationContext;

/** Reuses the canonical agent writer, including its host transaction and commit grants. */
function transaction<T>(context: Context, run: (database: OpenClawAgentDatabase) => T) {
  return context.writeTransaction(
    "session.conversation-publication",
    "Conversation publication",
    (database) => {
      context.admit("transaction");
      const value = run(database);
      context.admit("commit");
      return { value };
    },
  );
}

export const conversationPublicationOperations = {
  "session.conversationPublication.accept": (
    input: ConversationPublicationAcceptance,
    context: Context,
  ) =>
    transaction(context, (database) => acceptConversationPublicationInTransaction(database, input)),
  "session.conversationPublication.ready": (
    input: { now: number; limit: number },
    context: Context,
  ) => transaction(context, (database) => readConversationPublicationReadyHeads(database, input)),
  "session.conversationPublication.next": (_input: undefined, context: Context) =>
    transaction(context, nextConversationPublicationAttempt),
  "session.conversationPublication.stats": (_input: undefined, context: Context) =>
    transaction(context, readConversationPublicationStats),
  "session.conversationPublication.acknowledge": (input: { id: string }, context: Context) =>
    transaction(context, (database) => acknowledgeConversationPublication(database, input.id)),
  "session.conversationPublication.retry": (
    input: { id: string; errorCode: string; nextAttemptAt: number; expectedGeneration?: string },
    context: Context,
  ) =>
    transaction(context, (database) =>
      failConversationPublication(database, { ...input, blocked: false }),
    ),
  "session.conversationPublication.block": (
    input: { id: string; errorCode: string; expectedGeneration?: string },
    context: Context,
  ) =>
    transaction(context, (database) =>
      failConversationPublication(database, { ...input, blocked: true }),
    ),
} satisfies WorkerOperationHandlers<Context>;
