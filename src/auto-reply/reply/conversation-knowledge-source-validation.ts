import { isDeepStrictEqual } from "node:util";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { SessionMutationFactsUnavailableError } from "../../gateway/session-sharing-incognito.js";
import type { PreparedConversationKnowledgePacket } from "./conversation-knowledge-source-cache.js";

/** Validate cached bytes against their exact native source range without hydrating text. */
export async function validatePreparedConversationKnowledgeSource(params: {
  staged: PreparedConversationKnowledgePacket;
  projectionTarget: SessionTranscriptRuntimeTarget;
  through: TranscriptEntryAnchor;
  from?: TranscriptEntryAnchor;
  sourceAssertion: SessionSourceAssertion;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
  readyOnly?: boolean;
}): Promise<boolean> {
  const { staged, through, from } = params;
  if (!isDeepStrictEqual(staged.through, through) || !isDeepStrictEqual(staged.from, from)) {
    return false;
  }
  let valid = false;
  await readSessionTranscriptAnchorsAsync(
    params.projectionTarget,
    { entryIds: [], contextValidation: { version: staged.version, through, from } },
    params.signal,
    (facts) => {
      params.sourceAssertion();
      valid = facts.contextValidated === true;
    },
  ).catch((error: unknown) => {
    params.assertCurrent();
    params.signal?.throwIfAborted();
    if (
      !(error instanceof SessionTranscriptReadFenceError) &&
      !(params.readyOnly && error instanceof SessionMutationFactsUnavailableError)
    ) {
      throw error;
    }
  });
  return valid;
}
