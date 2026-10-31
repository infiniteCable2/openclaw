import { isDeepStrictEqual } from "node:util";
import { isIncognitoSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { resolveAgentConversationMode } from "../agent-conversation-mode.js";
import { createRuntimeConfigSnapshotMatcher } from "../runtime-config-snapshot-match.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { conversationKnowledgeParticipantIdentity } from "./conversation-audience.js";
import { isConversationBranchCreationAudienceConfirmed } from "./conversation-branch-creation-audience.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import type { SessionEntryCreationOperation } from "./session-accessor.sqlite-entry-cache.types.js";
import {
  admitSessionConversationBranch,
  assertSessionConversationRootEntry,
} from "./session-conversation-admission.js";
import { resolveAgentConversationRootSessionKey } from "./session-conversation-root-key.js";
import { prepareSessionGenerationFacts } from "./session-delivery-generation.js";
import { assertSessionEntryCohortScope } from "./session-entry-cohort-scope.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionParticipantIdentity } from "./session-participant-identity.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
  type SessionSourcePredicate,
} from "./session-source-authority.js";
import { resolveSessionWorkStartError } from "./session-work-start.js";
import type { InternalSessionEntry } from "./types.js";

const creationIssuer = Symbol("conversation-branch-creation");
/** Native fields which determine private branch custody, including infrastructure roots. */
export const conversationBranchAuthorityFields = Object.freeze([
  "sessionId",
  "lifecycleRevision",
  "conversationTopology",
  "chatType",
  "createdVia",
  "createdActor",
  "visibility",
  "publicShare",
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
  "participantCount",
  "participants",
  "incognito",
  "archivedAt",
  "initializationPending",
  "mainRestartRecovery",
  "modelSelectionLocked",
  "pendingProjectGitUrl",
  "pendingWorktree",
  "providerReview",
] as const satisfies readonly (keyof InternalSessionEntry)[]);
// Native token totals and backend history caches may change during initialization.
// Disclosure still binds the complete prospective security/lifecycle policy.
const entryFields = [
  ...conversationBranchAuthorityFields,
  "permissionMode",
  "toolOverrides",
] as const;

type CreationPreparation = {
  branch: ConversationKnowledgeBranch;
  entry: InternalSessionEntry;
  audience: ConversationPrivateAudience;
  reader: SessionEntryCohortReader;
  getRuntimeConfig(): OpenClawConfig;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
};

/** Native absence and creator publication, not a proposed row's authority. */
class PreparedConversationBranchCreation {
  readonly branch: ConversationKnowledgeBranch;
  readonly audience: ConversationPrivateAudience;
  readonly participant: SessionParticipantIdentity;
  readonly source: SessionSourceAssertion;
  readonly #entry: InternalSessionEntry;
  readonly #readSource: CapturedSessionEntryReadSource;
  readonly #generation: Awaited<ReturnType<typeof prepareSessionGenerationFacts>>;
  readonly #check: () => void;
  #active = true;
  #publicationRefused = false;

  constructor(
    issuer: typeof creationIssuer,
    params: CreationPreparation,
    readSource: CapturedSessionEntryReadSource,
    rootEntry: InternalSessionEntry,
    generation: Awaited<ReturnType<typeof prepareSessionGenerationFacts>>,
    matchesConfig: (current: OpenClawConfig) => boolean,
    participant: SessionParticipantIdentity,
  ) {
    if (issuer !== creationIssuer) {
      throw new Error("Conversation creation requires native preparation");
    }
    this.branch = freezeJsonSnapshot(structuredClone(params.branch));
    this.#entry = freezeJsonSnapshot(structuredClone(params.entry));
    this.audience = params.audience;
    this.participant = freezeJsonSnapshot(structuredClone(participant));
    this.#readSource = freezeJsonSnapshot(structuredClone(readSource));
    this.#generation = generation;
    const check = (assertOriginal?: () => void) => {
      if (!this.#active || this.#publicationRefused) {
        throw new Error("Conversation creation custody was released");
      }
      params.signal?.throwIfAborted();
      assertOriginal?.();
      params.reader.assertCurrent();
      params.audience.assertCurrent();
      generation.assertCurrent();
      if (
        !matchesConfig(params.getRuntimeConfig()) ||
        params.audience.agentId !== this.branch.agentId ||
        params.audience.sessionKey !== this.branch.sessionKey ||
        conversationKnowledgeParticipantIdentity(params.audience.participant) !==
          conversationKnowledgeParticipantIdentity(this.participant)
      ) {
        throw new Error("Conversation creation identity or configuration changed");
      }
    };
    this.#check = () => check(params.assertCurrent);
    const assertLocalCurrent = () => check();
    // The lifecycle worker checks these before its own absent-to-created mutation.
    // The generation owner alone adopts the exact bound creation publication.
    const predicates: SessionSourcePredicate[] = freezeJsonSnapshot([
      {
        source: this.#readSource,
        sessionKey: this.branch.sessionKey,
        fields: [],
        expected: undefined,
        members: [],
      },
      {
        source: this.#readSource,
        sessionKey: this.branch.root.sessionKey,
        fields: [...conversationBranchAuthorityFields],
        expected: freezeJsonSnapshot(structuredClone(rootEntry)),
      },
    ]);
    this.source = composeSessionSourceAssertion([
      params.assertCurrent,
      Object.assign(assertLocalCurrent, {
        prepareSessionSource: async () => {
          this.#check();
          if (generation.isCreationAdopted()) {
            throw new Error("Conversation creation was already committed");
          }
          return {
            assertCurrent: assertLocalCurrent,
            // Preserve the full native/prepared-scope guard when a parent
            // assertion is intentionally deferred by its own native contract.
            assertPreparedCurrent: this.#check,
            checks: predicates.map((predicate) => ({
              predicate,
              refuse: (): never => {
                throw new Error("Conversation creation source changed before commit");
              },
            })),
          };
        },
      }),
    ]);
    this.#check();
    Object.freeze(this);
  }

  static assert(
    this: void,
    params: {
      creation: PreparedConversationBranchCreation;
      branch: ConversationKnowledgeBranch;
      participant?: SessionParticipantIdentity;
      audience?: ConversationPrivateAudience;
    },
  ): CapturedSessionEntryReadSource {
    const { creation } = params;
    if (!(creation instanceof PreparedConversationBranchCreation) || !(#entry in creation)) {
      throw new Error("Conversation creation requires native preparation");
    }
    creation.#check();
    if (params.audience !== creation.audience) {
      params.audience?.assertCurrent();
    }
    if (
      !isDeepStrictEqual(params.branch, creation.branch) ||
      (params.participant &&
        conversationKnowledgeParticipantIdentity(params.participant) !==
          conversationKnowledgeParticipantIdentity(creation.participant)) ||
      (params.audience &&
        (params.audience.agentId !== creation.branch.agentId ||
          params.audience.sessionKey !== creation.branch.sessionKey ||
          conversationKnowledgeParticipantIdentity(params.audience.participant) !==
            conversationKnowledgeParticipantIdentity(creation.participant)))
    ) {
      throw new Error("Conversation creation differs from its admitted destination");
    }
    return creation.#readSource;
  }

  static consume(
    this: void,
    params: Parameters<typeof PreparedConversationBranchCreation.assert>[0],
  ): CapturedSessionEntryReadSource {
    const source = PreparedConversationBranchCreation.assert(params);
    if (params.creation.#generation.isCreationAdopted()) {
      throw new Error("Conversation creation was already committed");
    }
    return source;
  }

  assertEntry(entry: InternalSessionEntry): void {
    this.#check();
    if (entryFields.some((field) => !isDeepStrictEqual(entry[field], this.#entry[field]))) {
      throw new Error("Conversation creation proposed entry changed");
    }
  }

  bindCreation(operation: SessionEntryCreationOperation): () => void {
    this.#check();
    return this.#generation.bindCreation(operation, (binding) => {
      if (
        binding.sessionId !== this.branch.sessionId ||
        binding.lifecycleRevision !== this.branch.lifecycleRevision
      ) {
        this.#publicationRefused = true;
        throw new Error("Conversation creation publication differs from its prepared destination");
      }
    });
  }

  release(): void {
    if (!this.#active) {
      return;
    }
    this.#active = false;
    this.#generation.release();
  }
}
Object.freeze(PreparedConversationBranchCreation);
Object.freeze(PreparedConversationBranchCreation.prototype);
export type { PreparedConversationBranchCreation };

export const assertConversationBranchCreation = PreparedConversationBranchCreation.assert;
export const consumeConversationBranchCreation = PreparedConversationBranchCreation.consume;

/** Root membership may precede the new row only under its actual native creator. */
export function assertConversationBranchCreationRoot(params: {
  creation: PreparedConversationBranchCreation;
  branch: ConversationKnowledgeBranch;
  source: CapturedSessionEntryReadSource;
  currentEntry?: InternalSessionEntry;
  rootEntry: InternalSessionEntry | undefined;
}): void {
  const source = PreparedConversationBranchCreation.assert(params);
  assertSessionConversationRootEntry(params.rootEntry, params.branch.root.sessionKey);
  if (
    params.currentEntry !== undefined ||
    !isDeepStrictEqual(params.source, source) ||
    params.rootEntry.sessionId !== params.branch.root.sessionId ||
    params.rootEntry.lifecycleRevision !== params.branch.root.lifecycleRevision
  ) {
    throw new Error("Conversation creation root or absent destination changed");
  }
}

/** Capture absence once; the native writer still compares it inside creation COMMIT. */
export async function prepareConversationBranchCreation(
  input: CreationPreparation,
): Promise<PreparedConversationBranchCreation> {
  const params = {
    ...input,
    branch: structuredClone(input.branch),
    entry: structuredClone(input.entry),
  };
  const { branch, entry, audience, reader } = params;
  if (reader.sessionKey !== branch.sessionKey && reader.sessionKey !== branch.root.sessionKey) {
    throw new Error("Conversation creation requires its target or root reader");
  }
  assertSessionEntryCohortScope(reader, { ...branch, sessionKey: reader.sessionKey });
  audience.assertCurrent();
  const participant = freezeJsonSnapshot(structuredClone(audience.participant));
  const matchesConfig = createRuntimeConfigSnapshotMatcher(params.getRuntimeConfig());
  const identity = conversationKnowledgeParticipantIdentity(participant);
  if (
    !isConversationBranchCreationAudienceConfirmed({
      agentId: branch.agentId,
      sessionKey: branch.sessionKey,
      entry,
      audience,
    }) ||
    entry.sessionId !== branch.sessionId ||
    !branch.lifecycleRevision ||
    entry.lifecycleRevision !== branch.lifecycleRevision ||
    entry.parentSessionKey !== undefined ||
    entry.parentSessionId !== undefined ||
    entry.parentSessionLifecycleRevision !== undefined ||
    entry.spawnedBy !== undefined ||
    entry.spawnedBySessionId !== undefined ||
    entry.spawnDepth !== undefined ||
    entry.forkSource !== undefined ||
    entry.forkedFromParent === true ||
    isIncognitoSessionKey(branch.sessionKey) ||
    isSubagentSessionKey(branch.sessionKey) ||
    resolveSessionWorkStartError(branch.sessionKey, entry) !== undefined ||
    resolveAgentConversationMode(params.getRuntimeConfig(), branch.agentId) !== "branches" ||
    params.getRuntimeConfig().session?.scope === "global" ||
    resolveAgentConversationRootSessionKey({
      cfg: params.getRuntimeConfig(),
      agentId: branch.agentId,
    }) !== branch.root.sessionKey
  ) {
    throw new Error("Conversation creation requires an original private same-person branch");
  }
  const check = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
    audience.assertCurrent();
    reader.assertCurrent();
    if (
      !matchesConfig(params.getRuntimeConfig()) ||
      conversationKnowledgeParticipantIdentity(audience.participant) !== identity
    ) {
      throw new Error("Conversation creation identity or configuration changed");
    }
  };
  check();
  const generation = await prepareSessionGenerationFacts({
    ...branch,
    sessionId: null,
    lifecycleRevision: null,
    env: reader.database.env,
  });
  try {
    const captured = await reader.withRead(
      { sessionKeys: [branch.sessionKey, branch.root.sessionKey], includeMembers: true },
      check,
      (read) => {
        const current = read.entries.find((row) => row.sessionKey === branch.sessionKey)?.entry;
        const root = read.entries.find((row) => row.sessionKey === branch.root.sessionKey)?.entry;
        const topology = admitSessionConversationBranch({
          agentId: branch.agentId,
          sessionKey: branch.sessionKey,
          rootSessionKey: branch.root.sessionKey,
          rootEntry: root,
        });
        if (
          current ||
          read.members?.[branch.sessionKey]?.length ||
          read.source.path !== branch.storePath ||
          read.source.agentId !== branch.agentId ||
          typeof read.source.databaseIdentity !== "string" ||
          !isDeepStrictEqual(entry.conversationTopology, topology) ||
          root?.sessionId !== branch.root.sessionId ||
          root.lifecycleRevision !== branch.root.lifecycleRevision
        ) {
          throw new Error("Conversation creation absence or root changed");
        }
        return { source: structuredClone(read.source), root: structuredClone(root) };
      },
    );
    check();
    generation.assertCurrent();
    return new PreparedConversationBranchCreation(
      creationIssuer,
      params,
      captured.source,
      captured.root,
      generation,
      matchesConfig,
      participant,
    );
  } catch (error) {
    generation.release();
    throw error;
  }
}
