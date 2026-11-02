import type { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import type { ConversationKnowledgeBranch } from "../config/sessions/conversation-knowledge-store.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import type { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import type { createPersonalParticipantCustody } from "./session-transcript-personal-participant.js";

export type PersonalReadSource = Readonly<{
  agentId: string;
  canonicalKey: string;
  storePath: string;
  sessionId: string;
  lifecycleRevision: string | undefined;
  readSource: CapturedSessionEntryReadSource;
}>;
export type PersonalReadCustody = {
  reads: Array<{
    held: Awaited<ReturnType<typeof prepareSessionMutationFacts>>;
    expected: PersonalReadSource;
    selectorPath: string;
    storeKey: string;
    members: string[];
    entry: InternalSessionEntry;
    root: boolean;
    attested: boolean;
  }>;
  sources: PersonalReadSource[];
  releases: Array<() => void>;
  references: number;
  participants: ReturnType<typeof createPersonalParticipantCustody>;
};
export type PersonalAdmissionBinding = {
  target: ConversationKnowledgeBranch;
  participant: SessionParticipantIdentity;
  selected: readonly { agentId: string; sessionKey: string }[];
  selectedMode: ReturnType<typeof resolveAgentConversationMode>;
  contributionGroupDigest?: string;
  creatingDestination: boolean;
};

export function releasePersonalReadCustody(custody: PersonalReadCustody, retireView: boolean) {
  if (retireView) {
    custody.references--;
  }
  if (custody.references > 0) {
    return;
  }
  const errors: unknown[] = [];
  // Failed terminal cleanup retains native ownership for a later release retry.
  for (let index = custody.releases.length - 1; index >= 0; index--) {
    try {
      custody.releases[index]!();
      custody.releases.splice(index, 1);
    } catch (error) {
      errors.push(error);
    }
  }
  throwSqliteLifecycleErrors(errors, "Personal transcript read release failed");
}
