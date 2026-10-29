import { isDeepStrictEqual } from "node:util";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "./conversation-knowledge.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export type PersonalConversationContributionRange = Readonly<{
  origin: string;
  originalLifecycleRevision: string;
  currentLifecycleRevision: string;
  through: TranscriptEntryAnchor;
  from?: TranscriptEntryAnchor;
  version?: SessionTranscriptContextVersion;
}>;

const custody = new WeakMap<
  PersonalConversationContributionRange,
  {
    reference: ConversationKnowledgeReference;
    target: ConversationKnowledgeBranch;
    source: SessionSourceAssertion;
  }
>();

/** Internal native read-owner handoff; shares its existing lifetime, never acquires a lease. */
export function issuePersonalConversationContributionRange(params: {
  range: PersonalConversationContributionRange;
  reference: ConversationKnowledgeReference;
  target: ConversationKnowledgeBranch;
  source: SessionSourceAssertion;
}): PersonalConversationContributionRange {
  const range = Object.freeze({
    ...params.range,
    through: Object.freeze({ ...params.range.through }),
    ...(params.range.from ? { from: Object.freeze({ ...params.range.from }) } : {}),
  });
  custody.set(range, {
    reference: structuredClone(params.reference),
    target: structuredClone(params.target),
    source: params.source,
  });
  return range;
}

/** Original provenance stays unchanged; only its independently current custody may advance. */
export function readPersonalConversationContributionCustody(params: {
  proof: PersonalConversationContributionRange;
  reference: ConversationKnowledgeReference;
  target: ConversationKnowledgeBranch;
}) {
  const held = custody.get(params.proof);
  if (
    !held ||
    !isDeepStrictEqual(held.reference, params.reference) ||
    !isDeepStrictEqual(held.target, params.target)
  ) {
    throw new SessionTranscriptReadFenceError("Knowledge packet contribution custody changed");
  }
  held.source();
  return { lifecycleRevision: params.proof.currentLifecycleRevision, source: held.source };
}
