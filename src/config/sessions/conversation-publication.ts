import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { ConversationPublicationAcceptance } from "./conversation-publication.types.js";
import type { conversationPublicationOperations } from "./conversation-publication.worker.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";

type Operations = WorkerOperations<typeof conversationPublicationOperations>;

/** Each operation retains and joins the existing native execution owner; no detached writer. */
export function openConversationPublicationStore(
  target: OpenClawAgentDatabaseOptions & {
    agentId: string;
    path: string;
    assertCurrent(this: void): void;
  },
) {
  const { assertCurrent, ...captured } = target;
  const database = { ...captured, env: { ...(captured.env ?? process.env) } };
  if (isIncognitoOpenClawAgentSqlitePath(database.path, database)) {
    throw new Error("Incognito conversations cannot own a durable publication journal");
  }
  const execute = async <K extends keyof Operations>(command: {
    type: K;
    input: Operations[K]["input"];
  }): Promise<Operations[K]["output"]["value"]> => {
    assertCurrent();
    return withSessionEntryWorker(database, undefined, assertCurrent, async (execution, source) => {
      const result = await execution.runExisting(source, (worker) => worker.execute(command));
      assertCurrent();
      if (!result) {
        throw new Error("Conversation publication database is unavailable");
      }
      return result.value;
    });
  };
  return {
    accept: (input: ConversationPublicationAcceptance) =>
      execute({ type: "session.conversationPublication.accept", input }),
    readReadyHeads: (input: { now: number; limit: number }) =>
      execute({ type: "session.conversationPublication.ready", input }),
    nextAttemptAt: () =>
      execute({ type: "session.conversationPublication.next", input: undefined }),
    stats: () => execute({ type: "session.conversationPublication.stats", input: undefined }),
    acknowledge: (id: string) =>
      execute({ type: "session.conversationPublication.acknowledge", input: { id } }),
    retry: (
      id: string,
      input: { errorCode: string; nextAttemptAt: number; expectedGeneration?: string },
    ) => execute({ type: "session.conversationPublication.retry", input: { id, ...input } }),
    block: (id: string, input: { errorCode: string; expectedGeneration?: string }) =>
      execute({ type: "session.conversationPublication.block", input: { id, ...input } }),
  };
}
