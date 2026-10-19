import type { PreparedReplyConversationKnowledge } from "../auto-reply/reply/conversation-knowledge.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import { conversationKnowledgeParticipantIdentity } from "../config/sessions/conversation-audience.js";
import {
  participantIdentityNamespace,
  type SessionParticipantIdentity,
} from "../config/sessions/session-participant-identity.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ConversationPrivateAudience } from "../sessions/conversation-private-audience.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadKnowledge = createLazyRuntimeModule(async () => {
  const [admission, knowledge, recordObservation, participants] = await Promise.all([
    import("../config/sessions/session-accessor.sqlite-entry-admission.js"),
    import("../auto-reply/reply/conversation-knowledge.js"),
    import("../config/sessions/conversation-knowledge-store.js").then(
      ({ recordConversationUtteranceObservation }) => recordConversationUtteranceObservation,
    ),
    import("../config/sessions/session-sharing-store.async.js"),
  ]);
  return {
    loadSessionEntryForAdmission: admission.loadSessionEntryForAdmission,
    prepareReplyConversationKnowledge: knowledge.prepareReplyConversationKnowledge,
    recordConversationUtteranceObservation: recordObservation,
    recordSessionParticipant: participants.recordSessionParticipantInWorker,
  };
});

const log = createSubsystemLogger("talk/conversation-knowledge");

/** Observe the exact saved speech occurrence, never completed work or an inferred human. */
export async function recordVoiceConversationObservation(params: {
  anchor: TranscriptEntryAnchor;
  lifecycleRevision: string;
  role: "user" | "assistant";
  participant?: SessionParticipantIdentity;
  destinationAudience?: ConversationPrivateAudience;
  fresh: boolean;
  timestamp: number;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  assertCurrent: SessionSourceAssertion;
}): Promise<void> {
  const sourceMode = resolveAgentConversationMode(params.config, params.anchor.agentId);
  try {
    params.assertCurrent();
    const owner = await loadKnowledge();
    params.assertCurrent();
    const target = { ...params.anchor, env: params.env };
    const held = await owner.loadSessionEntryForAdmission(target, {
      assertCurrent: params.assertCurrent,
    });
    try {
      params.assertCurrent();
      held.databaseClaim.assertCurrent();
      if (
        held.entry?.sessionId !== params.anchor.sessionId ||
        held.entry.lifecycleRevision !== params.lifecycleRevision
      ) {
        throw new Error("Original voice observation session changed");
      }
      if (held.entry.conversationTopology?.role !== "branch") {
        return;
      }
      if (params.role === "user" && params.participant && params.fresh) {
        await owner.recordSessionParticipant(
          target,
          {
            identity: params.participant,
            promptedAt: params.timestamp,
            sessionAgentId: params.anchor.agentId,
            expectedSession: {
              sessionId: params.anchor.sessionId,
              lifecycleRevision: params.lifecycleRevision,
            },
          },
          params.assertCurrent,
        );
      }
      const reader =
        "kind" in held.databaseClaim && held.databaseClaim.kind === "worker"
          ? held.databaseClaim.reader
          : undefined;
      if (!reader) {
        return;
      }
      const audience = params.destinationAudience;
      const recipient = audience?.participant;
      const privateAudience =
        params.fresh &&
        audience?.agentId === params.anchor.agentId &&
        audience.sessionKey === params.anchor.sessionKey &&
        recipient &&
        (recipient.type === "profile" || recipient.type === "remote") &&
        (params.role === "assistant" ||
          conversationKnowledgeParticipantIdentity(params.participant) ===
            conversationKnowledgeParticipantIdentity(recipient))
          ? { participant: recipient, admission: params.anchor }
          : undefined;
      await owner.recordConversationUtteranceObservation({
        reader,
        assertCurrent: privateAudience
          ? composeSessionSourceAssertion([params.assertCurrent, () => audience!.assertCurrent()])
          : params.assertCurrent,
        sessionId: params.anchor.sessionId,
        anchor: params.anchor,
        role: params.role,
        sourceMode,
        ...(privateAudience ? { privateAudience } : {}),
      });
    } finally {
      await held.databaseClaim.release();
    }
  } catch (error) {
    // Speech has already committed. An auxiliary report cannot replay the utterance or its work.
    log.warn("Saved voice transcript retained; related-conversation observation unavailable.", {
      error: formatErrorMessage(error),
    });
  }
}

export type PreparedVoiceConversationKnowledge = Omit<
  PreparedReplyConversationKnowledge,
  "release"
> & {
  release(): Promise<void>;
};

/** Borrow an existing native reader, never initialize a session or infer a history grant. */
export async function prepareVoiceConversationKnowledge(params: {
  target: { agentId: string; sessionKey: string; sessionId: string; storePath: string };
  assertCurrent: SessionSourceAssertion;
  participant?: SessionParticipantIdentity;
  getRuntimeConfig(): OpenClawConfig;
  destinationAudience?: ConversationPrivateAudience;
  signal?: AbortSignal;
}): Promise<PreparedVoiceConversationKnowledge | undefined> {
  const participant = params.participant && Object.freeze({ ...params.participant });
  const expectedAudienceIdentity =
    participant?.type === "profile" || participant?.type === "remote"
      ? JSON.stringify([participantIdentityNamespace(participant), participant.id])
      : undefined;
  params.assertCurrent();
  params.signal?.throwIfAborted();
  const knowledge = await loadKnowledge();
  params.assertCurrent();
  const held = await knowledge.loadSessionEntryForAdmission(params.target, {
    assertCurrent: params.assertCurrent,
    signal: params.signal,
  });
  let prepared: PreparedReplyConversationKnowledge | undefined;
  let active = true;
  let releasing: Promise<void> | undefined;
  const assertCurrent = composeSessionSourceAssertion([params.assertCurrent], (check) => {
    if (!active) {
      throw new Error("Voice conversation knowledge has been released");
    }
    check();
    params.signal?.throwIfAborted();
    held.databaseClaim.assertCurrent();
  });
  const release = () =>
    (releasing ??= (async () => {
      active = false;
      const errors: unknown[] = [];
      try {
        prepared?.release();
      } catch (error) {
        errors.push(error);
      }
      try {
        await held.databaseClaim.release();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        throw new AggregateError(errors, "Voice knowledge release failed");
      }
    })());
  try {
    assertCurrent();
    if (held.entry?.sessionId !== params.target.sessionId) {
      throw new Error("Voice conversation changed before its context read");
    }
    if (held.entry.conversationTopology?.role !== "branch") {
      await release();
      return undefined;
    }
    const reader =
      "kind" in held.databaseClaim && held.databaseClaim.kind === "worker"
        ? held.databaseClaim.reader
        : undefined;
    if (reader && expectedAudienceIdentity) {
      prepared = await knowledge.prepareReplyConversationKnowledge({
        reader,
        sessionId: params.target.sessionId,
        assertCurrent,
        originalParticipant: participant,
        destinationAudience: params.destinationAudience,
        expectedAudienceIdentity,
        getRuntimeConfig: () => params.getRuntimeConfig(),
        signal: params.signal,
      });
      assertCurrent();
      prepared?.assertCurrent();
    }
    return {
      fragments: prepared?.fragments ?? [
        {
          kind: "conversation-data",
          text: JSON.stringify({
            capability: "related-conversation-context",
            available: false,
            reason: !expectedAudienceIdentity
              ? "original-participant-unconfirmed"
              : reader
                ? "conversation-not-admitted"
                : "original-native-reader-unavailable",
          }),
        },
      ],
      observed: prepared?.observed ?? [],
      assertCurrent: composeSessionSourceAssertion([assertCurrent, prepared?.assertCurrent]),
      release,
    };
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Voice knowledge preparation cleanup failed",
        {
          cause: cleanupError,
        },
      );
    }
    throw error;
  }
}
