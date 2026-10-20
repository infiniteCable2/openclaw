import { isDeepStrictEqual } from "node:util";
import type { RuntimeContextFragment } from "../../agents/internal-runtime-context.js";
import {
  conversationKnowledgeAudience,
  conversationKnowledgeAudienceIdentity,
  conversationKnowledgeParticipantIdentity,
  conversationKnowledgeContributionIdentity,
  hasOnlyConversationAgentActorChanges,
} from "../../config/sessions/conversation-audience.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "../../config/sessions/conversation-knowledge.js";
import {
  composeSessionSourceAssertion,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import type { PreparedReplyConversationKnowledge } from "./conversation-knowledge.js";

/** Capacity deferral is explicit capability data, never a claim of completed catch-up. */
export function pendingConversationKnowledgeNotice() {
  const fragments: RuntimeContextFragment[] = [
    {
      kind: "conversation-data",
      text: "Related-conversation catch-up is incomplete: a historical source exceeds the bounded seed capacity. Continue the current conversation normally; do not assume all related history has been incorporated or shared.",
    },
  ];
  return {
    fragments,
    withContext(existing: readonly RuntimeContextFragment[] = []): RuntimeContextFragment[] {
      return [...existing.filter((item) => !fragments.includes(item)), ...fragments];
    },
  };
}

/** Absence is model-visible capability data, not an invented history permission. */
export function unavailableConversationKnowledge(
  params: {
    assertCurrent: SessionSourceAssertion;
    signal?: AbortSignal;
  },
  reason: "original-participant-unconfirmed" | "private-destination-audience-unconfirmed",
): PreparedReplyConversationKnowledge {
  let active = true;
  const assertCurrent = composeSessionSourceAssertion([params.assertCurrent], (assertSource) => {
    if (!active) {
      throw new Error("Conversation knowledge capability has been released");
    }
    params.signal?.throwIfAborted();
    assertSource();
  });
  return {
    fragments: [
      {
        kind: "conversation-data",
        text: JSON.stringify({
          capability: "related-conversation-context",
          available: false,
          reason,
          coverage: "Only the current conversation context is available automatically.",
        }),
      },
    ],
    observed: [],
    assertCurrent,
    release: () => {
      active = false;
    },
  };
}

const fields = [
  "sessionId",
  "lifecycleRevision",
  "conversationTopology",
  "incognito",
  "chatType",
  "publicShare",
  "participantCount",
  "participants",
  "delivery",
] as const satisfies readonly (keyof InternalSessionEntry)[];

/** Retain the existing native row publication; this adds no history-read permission. */
export async function prepareConversationKnowledgeBranchFacts(params: {
  branch: ConversationKnowledgeBranch;
  getRuntimeConfig: () => OpenClawConfig;
  destinationAudience?: ConversationPrivateAudience;
  /** Only supplied with the corresponding native purpose-limited transcript grant. */
  contribution?: ConversationKnowledgeReference;
}) {
  const { branch } = params;
  const held = await prepareSessionMutationFacts({
    cfg: params.getRuntimeConfig(),
    agentId: branch.agentId,
    sessionKey: branch.sessionKey,
  });
  let active = true;
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    held.release();
  };
  try {
    const original = held.readCurrent(params.getRuntimeConfig()).target;
    const destination = params.destinationAudience;
    const destinationIdentity =
      destination &&
      destination.agentId === branch.agentId &&
      destination.sessionKey === branch.sessionKey &&
      original.entry.publicShare === undefined &&
      conversationKnowledgeParticipantIdentity(destination.participant);
    const contributionIdentity = conversationKnowledgeContributionIdentity(
      original.entry,
      branch,
      params.contribution,
    );
    const privateIdentity = destinationIdentity || contributionIdentity;
    const originalActors = structuredClone({
      participants: original.entry.participants,
      participantCount: original.entry.participantCount,
    });
    const originalFields = structuredClone(
      Object.fromEntries(fields.map((field) => [field, original.entry[field]])),
    );
    const current = () => {
      if (!active) {
        throw new Error("Conversation knowledge branch facts have been released");
      }
      const target = held.readCurrent(params.getRuntimeConfig()).target;
      params.destinationAudience?.assertCurrent();
      const membership = target.entry.conversationTopology;
      const actorOnlyChange =
        privateIdentity && hasOnlyConversationAgentActorChanges(originalActors, target.entry);
      if (
        target.agentId !== branch.agentId ||
        target.canonicalKey !== branch.sessionKey ||
        target.readSource?.path !== branch.storePath ||
        target.entry.sessionId !== branch.sessionId ||
        target.entry.lifecycleRevision !== branch.lifecycleRevision ||
        target.entry.incognito ||
        membership?.role !== "branch" ||
        membership.rootSessionKey !== branch.root.sessionKey ||
        membership.rootSessionId !== branch.root.sessionId ||
        membership.rootSessionLifecycleRevision !== branch.root.lifecycleRevision ||
        fields.some(
          (field) =>
            !(actorOnlyChange && (field === "participants" || field === "participantCount")) &&
            !isDeepStrictEqual(originalFields[field], target.entry[field]),
        )
      ) {
        throw new Error("Conversation knowledge branch audience or incarnation changed");
      }
      return target;
    };
    current();
    const prepare = async (): Promise<PreparedSessionSourceAuthority> => {
      const target = current();
      if (!target.readSource) {
        throw new Error("Conversation knowledge native source unavailable");
      }
      return {
        assertCurrent: () => void current(),
        assertPreparedCurrent: () => void current(),
        checks: [
          {
            predicate: {
              source: { ...target.readSource },
              sessionKey: target.storeKey,
              fields: [...fields],
              expected: structuredClone(target.entry),
            },
            refuse: (): never => {
              throw new Error("Conversation knowledge branch facts changed before commit");
            },
          },
        ],
      };
    };
    const assertCurrent: SessionSourceAssertion = Object.assign(() => void current(), {
      prepareSessionSource: prepare,
      prepareSessionSourceScope: prepare,
    });
    return {
      assertCurrent,
      audience: privateIdentity
        ? ("private-direct" as const)
        : conversationKnowledgeAudience(original.entry),
      audienceIdentity: privateIdentity || conversationKnowledgeAudienceIdentity(original.entry),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
