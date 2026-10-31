import { isDeepStrictEqual } from "node:util";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import {
  conversationKnowledgeParticipantIdentity,
  conversationKnowledgeHistoricalContributionIdentity,
} from "../../config/sessions/conversation-audience.js";
import {
  assertConversationBranchCreation,
  type PreparedConversationBranchCreation,
} from "../../config/sessions/conversation-branch-creation.js";
import { conversationKnowledgeCheckpointRangeDigest } from "../../config/sessions/conversation-knowledge-checkpoint.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import type { ConversationKnowledgeRootContinuation } from "../../config/sessions/conversation-knowledge-root-cache.js";
import { selectConversationKnowledgeReceipts } from "../../config/sessions/conversation-knowledge-selection.js";
import {
  assertNativeKnowledgeRootContribution,
  readConversationKnowledgeRoot,
  type ConversationKnowledgeBranch,
} from "../../config/sessions/conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_SOURCE_LIMITS,
  projectConversationKnowledge,
  renderConversationKnowledgePacketText,
  type ConversationKnowledgeReference,
} from "../../config/sessions/conversation-knowledge.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import type { PreparedInitialSessionContextSourceClaim } from "../../config/sessions/session-initial-context.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
  type PreparedSessionSourceAuthority,
} from "../../config/sessions/session-source-authority.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { readSessionTranscriptModelContextAsync } from "../../config/sessions/session-transcript-context-read.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  PersonalConversationReadRefusedError,
  SessionMutationAuthorizationChangedError,
} from "../../gateway/session-mutation-authorization-error.js";
import {
  preparePersonalConversationContributionGroup,
  preparePersonalConversationRead,
  type PreparedPersonalConversationContributionGroup,
} from "../../gateway/session-transcript-personal-read.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import type { PreparedConversationKnowledgePacket } from "./conversation-knowledge-source-cache.js";
import {
  createConversationKnowledgeSourceReader,
  prepareConversationKnowledgeTarget,
  type ConversationKnowledgeHeldSource,
} from "./conversation-knowledge-source-reader.js";

export type PreparedRootKnowledgeContribution = {
  contributionId: string;
  complete: true;
  text: string;
  reference: ConversationKnowledgeReference;
  packet: PreparedConversationKnowledgePacket;
};

export type PreparedRootKnowledgeRange = {
  through: ConversationKnowledgeReference["through"];
  from?: ConversationKnowledgeReference["through"];
  claim: PreparedInitialSessionContextSourceClaim;
};

const log = createSubsystemLogger("conversation-knowledge");

/** Current broker custody authorizes root preparation; saved checkpoint provenance never does. */
export async function prepareConversationKnowledgeCheckpointSources(params: {
  branch: ConversationKnowledgeBranch;
  participant: SessionParticipantIdentity;
  audience: ConversationPrivateAudience;
  reader: SessionEntryCohortReader;
  signal: AbortSignal;
  assertCurrent: SessionSourceAssertion;
  getRuntimeConfig(): OpenClawConfig;
  rootContinuation?: ConversationKnowledgeRootContinuation;
  targetCreation?: PreparedConversationBranchCreation;
  /** Retains cleanup even if preparation fails before returning its sources. */
  retainCleanup(release: () => void): void;
}) {
  const audienceKey = conversationKnowledgeParticipantIdentity(params.participant);
  if (!audienceKey) {
    throw new Error("Checkpoint broker lacks a personal identity");
  }
  if (params.targetCreation) {
    assertConversationBranchCreation({
      creation: params.targetCreation,
      branch: params.branch,
      participant: params.participant,
      audience: params.audience,
    });
  }
  const brokerTarget = params.targetCreation
    ? {
        kind: "ready" as const,
        branch: params.targetCreation.branch,
        targetFacts: {
          assertCurrent: params.targetCreation.source,
          audience: "private-direct" as const,
          audienceIdentity: audienceKey,
          release() {},
        },
      }
    : await prepareConversationKnowledgeTarget({
        reader: params.reader,
        sessionId: params.branch.sessionId,
        destinationAudience: params.audience,
        participantIdentity: audienceKey,
        expectedAudienceIdentity: audienceKey,
        signal: params.signal,
        assertCurrent: params.assertCurrent,
        getRuntimeConfig: () => params.getRuntimeConfig(),
      });
  if (brokerTarget?.kind !== "ready") {
    throw new Error("Checkpoint broker is unavailable");
  }
  const { branch, targetFacts } = brokerTarget;
  const reads: ConversationKnowledgeHeldSource[] = [];
  const groups: PreparedPersonalConversationContributionGroup[] = [];
  const proofs: SessionSourceAssertion[] = [];
  const versionProofs = new Map<string, SessionSourceAssertion>();
  let released = false;
  let targetReleased = false;
  const check = () => {
    if (released) {
      throw new Error("Checkpoint source custody has ended");
    }
    params.signal.throwIfAborted();
    params.assertCurrent();
    targetFacts.assertCurrent();
    params.audience.assertCurrent();
  };
  const drop = (read: ConversationKnowledgeHeldSource) => {
    const index = reads.indexOf(read);
    read.grant.release();
    if (index >= 0) {
      reads.splice(index, 1);
    }
  };
  const release = () => {
    released = true;
    const failures: unknown[] = [];
    for (const read of reads.toReversed()) {
      try {
        drop(read);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const group of groups.toReversed()) {
      try {
        group.release();
        groups.splice(groups.indexOf(group), 1);
      } catch (error) {
        failures.push(error);
      }
    }
    if (!targetReleased) {
      try {
        targetFacts.release();
        targetReleased = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Checkpoint source cleanup remains pending");
    }
  };
  params.retainCleanup(release);
  try {
    const events = await readConversationKnowledgeRoot({
      branch,
      reader: params.reader,
      assertCurrent: check,
      signal: params.signal,
      rootContinuation: params.rootContinuation,
      creation: params.targetCreation,
    });
    check();
    const rootReferences = selectConversationKnowledgeReceipts(
      events,
      branch.root.sessionId,
      branch.root.sessionKey,
    ).filter(
      (reference) =>
        !reference.retirement &&
        reference.source.agentId === branch.agentId &&
        conversationKnowledgeParticipantIdentity(reference.privateAudience?.participant) ===
          audienceKey,
    );
    const sourceReader = createConversationKnowledgeSourceReader({
      branch,
      originalParticipant: params.participant,
      destinationAudience: params.audience,
      rootEvidence: events.evidence,
      targetCreation: params.targetCreation,
      targetFacts,
      assertCurrent: check,
      getRuntimeConfig: () => params.getRuntimeConfig(),
      signal: params.signal,
      hasRetainedContribution: () => false,
      reads,
      drop,
    });
    const prepared = new Map<
      string,
      PreparedRootKnowledgeContribution & { claim: PreparedInitialSessionContextSourceClaim }
    >();
    const readAvailableSource = async <T>(
      reference: ConversationKnowledgeReference,
      operation: () => Promise<T>,
    ): Promise<T | undefined> => {
      const readCount = reads.length;
      const groupCount = groups.length;
      const proofCount = proofs.length;
      try {
        return await operation();
      } catch (error) {
        // Loss of broker/audience custody is not an unavailable donor. Storage
        // and worker failures still reach the background owner's bounded retry.
        check();
        if (
          !(error instanceof SessionTranscriptReadFenceError) &&
          !(error instanceof SessionMutationAuthorizationChangedError)
        ) {
          throw error;
        }
        for (const read of reads.slice(readCount).toReversed()) {
          drop(read);
        }
        for (const group of groups.slice(groupCount).toReversed()) {
          group.release();
          groups.splice(groups.indexOf(group), 1);
        }
        proofs.splice(proofCount);
        log.debug("Related-history checkpoint source deferred", {
          rootHash: redactIdentifier(JSON.stringify([branch.agentId, branch.root])),
          sourceHash: redactIdentifier(reference.source.sessionId),
          reason: "source-range-unavailable",
        });
        return undefined;
      }
    };
    const ownSource = async (reference: ConversationKnowledgeReference) =>
      params.reader.withRead(
        { sessionKeys: [branch.sessionKey], includeParticipantRecords: true },
        check,
        (facts) => {
          const entry = facts.entries.find((row) => row.sessionKey === branch.sessionKey)?.entry;
          if (
            !entry ||
            entry.sessionId !== branch.sessionId ||
            entry.lifecycleRevision !== branch.lifecycleRevision ||
            reference.source.sessionId !== branch.sessionId
          ) {
            throw new PersonalConversationReadRefusedError(
              "Checkpoint own source incarnation changed",
            );
          }
          if (
            reference.source.lifecycleRevision !== entry.lifecycleRevision &&
            conversationKnowledgeHistoricalContributionIdentity(
              entry,
              branch,
              reference,
              branch.root,
            ) !== audienceKey
          ) {
            throw new PersonalConversationReadRefusedError(
              "Checkpoint historical own source is not currently private to this person",
            );
          }
          return facts.source;
        },
      );
    const recordVersionProof = (
      reference: ConversationKnowledgeReference,
      nativeSource: CapturedSessionEntryReadSource,
      version: PreparedConversationKnowledgePacket["version"],
      lifecycleRevision = reference.source.lifecycleRevision,
      range?: {
        through: ConversationKnowledgeReference["through"];
        from?: ConversationKnowledgeReference["through"];
      },
    ) => {
      const predicate = {
        source: nativeSource,
        sessionKey: reference.source.sessionKey,
        fields: ["sessionId", "lifecycleRevision"] as const,
        expected: { sessionId: reference.source.sessionId, lifecycleRevision },
        transcript: {
          sessionId: reference.source.sessionId,
          version,
          consistency: "prefix" as const,
        },
      };
      const proofKey = JSON.stringify([
        nativeSource,
        predicate.sessionKey,
        predicate.expected,
        version,
      ]);
      const retained = versionProofs.get(proofKey);
      if (!retained || !proofs.includes(retained)) {
        const proof = Object.assign(() => check(), {
          prepareSessionSource: async (): Promise<PreparedSessionSourceAuthority> => ({
            assertCurrent: check,
            checks: [
              {
                predicate: { ...predicate, fields: [...predicate.fields] },
                refuse: (): never => {
                  throw new Error("Checkpoint original source changed before publication");
                },
              },
            ],
          }),
        });
        proofs.push(proof);
        versionProofs.set(proofKey, proof);
      }
      return {
        reference,
        predicate: { ...predicate, fields: [...predicate.fields] },
        sessionId: reference.source.sessionId,
        version,
        through: range?.through ?? reference.readRange?.through ?? reference.through,
        from: range
          ? range.from
          : (reference.readRange?.admission ?? reference.privateAudience?.admission),
      } satisfies PreparedInitialSessionContextSourceClaim;
    };
    const read = async (reference: ConversationKnowledgeReference, retainText = true) => {
      check();
      assertNativeKnowledgeRootContribution(events.evidence, branch, reference);
      const contributionId = conversationKnowledgeContributionId(reference);
      const cached = prepared.get(contributionId);
      if (cached) {
        return cached;
      }
      let projection;
      let nativeSource: CapturedSessionEntryReadSource;
      let currentLifecycle: string;
      let through = reference.readRange?.through ?? reference.through;
      let from = reference.readRange?.admission ?? reference.privateAudience?.admission;
      if (reference.source.sessionKey === branch.sessionKey) {
        // This is the already admitted branch's own history, not a cross-session grant.
        nativeSource = await ownSource(reference);
        currentLifecycle = branch.lifecycleRevision;
        projection = await readSessionTranscriptModelContextAsync(
          branch,
          (context) => {
            check();
            return context;
          },
          undefined,
          params.signal,
          reference.readRange?.through ?? reference.through,
          {
            ...CONVERSATION_KNOWLEDGE_SOURCE_LIMITS,
            from: reference.readRange?.admission ?? reference.privateAudience?.admission,
          },
        );
      } else {
        const current = await sourceReader.take(reference);
        if (!current.source) {
          throw new SessionTranscriptReadFenceError("Checkpoint source authority is unavailable");
        }
        projection = await sourceReader.load(
          current.source,
          current.projection,
          reference,
          undefined,
          false,
        );
        proofs.push(current.source.sourceAssertion);
        nativeSource = current.source.grant.sources[0]!.readSource;
        const lifecycle = current.source.grant.sources[0]!.lifecycleRevision;
        if (!lifecycle) {
          throw new Error("Checkpoint current source lifecycle is unavailable");
        }
        currentLifecycle = lifecycle;
        through = current.source.through;
        from = current.source.from;
      }
      check();
      if (!projection.version) {
        throw new Error("Checkpoint source lacks a native version");
      }
      const version = projection.version;
      const claim = recordVersionProof(reference, nativeSource, version, currentLifecycle, {
        through,
        from,
      });
      const part = projectConversationKnowledge(
        reference,
        projection.events,
        undefined,
        "private-direct",
        {
          maxChars: CONVERSATION_KNOWLEDGE_SOURCE_LIMITS.maxBytes,
        },
      );
      if (!part?.frontier || typeof part.complete !== "boolean" || !part.complete) {
        throw new SessionTranscriptReadFenceError(
          "Checkpoint exact whole source range is unavailable",
        );
      }
      const value = {
        contributionId,
        complete: true as const,
        text: renderConversationKnowledgePacketText(reference, part.text),
        reference,
        packet: { part, version, through, from },
        claim,
      };
      if (retainText) {
        prepared.set(contributionId, value);
      }
      return value;
    };
    const validate = async (
      reference: ConversationKnowledgeReference,
      packet?: PreparedConversationKnowledgePacket,
    ) => {
      check();
      assertNativeKnowledgeRootContribution(events.evidence, branch, reference);
      let nativeSource: CapturedSessionEntryReadSource;
      let currentLifecycle: string;
      let through = reference.readRange?.through ?? reference.through;
      let from = reference.readRange?.admission ?? reference.privateAudience?.admission;
      let target = { ...reference.source, storePath: reference.through.storePath };
      if (reference.source.sessionKey === branch.sessionKey) {
        nativeSource = await ownSource(reference);
        currentLifecycle = branch.lifecycleRevision;
      } else {
        const current = await sourceReader.take(reference);
        if (!current.source) {
          throw new SessionTranscriptReadFenceError("Checkpoint source authority is unavailable");
        }
        proofs.push(current.source.sourceAssertion);
        nativeSource = current.source.grant.sources[0]!.readSource;
        const lifecycle = current.source.grant.sources[0]!.lifecycleRevision;
        if (!lifecycle) {
          throw new Error("Checkpoint current source lifecycle is unavailable");
        }
        currentLifecycle = lifecycle;
        through = current.source.through;
        from = current.source.from;
        target = { ...target, ...current.source.projectionTarget };
      }
      if (
        packet &&
        conversationKnowledgeCheckpointRangeDigest(reference, { through, from }) !==
          conversationKnowledgeCheckpointRangeDigest(reference, packet)
      ) {
        throw new SessionTranscriptReadFenceError("Checkpoint prepared source range changed");
      }
      let valid = false;
      const anchorFacts = await readSessionTranscriptAnchorsAsync(
        target,
        {
          entryIds: [],
          includeContextVersion: true,
          contextValidation: { version: packet?.version, through, from },
        },
        params.signal,
        (facts) => {
          check();
          valid = facts.contextValidated === true;
        },
      );
      check();
      if (!valid || !anchorFacts.contextVersion) {
        throw new SessionTranscriptReadFenceError("Checkpoint prepared source prefix changed");
      }
      const claim = recordVersionProof(
        reference,
        nativeSource,
        anchorFacts.contextVersion,
        currentLifecycle,
        { through, from },
      );
      return { through, from, claim };
    };
    return {
      audienceKey,
      references: rootReferences,
      read: (reference: ConversationKnowledgeReference, retainText = true) =>
        readAvailableSource(reference, () => read(reference, retainText)),
      validate: (
        reference: ConversationKnowledgeReference,
        packet?: PreparedConversationKnowledgePacket,
      ) => readAvailableSource(reference, () => validate(reference, packet)),
      async verify(reference: ConversationKnowledgeReference) {
        return readAvailableSource(reference, () => validate(reference));
      },
      async verifyAll(
        references: readonly ConversationKnowledgeReference[],
        verified: (
          reference: ConversationKnowledgeReference,
          range: PreparedRootKnowledgeRange,
        ) => void,
        cachedPackets?: ReadonlyMap<string, PreparedConversationKnowledgePacket>,
      ) {
        let complete = true;
        const bySource = new Map<string, ConversationKnowledgeReference[]>();
        for (const reference of references) {
          check();
          assertNativeKnowledgeRootContribution(events.evidence, branch, reference);
          if (
            reference.source.sessionKey === branch.sessionKey &&
            reference.source.sessionId === branch.sessionId &&
            reference.source.lifecycleRevision === branch.lifecycleRevision
          ) {
            const range = await readAvailableSource(reference, () =>
              validate(
                reference,
                cachedPackets?.get(conversationKnowledgeContributionId(reference)),
              ),
            );
            if (!range) {
              complete = false;
              continue;
            }
            verified(reference, range);
            continue;
          }
          const key = JSON.stringify(reference.source);
          const values = bySource.get(key) ?? [];
          values.push(reference);
          bySource.set(key, values);
        }
        for (const contributions of bySource.values()) {
          check();
          const available = await readAvailableSource(contributions[0]!, async () => {
            const personal = {
              originalParticipant: params.participant,
              assertCurrent: composeSessionSourceAssertion([
                params.assertCurrent,
                targetFacts.assertCurrent,
                check,
              ]),
              target: branch,
              targetAudience: params.audience,
              targetCreation: params.targetCreation,
              rootEvidence: events.evidence,
            };
            const common = {
              purpose: "conversation-differences" as const,
              signal: params.signal,
              getRuntimeConfig: () => params.getRuntimeConfig(),
              sources: [contributions[0]!.source],
            };
            const group = await preparePersonalConversationContributionGroup({
              ...common,
              personal: { ...personal, contributions },
            });
            groups.push(group);
            const grant = await preparePersonalConversationRead({
              ...common,
              personal: { ...personal, contributionGroup: group },
            });
            reads.push({ grant });
            proofs.push(grant.assertCurrent);
            const source = grant.sources[0];
            if (!source?.lifecycleRevision) {
              throw new SessionTranscriptReadFenceError(
                "Checkpoint grouped source lifecycle is unavailable",
              );
            }
            const checkedVersions = new Set<string>();
            const selected = [];
            for (const reference of contributions) {
              const range = grant.selectContribution(reference);
              if (!range?.version) {
                throw new SessionTranscriptReadFenceError(
                  "Checkpoint grouped source range is unavailable",
                );
              }
              const packet = cachedPackets?.get(conversationKnowledgeContributionId(reference));
              if (
                packet &&
                conversationKnowledgeCheckpointRangeDigest(reference, range) !==
                  conversationKnowledgeCheckpointRangeDigest(reference, packet)
              ) {
                throw new SessionTranscriptReadFenceError(
                  "Checkpoint prepared source range changed",
                );
              }
              if (packet) {
                const versionKey = JSON.stringify([
                  packet.version.generation,
                  packet.version.rawSeq,
                  packet.version.updatedAt,
                ]);
                if (
                  !checkedVersions.has(versionKey) &&
                  !isDeepStrictEqual(packet.version, range.version)
                ) {
                  // The native group already proved all current anchors. Revalidate
                  // each distinct cached prefix once, never one RPC per original.
                  const facts = await readSessionTranscriptAnchorsAsync(
                    {
                      agentId: source.agentId,
                      sessionKey: source.canonicalKey,
                      sessionId: source.sessionId,
                      storePath: source.readSource.path,
                    },
                    {
                      entryIds: [],
                      includeContextVersion: true,
                      contextValidation: { version: packet.version },
                    },
                    params.signal,
                  );
                  check();
                  grant.assertCurrent();
                  if (facts.contextValidated !== true) {
                    throw new SessionTranscriptReadFenceError(
                      "Checkpoint prepared source prefix changed",
                    );
                  }
                }
                checkedVersions.add(versionKey);
                recordVersionProof(
                  reference,
                  source.readSource,
                  packet.version,
                  source.lifecycleRevision,
                  range,
                );
              }
              const claim = recordVersionProof(
                reference,
                source.readSource,
                range.version,
                source.lifecycleRevision,
                range,
              );
              selected.push({ reference, range: { ...range, claim } });
            }
            grant.assertCurrent();
            group.release();
            groups.splice(groups.indexOf(group), 1);
            grant.assertCurrent();
            for (const value of selected) {
              verified(value.reference, value.range);
            }
            return true;
          });
          if (!available) {
            complete = false;
          }
        }
        return complete;
      },
      // Snapshot only after every required source has been acquired.
      source: () =>
        composeSessionSourceAssertion([
          params.assertCurrent,
          targetFacts.assertCurrent,
          check,
          ...proofs,
        ]),
      release,
    };
  } catch (error) {
    try {
      release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Checkpoint source preparation failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
