import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { createConversationKnowledgeCheckpointContext } from "./conversation-knowledge-checkpoint-context.js";
import type { ConversationKnowledgeCheckpoint } from "./conversation-knowledge-checkpoint.js";
import { createConversationKnowledgePacketReport } from "./conversation-knowledge-packets.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "./conversation-knowledge.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import { assertPreparedInitialSessionContextFrame } from "./session-initial-context-frame.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import type { SessionEntry } from "./types.js";

/** Native-prepared snapshot data; the caller must separately retain live read authority. */
type InitialSessionContextBase = {
  source: CapturedSessionEntryReadSource & { databaseIdentity: string };
  sourceSessionKey: string;
  sourceEntry: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  /** Stability watermark of the captured source, not the endpoint of copied knowledge. */
  sourceVersion: SessionTranscriptContextVersion;
  /** Exact completed endpoint; pending source suffixes are not inherited or acknowledged. */
  sourceThrough?: TranscriptEntryAnchor;
  targetSessionId: string;
  events: readonly TranscriptEvent[];
};

/** The actual granted row predicate and selected transcript range travel separately. */
export type PreparedInitialSessionContextSourceClaim = {
  reference: ConversationKnowledgeReference;
  predicate: SessionSourcePredicate;
  sessionId: string;
  version: SessionTranscriptContextVersion;
  from?: TranscriptEntryAnchor;
  through?: TranscriptEntryAnchor;
};

export type PreparedProjectedInitialSessionContext = InitialSessionContextBase & {
  kind: "root-projection" | "prepared-root-projection";
  projection: {
    branch: ConversationKnowledgeBranch;
    packets: readonly {
      receipt: ConversationKnowledgeReference;
      text: string;
      offset: number;
      nextOffset: number;
      complete: boolean;
      sourceClaim: number;
    }[];
    checkpoint?: ConversationKnowledgeCheckpoint;
    claims: readonly PreparedInitialSessionContextSourceClaim[];
  };
};

export type PreparedInitialSessionContext =
  | (InitialSessionContextBase & { kind?: "source" })
  | PreparedProjectedInitialSessionContext;

/** Initial copies use the same observation carriers and progress receipts as later delivery. */
export function createProjectedInitialSessionContextEvents(params: {
  projection: PreparedProjectedInitialSessionContext["projection"];
  targetSessionId: string;
  timestamp?: string;
  cwd?: string;
}): TranscriptEvent[] {
  const { projection } = params;
  const header = createSessionTranscriptHeader({
    sessionId: params.targetSessionId,
    timestamp: params.timestamp,
    cwd: params.cwd,
  });
  const reports = [
    ...(projection.checkpoint
      ? [
          createConversationKnowledgeCheckpointContext({
            checkpoint: projection.checkpoint,
            branch: projection.branch,
          }),
        ]
      : []),
    ...projection.packets.map((packet) =>
      createConversationKnowledgePacketReport({
        ...packet,
        branch: projection.branch,
      }),
    ),
  ];
  let parentId: string | null = null;
  return [
    header,
    ...reports.map((report) => {
      const event = Object.assign({}, report, {
        type: "custom_message",
        id: report.details.packetId,
        parentId,
        timestamp: header.timestamp,
      });
      parentId = event.id;
      return event;
    }),
  ];
}

/** Copied bytes must name the same donor covered by the retained native read predicates. */
export function assertInitialSessionContextReadSource(
  context: PreparedInitialSessionContext,
  sources: readonly SessionSourcePredicate[] | undefined,
): void {
  const key = normalizeStoreSessionKey(context.sourceSessionKey);
  const matching = sources?.some(
    (source) =>
      key &&
      normalizeStoreSessionKey(source.sessionKey) === key &&
      source.source.agentId === context.source.agentId &&
      source.source.path === context.source.path &&
      source.source.databaseIdentity === context.source.databaseIdentity &&
      source.source.databaseBirthtime === context.source.databaseBirthtime &&
      source.expected?.sessionId === context.sourceEntry.sessionId &&
      source.expected?.lifecycleRevision === context.sourceEntry.lifecycleRevision &&
      source.fields.includes("sessionId") &&
      source.fields.includes("lifecycleRevision") &&
      source.fields.includes("createdActor") &&
      source.fields.includes("visibility") &&
      source.fields.includes("incognito"),
  );
  if (!matching) {
    throw new Error(
      "Initial conversation context requires matching prepared donor read authority.",
    );
  }
  if (context.kind === "root-projection" || context.kind === "prepared-root-projection") {
    if (context.kind === "prepared-root-projection" && isMainThread) {
      assertPreparedInitialSessionContextFrame(context, sources);
    }
    const bySession = new Map<string, SessionSourcePredicate[]>();
    for (const source of sources ?? []) {
      const candidates = bySession.get(source.sessionKey) ?? [];
      candidates.push(source);
      bySession.set(source.sessionKey, candidates);
    }
    if (
      !context.projection.claims.length ||
      context.projection.claims.some(
        (claim) =>
          !bySession
            .get(claim.predicate.sessionKey)
            ?.some((source) => isDeepStrictEqual(source, claim.predicate)),
      )
    ) {
      throw new Error("Initial root projection requires every prepared donor read authority.");
    }
  }
}
