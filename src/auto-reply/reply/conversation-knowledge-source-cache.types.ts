import type {
  PreparedConversationKnowledgeBootstrap,
  PreparedConversationKnowledgeCheckpointSelection,
} from "../../config/sessions/conversation-knowledge-checkpoint-admission.js";
import type { PreparedKnowledgeRootCandidates } from "../../config/sessions/conversation-knowledge-store.js";
import type {
  projectConversationKnowledge,
  ConversationKnowledgeReference,
} from "../../config/sessions/conversation-knowledge.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-transcript-context-version.types.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import type { PreparedPersonalConversationContributionGroup } from "../../gateway/session-transcript-personal-read.js";
import type { PreparedConversationKnowledgeRootCheckpoint } from "./conversation-knowledge-checkpoint-owner.js";

export type PreparedConversationKnowledgePacket = {
  part: NonNullable<ReturnType<typeof projectConversationKnowledge>>;
  version: SessionTranscriptContextVersion;
  through: TranscriptEntryAnchor;
  from?: TranscriptEntryAnchor;
};
export type ConversationKnowledgeSourceSelection = {
  scopeKey: string;
  sources: readonly {
    source: SessionTranscriptRuntimeTarget & { lifecycleRevision: string };
    selectionKey: string;
  }[];
};
export type ConversationKnowledgeCachedAdmission<Admission> =
  | { kind: "single"; value: Admission; bytes: number }
  | {
      kind: "group";
      value: PreparedPersonalConversationContributionGroup;
      bytes: number;
      manifest: PreparedKnowledgeRootCandidates;
      selectionKey?: string;
    };
export type PreparedRecipientConversationCheckpoint =
  PreparedConversationKnowledgeRootCheckpoint & {
    manifest: PreparedKnowledgeRootCandidates;
    bootstrap: PreparedConversationKnowledgeBootstrap;
    selection: PreparedConversationKnowledgeCheckpointSelection;
    groups: readonly {
      source: Readonly<Pick<ConversationKnowledgeReference["source"], "agentId" | "sessionKey">>;
      admission: PreparedPersonalConversationContributionGroup;
    }[];
  };
