import { isDeepStrictEqual } from "node:util";
import { conversationKnowledgeLegacySourceNeedsPrivateProof } from "../config/sessions/conversation-audience.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { PersonalConversationReadRefusedError } from "./session-mutation-authorization-error.js";
import { preparePersonalSessionFacts } from "./session-transcript-personal-admission.js";
import type {
  PersonalConversationReadParams,
  RetainedLegacyConversationSourceDenial,
} from "./session-transcript-personal-read.js";

function sourceDenial(
  held: Awaited<ReturnType<typeof preparePersonalSessionFacts>>,
  readSource: CapturedSessionEntryReadSource,
  sessionId: string,
  lifecycleRevision: string,
): RetainedLegacyConversationSourceDenial {
  return {
    isCurrent(cfg) {
      const { target } = held.readCurrent(cfg);
      return (
        isDeepStrictEqual(target.readSource, readSource) &&
        target.entry.sessionId === sessionId &&
        target.entry.lifecycleRevision === lifecycleRevision &&
        conversationKnowledgeLegacySourceNeedsPrivateProof(target.entry)
      );
    },
    release: () => held.release(),
  };
}

export async function preparePersonalReadSource({
  request,
  policy,
  assertCurrent,
  historical,
  target,
  legacy: contribution,
  retainLegacySourceDenial,
  releases,
}: {
  request: { agentId: string; sessionKey: string };
  policy(): OpenClawConfig;
  assertCurrent(): void;
  historical?: CapturedSessionEntryReadSource;
  target: PersonalConversationReadParams["personal"]["target"];
  legacy?: PersonalConversationReadParams["personal"]["contribution"];
  retainLegacySourceDenial?: PersonalConversationReadParams["retainLegacySourceDenial"];
  releases: Array<() => void>;
}) {
  const held = await preparePersonalSessionFacts(
    { cfg: policy(), ...request },
    historical,
    assertCurrent,
  );
  const releaseHeld = () => held.release();
  releases.push(releaseHeld);
  assertCurrent();
  const facts = held.readCurrent(policy());
  const current = facts.target;
  const members = [...facts.membership].toSorted();
  if (
    current.agentId !== target.agentId ||
    current.canonicalKey !== request.sessionKey ||
    current.readSource?.path !== target.storePath ||
    typeof current.readSource.databaseIdentity !== "string" ||
    isIncognitoSessionKey(current.canonicalKey)
  ) {
    throw new PersonalConversationReadRefusedError(
      "Personal conversation source physical ownership changed",
    );
  }
  if (
    current.canonicalKey !== target.sessionKey &&
    contribution &&
    retainLegacySourceDenial &&
    contribution.source.agentId === current.agentId &&
    contribution.source.sessionKey === current.canonicalKey &&
    contribution.source.sessionId === current.entry.sessionId &&
    contribution.source.lifecycleRevision === current.entry.lifecycleRevision &&
    contribution.through.storePath === current.readSource.path &&
    conversationKnowledgeLegacySourceNeedsPrivateProof(current.entry)
  ) {
    const accepted = retainLegacySourceDenial(
      sourceDenial(
        held,
        current.readSource,
        contribution.source.sessionId,
        contribution.source.lifecycleRevision,
      ),
    );
    if (accepted) {
      releases.pop();
    }
    throw new PersonalConversationReadRefusedError(
      "Legacy contribution source has no verifiable private participant",
    );
  }
  return { current, held, members, readSource: current.readSource };
}
