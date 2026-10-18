import { isDeepStrictEqual } from "node:util";
import {
  conversationKnowledgeAudience,
  conversationKnowledgeAudienceIdentity,
} from "../../config/sessions/conversation-audience.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import type {
  PreparedSessionSourceAuthority,
  SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";

const fields = [
  "sessionId",
  "lifecycleRevision",
  "conversationTopology",
  "incognito",
  "chatType",
  "publicShare",
  "participantCount",
  "participants",
] as const satisfies readonly (keyof InternalSessionEntry)[];

/** Retain the existing native row publication; this adds no history-read permission. */
export async function prepareConversationKnowledgeBranchFacts(params: {
  branch: ConversationKnowledgeBranch;
  getRuntimeConfig: () => OpenClawConfig;
}) {
  const { branch } = params;
  const held = await prepareSessionMutationFacts({
    cfg: params.getRuntimeConfig(),
    agentId: branch.agentId,
    sessionKey: branch.sessionKey,
  });
  let active = true;
  const release = () => {
    if (!active) return;
    active = false;
    held.release();
  };
  try {
    const original = held.readCurrent(params.getRuntimeConfig()).target;
    const originalFields = structuredClone(
      Object.fromEntries(fields.map((field) => [field, original.entry[field]])),
    );
    const current = () => {
      if (!active) throw new Error("Conversation knowledge branch facts have been released");
      const target = held.readCurrent(params.getRuntimeConfig()).target;
      const membership = target.entry.conversationTopology;
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
        fields.some((field) => !isDeepStrictEqual(originalFields[field], target.entry[field]))
      )
        throw new Error("Conversation knowledge branch audience or incarnation changed");
      return target;
    };
    current();
    const prepare = async (): Promise<PreparedSessionSourceAuthority> => {
      const target = current();
      if (!target.readSource) throw new Error("Conversation knowledge native source unavailable");
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
      audience: conversationKnowledgeAudience(original.entry),
      audienceIdentity: conversationKnowledgeAudienceIdentity(original.entry),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
