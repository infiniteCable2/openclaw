import { isDeepStrictEqual } from "node:util";
import {
  readConversationKnowledgeBranch,
  recordConversationKnowledgeReference,
} from "./conversation-knowledge-store.js";
import { ConversationPublicationBlockedError } from "./conversation-publication-drain.js";
import type { ConversationPublicationRow } from "./conversation-publication.types.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import { readActiveTranscriptEntryAnchorAsync } from "./session-transcript-anchor-read.js";

/** Recovery obtains fresh native custody; persisted provenance is never a live read grant. */
export async function publishConversationPublication(params: {
  row: ConversationPublicationRow;
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  assertCurrent(): void;
}): Promise<void> {
  const { row } = params;
  const target = {
    agentId: params.agentId,
    storePath: params.path,
    env: params.env,
    sessionKey: row.intent.source.sessionKey,
    sessionId: row.intent.source.sessionId,
  };
  const check = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  check();
  const held = await loadSessionEntryForAdmission(target, {
    signal: params.signal,
    assertCurrent: check,
  });
  try {
    check();
    held.databaseClaim.assertCurrent();
    const reader =
      "kind" in held.databaseClaim && held.databaseClaim.kind === "worker"
        ? held.databaseClaim.reader
        : undefined;
    if (!reader || !held.entry || held.entry.incognito) {
      throw new ConversationPublicationBlockedError("source-unavailable");
    }
    const branch = await readConversationKnowledgeBranch({
      reader,
      assertCurrent: check,
      sessionId: target.sessionId,
    });
    check();
    if (
      !branch ||
      branch.agentId !== params.agentId ||
      branch.storePath !== params.path ||
      branch.lifecycleRevision !== row.intent.source.lifecycleRevision ||
      !isDeepStrictEqual(branch.root, row.intent.root)
    ) {
      throw new ConversationPublicationBlockedError("source-replaced");
    }
    // The source-admitted cohort must retain its source row while checking the
    // root; omitting it fails the reader's original-incarnation predicate.
    await reader.withRead(
      { sessionKeys: [branch.sessionKey, branch.root.sessionKey] },
      check,
      (facts) => {
        const root = facts.entries.find(
          (entry) => entry.sessionKey === branch.root.sessionKey,
        )?.entry;
        if (
          root?.sessionId !== row.intent.root.sessionId ||
          root.lifecycleRevision !== row.intent.root.lifecycleRevision ||
          root.conversationTopology?.role !== "root"
        ) {
          throw new ConversationPublicationBlockedError("root-replaced");
        }
      },
    );
    check();
    const anchor = await readActiveTranscriptEntryAnchorAsync(
      { ...target, entryId: row.anchor.entryId },
      params.signal,
    );
    check();
    if (!anchor || !isDeepStrictEqual(anchor, row.readRange?.through ?? row.anchor)) {
      throw new ConversationPublicationBlockedError("endpoint-unavailable");
    }
    const published = await recordConversationKnowledgeReference({
      reader,
      assertCurrent: check,
      branch,
      through: row.anchor,
      sessionId: target.sessionId,
      sourceMode: row.intent.sourceMode,
      observed: row.intent.observed,
      privateAudience: row.intent.privateAudience,
      readRange: row.readRange,
      completion:
        row.intent.kind === "completed-turn"
          ? { runId: row.intent.runId }
          : { kind: "utterance-observation", role: row.intent.role },
      publicationId: row.id,
      signal: params.signal,
    });
    check();
    if (!published) {
      throw new ConversationPublicationBlockedError("endpoint-unavailable");
    }
  } finally {
    await held.databaseClaim.release();
  }
}
