import type { ConversationPublicationRow } from "./conversation-publication.types.js";

/** Retained provenance cannot authorize redirecting a missing/replaced source. */
export class ConversationPublicationBlockedError extends Error {
  constructor(
    readonly code:
      | "source-unavailable"
      | "source-replaced"
      | "root-replaced"
      | "endpoint-unavailable",
  ) {
    super(`Conversation publication blocked: ${code}`);
    this.name = "ConversationPublicationBlockedError";
  }
}

export type ConversationPublicationDrainStore = {
  readReadyHeads(input: { now: number; limit: number }): Promise<ConversationPublicationRow[]>;
  acknowledge(id: string): Promise<void>;
  retry(id: string, input: { errorCode: string; nextAttemptAt: number }): Promise<void>;
  block(id: string, input: { errorCode: string }): Promise<void>;
};

/** Bounded work under the store owner, never a replay of the model or its tools. */
export async function drainConversationPublications(params: {
  store: ConversationPublicationDrainStore;
  publish(row: ConversationPublicationRow): Promise<void>;
  assertCurrent(): void;
  now(): number;
  warn(event: {
    publicationId: string;
    outcome: "retry" | "blocked";
    errorCode: string;
    attempt: number;
  }): void;
  limit?: number;
}): Promise<number> {
  params.assertCurrent();
  const rows = await params.store.readReadyHeads({
    now: params.now(),
    limit: params.limit ?? 8,
  });
  params.assertCurrent();
  for (const row of rows) {
    params.assertCurrent();
    try {
      await params.publish(row);
      params.assertCurrent();
      // A lost acknowledgment is safe: the root deduplicates this exact endpoint.
      await params.store.acknowledge(row.id);
    } catch (error) {
      params.assertCurrent();
      const blocked = error instanceof ConversationPublicationBlockedError;
      const errorCode = blocked ? error.code : "publication-failed";
      if (blocked) {
        await params.store.block(row.id, { errorCode });
      } else {
        await params.store.retry(row.id, {
          errorCode,
          nextAttemptAt:
            params.now() + Math.min(300_000, 1_000 * 2 ** Math.min(row.attemptCount, 9)),
        });
      }
      params.assertCurrent();
      params.warn({
        publicationId: row.id,
        outcome: blocked ? "blocked" : "retry",
        errorCode,
        attempt: row.attemptCount + 1,
      });
    }
  }
  return rows.length;
}
