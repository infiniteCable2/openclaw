import type { ConversationKnowledgeReference } from "../config/sessions/conversation-knowledge.js";
import type { SessionTranscriptContextVersion } from "../config/sessions/session-transcript-context-version.types.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import { PersonalConversationReadRefusedError } from "./session-mutation-authorization-error.js";
export async function validatePersonalContributionGroupAnchors(params: {
  contributions: readonly ConversationKnowledgeReference[];
  source: {
    agentId: string;
    canonicalKey: string;
    sessionId: string;
    lifecycleRevision?: string;
    readSource: { path: string };
  };
  assertCurrent(): void;
  signal?: AbortSignal;
  preparedVersion?: SessionTranscriptContextVersion;
}): Promise<SessionTranscriptContextVersion> {
  let contributionVersion: SessionTranscriptContextVersion | undefined;
  // One worker snapshot per group. These are the same identity/navigation
  // fields checked by assertSessionTranscriptContextAnchorInDatabase.
  const selectedSource = params.source;
  const { readSessionTranscriptAnchorsAsync } =
    await import("../config/sessions/session-transcript-anchor-read.js");
  params.assertCurrent();
  if (params.preparedVersion) {
    const facts = await readSessionTranscriptAnchorsAsync(
      {
        agentId: selectedSource.agentId,
        sessionKey: selectedSource.canonicalKey,
        sessionId: selectedSource.sessionId,
        storePath: selectedSource.readSource.path,
      },
      {
        entryIds: [],
        includeContextVersion: true,
        includeSession: true,
        contextValidation: { version: params.preparedVersion },
      },
      params.signal,
    );
    params.assertCurrent();
    if (
      facts.contextValidated !== true ||
      !facts.contextVersion ||
      facts.session?.sessionId !== selectedSource.sessionId ||
      facts.session.lifecycleRevision !== selectedSource.lifecycleRevision
    ) {
      throw new PersonalConversationReadRefusedError(
        "Prepared contribution prefix is no longer current",
      );
    }
    return params.preparedVersion;
  }
  const expectedAnchors = params.contributions.flatMap((reference) => [
    reference.readRange?.admission ?? reference.privateAudience!.admission,
    reference.readRange?.through ?? reference.through,
  ]);
  const entryIds = [...new Set(expectedAnchors.map((anchor) => anchor.entryId))];
  const anchors = new Map<string, TranscriptEntryAnchor>();
  // The native borrowed cohort reserves one fact for its session row. Keep
  // the original prefix across pages; navigation rewrites invalidate it.
  const quantum = MAX_SESSION_ROW_FACTS_KEYS - 1;
  for (let offset = 0; offset < entryIds.length; offset += quantum) {
    const facts = await readSessionTranscriptAnchorsAsync(
      {
        agentId: selectedSource.agentId,
        sessionKey: selectedSource.canonicalKey,
        sessionId: selectedSource.sessionId,
        storePath: selectedSource.readSource.path,
      },
      {
        entryIds: entryIds.slice(offset, offset + quantum),
        includeContextVersion: true,
        includeSession: true,
        ...(contributionVersion ? { contextValidation: { version: contributionVersion } } : {}),
      },
      params.signal,
    );
    params.assertCurrent();
    if (
      !facts.contextVersion ||
      facts.session?.sessionId !== selectedSource.sessionId ||
      facts.session.lifecycleRevision !== selectedSource.lifecycleRevision
    ) {
      throw new PersonalConversationReadRefusedError(
        "Contribution group lost its native source snapshot",
      );
    }
    contributionVersion ??= Object.freeze({ ...facts.contextVersion });
    for (const anchor of facts.anchors) {
      anchors.set(anchor.entryId, anchor);
    }
  }
  for (const expected of expectedAnchors) {
    const actual = anchors.get(expected.entryId);
    if (
      !actual ||
      expected.rawSeq > (contributionVersion?.rawSeq ?? -1) ||
      (
        [
          "agentId",
          "sessionKey",
          "sessionId",
          "storePath",
          "generation",
          "entryId",
          "rawSeq",
          "effectiveParentId",
          "activeMessagePosition",
        ] as const
      ).some((field) => actual[field] !== expected[field])
    ) {
      throw new PersonalConversationReadRefusedError(
        "Contribution group exact native anchor changed",
      );
    }
  }
  for (let index = 0; index < expectedAnchors.length; index += 2) {
    const from = expectedAnchors[index]!,
      through = expectedAnchors[index + 1]!;
    if (from.generation !== through.generation || from.rawSeq > through.rawSeq) {
      throw new PersonalConversationReadRefusedError("Contribution group range order changed");
    }
  }

  if (!contributionVersion) {
    throw new PersonalConversationReadRefusedError("Contribution group has no native prefix");
  }
  return contributionVersion;
}
