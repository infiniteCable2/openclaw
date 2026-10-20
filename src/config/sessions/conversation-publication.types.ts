import type {
  ConversationKnowledgeFrontier,
  ConversationKnowledgeReference,
} from "./conversation-knowledge.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

/** Host-captured provenance, committed with the original message; never a read grant. */
export type ConversationPublicationIntent = {
  version: 1;
  sourceMode: "native" | "branches";
  source: { sessionKey: string; sessionId: string; lifecycleRevision: string };
  root: { sessionKey: string; sessionId: string; lifecycleRevision: string };
  privateAudience?: {
    participant: NonNullable<ConversationKnowledgeReference["privateAudience"]>["participant"];
    /** Only direct utterances may bind their own transaction-issued anchor. */
    admission: TranscriptEntryAnchor | "self";
  };
  observed?: ConversationKnowledgeFrontier[];
} & (
  | { kind: "completed-turn"; runId: string }
  | { kind: "utterance-observation"; role: "user" | "assistant" }
);

export type ConversationPublicationRow = {
  id: string;
  intent: ConversationPublicationIntent & {
    privateAudience?: ConversationKnowledgeReference["privateAudience"];
  };
  anchor: TranscriptEntryAnchor;
  /** Derived physical read anchors; original occurrence identity and audience remain immutable. */
  readRange?: ConversationKnowledgeReference["readRange"];
  state: "candidate" | "ready" | "blocked";
  attemptCount: number;
  nextAttemptAt: number;
  lastFailure?: string;
};

export type ConversationPublicationAcceptance = {
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  runId: string;
  entryId?: string;
  idempotencyKey?: string;
};
