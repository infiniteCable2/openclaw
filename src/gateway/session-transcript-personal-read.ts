import { isDeepStrictEqual } from "node:util";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import {
  conversationKnowledgeAudienceIdentity,
  conversationKnowledgeParticipantIdentity,
} from "../config/sessions/conversation-audience.js";
import type { ConversationKnowledgeBranch } from "../config/sessions/conversation-knowledge-store.js";
import { assertSessionConversationRootEntry } from "../config/sessions/session-conversation-admission.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import {
  composeSessionSourceAssertion,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

export type PersonalConversationReadParams = {
  purpose: "conversation-differences";
  personal: {
    originalParticipant: SessionParticipantIdentity;
    assertCurrent: SessionSourceAssertion;
    target: ConversationKnowledgeBranch;
  };
  getRuntimeConfig(): OpenClawConfig;
  sources: readonly { agentId: string; sessionKey: string }[];
};

// These are the native audience, membership and root-admission facts consumed below.
const fields = [
  "sessionId",
  "lifecycleRevision",
  "conversationTopology",
  "chatType",
  "publicShare",
  "participantCount",
  "participants",
  "incognito",
  "createdVia",
  "createdActor",
  "visibility",
  "delivery",
  "parentSessionKey",
  "parentSessionId",
  "parentSessionLifecycleRevision",
  "spawnedBy",
  "spawnedBySessionId",
  "spawnDepth",
  "forkSource",
  "forkedFromParent",
  "owner",
  "archivedAt",
  "initializationPending",
  "mainRestartRecovery",
  "modelSelectionLocked",
  "pendingProjectGitUrl",
  "pendingWorktree",
  "providerReview",
] as const satisfies readonly (keyof InternalSessionEntry)[];

/** Internal purpose of the native read owner, never a general history or operator grant. */
export async function preparePersonalConversationRead(params: PersonalConversationReadParams) {
  const target = structuredClone(params.personal.target);
  const participant = structuredClone(params.personal.originalParticipant);
  const selected = params.sources.map(({ agentId, sessionKey }) => ({ agentId, sessionKey }));
  const original = params.personal.assertCurrent;
  original();
  if (
    (participant.type !== "profile" && participant.type !== "remote") ||
    !participant.id.trim() ||
    (participant.type === "profile" && participant.id === GATEWAY_OWNER_PROFILE_ID) ||
    !target.lifecycleRevision ||
    !selected.length ||
    selected.length + 2 > MAX_SESSION_ROW_FACTS_KEYS ||
    [
      target.sessionKey,
      target.root.sessionKey,
      ...selected.map((source) => source.sessionKey),
    ].some(
      (key) => isIncognitoSessionKey(key) || parseAgentSessionKey(key)?.agentId !== target.agentId,
    ) ||
    selected.some((source) => source.agentId !== target.agentId)
  ) {
    throw new Error(
      "Personal conversation differences require an original same-person branch source",
    );
  }
  const audienceIdentity = conversationKnowledgeParticipantIdentity(participant);
  type Held = Awaited<ReturnType<typeof prepareSessionMutationFacts>>;
  type Source = Readonly<{
    agentId: string;
    canonicalKey: string;
    storePath: string;
    sessionId: string;
    lifecycleRevision: string | undefined;
    readSource: CapturedSessionEntryReadSource;
  }>;
  const reads: Array<{
    held: Held;
    expected: Source;
    storeKey: string;
    members: string[];
    entry: InternalSessionEntry;
    root: boolean;
  }> = [];
  const sources: Source[] = [];
  const releases: Array<() => void> = [];
  let active = true;
  let refusal: unknown;
  let revoked = false;
  const refuse = (error: unknown): never => {
    revoked = true;
    refusal = error;
    throw error;
  };
  const policy = () => {
    if (!active) {
      throw new Error("Personal conversation read has been released");
    }
    if (revoked) {
      throw refusal;
    }
    original();
    const cfg = params.getRuntimeConfig();
    if (resolveAgentConversationMode(cfg, target.agentId) !== "branches") {
      throw new Error("Personal conversation difference mode changed");
    }
    return cfg;
  };
  const checkEntry = (entry: InternalSessionEntry, isRoot: boolean) => {
    if (isRoot) {
      assertSessionConversationRootEntry(entry, target.root.sessionKey);
      if (
        entry.sessionId !== target.root.sessionId ||
        entry.lifecycleRevision !== target.root.lifecycleRevision
      ) {
        throw new Error("Personal conversation root incarnation changed");
      }
      return;
    }
    const membership = entry.conversationTopology;
    if (
      entry.incognito ||
      !entry.lifecycleRevision ||
      conversationKnowledgeAudienceIdentity(entry) !== audienceIdentity ||
      membership?.role !== "branch" ||
      membership.rootSessionKey !== target.root.sessionKey ||
      membership.rootSessionId !== target.root.sessionId ||
      membership.rootSessionLifecycleRevision !== target.root.lifecycleRevision
    ) {
      throw new Error("Personal conversation source audience or root is not the original person's");
    }
  };
  const checkMembers = (members: readonly string[], root: boolean) => {
    if (
      !root &&
      members.some((member) => participant.type !== "profile" || member !== participant.id)
    ) {
      throw new Error("Personal conversation has another explicitly shared reader");
    }
  };
  const assertCurrent = () => {
    try {
      const cfg = policy();
      for (const read of reads) {
        const facts = read.held.readCurrent(cfg);
        const current = facts.target;
        const expected = read.expected;
        if (
          current.agentId !== expected.agentId ||
          current.canonicalKey !== expected.canonicalKey ||
          current.storePath !== expected.storePath ||
          current.storeKey !== read.storeKey ||
          !isDeepStrictEqual(current.readSource, expected.readSource) ||
          !isDeepStrictEqual([...facts.membership].toSorted(), read.members) ||
          fields.some((field) => !isDeepStrictEqual(current.entry[field], read.entry[field]))
        ) {
          throw new Error("Personal conversation source changed after admission");
        }
        checkEntry(current.entry, read.root);
        checkMembers(read.members, read.root);
      }
    } catch (error) {
      refuse(error);
    }
  };
  const release = () => {
    active = false;
    const errors: unknown[] = [];
    for (let index = releases.length - 1; index >= 0; index--) {
      try {
        releases[index]!();
        releases.splice(index, 1);
      } catch (error) {
        errors.push(error);
      }
    }
    throwSqliteLifecycleErrors(errors, "Personal transcript read release failed");
  };
  const hold = async (request: { agentId: string; sessionKey: string }, root: boolean) => {
    assertCurrent();
    const held = await prepareSessionMutationFacts({ cfg: policy(), ...request });
    releases.push(() => held.release());
    assertCurrent();
    const facts = held.readCurrent(policy());
    const current = facts.target;
    const members = [...facts.membership].toSorted();
    if (
      current.agentId !== target.agentId ||
      current.canonicalKey !== request.sessionKey ||
      current.storePath !== target.storePath ||
      current.readSource?.path !== target.storePath ||
      typeof current.readSource.databaseIdentity !== "string" ||
      isIncognitoSessionKey(current.canonicalKey)
    ) {
      throw new Error("Personal conversation source physical ownership changed");
    }
    checkEntry(current.entry, root);
    checkMembers(members, root);
    const expected = Object.freeze({
      agentId: current.agentId,
      canonicalKey: current.canonicalKey,
      storePath: current.storePath,
      sessionId: current.entry.sessionId,
      lifecycleRevision: current.entry.lifecycleRevision,
      readSource: Object.freeze({ ...current.readSource }),
    });
    reads.push({
      held,
      expected,
      storeKey: current.storeKey,
      members,
      entry: structuredClone(current.entry),
      root,
    });
    assertCurrent();
    return expected;
  };
  try {
    const originalTarget = await hold(
      { agentId: target.agentId, sessionKey: target.sessionKey },
      false,
    );
    if (
      originalTarget.sessionId !== target.sessionId ||
      originalTarget.lifecycleRevision !== target.lifecycleRevision
    ) {
      throw new Error("Personal destination is not the original input incarnation");
    }
    const originalRoot = await hold(
      { agentId: target.agentId, sessionKey: target.root.sessionKey },
      true,
    );
    if (!isDeepStrictEqual(originalRoot.readSource, originalTarget.readSource)) {
      throw new Error("Personal conversation root differs from the original physical store");
    }
    for (const request of selected) {
      const source = await hold(request, false);
      if (!isDeepStrictEqual(source.readSource, originalTarget.readSource)) {
        throw new Error("Personal conversation sources do not share the original physical store");
      }
      sources.push(source);
    }
    const prepare = async (): Promise<PreparedSessionSourceAuthority> => {
      assertCurrent();
      return {
        assertCurrent,
        assertPreparedCurrent: () => {
          try {
            policy();
          } catch (error) {
            refuse(error);
          }
        },
        checks: reads.map((read) => ({
          predicate: {
            source: read.expected.readSource,
            sessionKey: read.storeKey,
            fields: [...fields],
            expected: structuredClone(read.entry),
            members: [...read.members],
          },
          refuse: () => refuse(new Error("Personal conversation read facts changed before commit")),
        })),
      };
    };
    const source = Object.assign(assertCurrent, {
      prepareSessionSource: prepare,
      prepareSessionSourceScope: prepare,
    });
    return {
      sources: Object.freeze(sources),
      assertCurrent: composeSessionSourceAssertion([original, source]),
      release,
    };
  } catch (error) {
    try {
      release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Personal read preparation cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
