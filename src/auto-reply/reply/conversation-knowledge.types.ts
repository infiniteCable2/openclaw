import type { RuntimeContextFragment } from "../../agents/internal-runtime-context.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { CustomMessage } from "../../agents/sessions/messages.js";
import type { ConversationKnowledgeFrontier } from "../../config/sessions/conversation-knowledge.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { TranscriptTurnAdmission } from "../../config/sessions/transcript-entry-anchor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import type { ConversationKnowledgeIngestionMaintenance } from "./conversation-knowledge-ingestion.js";
import type { ConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";

/** Retained until the actual model turn settles; source revocation also revokes quoted context. */
export type PreparedReplyConversationKnowledge = {
  fragments: RuntimeContextFragment[];
  observed: ConversationKnowledgeFrontier[];
  assertCurrent: SessionSourceAssertion;
  release(): void;
  pendingPackets?: boolean;
  nextSourceCursor?: string;
  /** Disposable preparation must await a new wakeup when pending packet storage is full. */
  preparationSaturated?: boolean;
};

export type ReplyConversationKnowledgeParams = {
  reader: SessionEntryCohortReader;
  sessionId: string;
  assertCurrent: SessionSourceAssertion;
  /** Host-carried participant of this actual input, never reconstructed from stored dialogue. */
  originalParticipant?: SessionParticipantIdentity;
  destinationAudience?: ConversationPrivateAudience;
  /** A separately verified current recipient narrows disclosure; this is never a read grant. */
  expectedAudienceIdentity?: string;
  getRuntimeConfig: () => OpenClawConfig;
  signal?: AbortSignal;
  /** Retained context follows the turn lifetime, not a completed model response. */
  retainedSignal?: AbortSignal;
  sourceCache?: ConversationKnowledgeSourceCache;
  /** Read/authorize ahead without modifying the recipient or asking a model to compact. */
  preparationOnly?: boolean;
  /** A natural model boundary consumes only prepared bytes; it never waits for source hydration. */
  readyOnly?: boolean;
  packetBudget?: number;
  sourceBudget?: number;
  /** Existing contribution identity; positional indexes shift when sources retire. */
  sourceCursor?: string;
  canAdmitPacket?: (message: CustomMessage) => boolean;
  onPacket?: (message: CustomMessage) => void;
  /** Exact native input permits a bounded bootstrap proof advance, never a general history scan. */
  bootstrapInput?: TranscriptTurnAdmission;
  bootstrapInitialization?: import("../../config/sessions/conversation-knowledge-checkpoint-admission.js").ConversationKnowledgeBootstrapInitialization;
  /** Actual native user runs retain observations; provider startup snapshots remain read-only. */
  retainInHistory?: ConversationKnowledgeIngestionMaintenance & {
    /** Native writer selector; physical read provenance does not grant write custody. */
    writeTarget: BoundAgentRunSessionTarget;
  };
};
