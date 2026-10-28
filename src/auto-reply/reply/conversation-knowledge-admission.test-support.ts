import { onTestFinished } from "vitest";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "../../config/sessions/conversation-knowledge.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { SessionSharingTarget } from "../../gateway/session-sharing-policy.js";
import { preparePersonalConversationRead } from "../../gateway/session-transcript-personal-read.js";

type SyntheticPersonalFacts = {
  readCurrent(): { target: SessionSharingTarget; membership: Set<string> };
  release(): void;
};

/** Mint the real private brand; only native storage facts are substituted by the unit fixture. */
export async function createPreparedKnowledgeAdmission(params: {
  branch: ConversationKnowledgeBranch;
  donor: ConversationKnowledgeReference["source"];
  participant: SessionParticipantIdentity;
  installFacts(prepare: (request: { sessionKey: string }) => Promise<SyntheticPersonalFacts>): void;
}) {
  const { branch, donor, participant } = params;
  const rows = new Map<string, SessionSharingTarget>();
  for (const source of [branch, branch.root, donor]) {
    const root = source.sessionKey === branch.root.sessionKey;
    rows.set(source.sessionKey, {
      agentId: branch.agentId,
      canonicalKey: source.sessionKey,
      storeKey: source.sessionKey,
      storeKeys: [source.sessionKey],
      storePath: branch.storePath,
      readSource: {
        agentId: branch.agentId,
        path: branch.storePath,
        databaseIdentity: "synthetic-physical-store",
        databaseBirthtime: "synthetic-store-birth",
      },
      entry: {
        sessionId: source.sessionId,
        lifecycleRevision: source.lifecycleRevision,
        updatedAt: 1,
        visibility: "draft",
        ...(root
          ? {
              createdVia: "internal",
              createdActor: { type: "system", id: "conversation-root" },
              delivery: { kind: "none" },
              conversationTopology: { version: 1, role: "root" },
            }
          : {
              chatType: "direct",
              participantCount: 1,
              participants: [{ identity: participant }],
              conversationTopology: {
                version: 1,
                role: "branch",
                rootSessionKey: branch.root.sessionKey,
                rootSessionId: branch.root.sessionId,
                rootSessionLifecycleRevision: branch.root.lifecycleRevision,
              },
            }),
      },
    });
  }
  params.installFacts(async ({ sessionKey }) => {
    const target = rows.get(sessionKey);
    if (!target) {
      throw new Error("Synthetic admission selected an unexpected native source");
    }
    let active = true;
    return {
      readCurrent() {
        if (!active) {
          throw new Error("Synthetic native custody released");
        }
        return { target, membership: new Set<string>() };
      },
      release() {
        active = false;
      },
    };
  });
  const grant = await preparePersonalConversationRead({
    purpose: "conversation-differences",
    personal: { originalParticipant: participant, target: branch, assertCurrent() {} },
    sources: [donor],
    getRuntimeConfig: () => ({
      agents: { entries: { [branch.agentId]: { conversationMode: "branches" } } },
    }),
  });
  try {
    const prepared = grant.prepareAdmission();
    onTestFinished(() => prepared.release());
    return prepared;
  } finally {
    grant.release();
  }
}
