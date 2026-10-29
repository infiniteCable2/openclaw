import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CONVERSATION_KNOWLEDGE_CHECKPOINT_CONTEXT,
  readConversationKnowledgeCheckpointContext,
  resolveConversationKnowledgeImportProgress,
  type ConversationKnowledgeCheckpointContext,
} from "./conversation-knowledge-checkpoint-context.js";
import type { PreparedConversationKnowledgeCheckpointCoverage } from "./conversation-knowledge-checkpoint.js";
import { readConversationKnowledgeReports } from "./conversation-knowledge-history.js";
import {
  conversationKnowledgeContributionId,
  conversationKnowledgePacketId,
} from "./conversation-knowledge-identity.js";
import {
  readPersonalConversationContributionCustody,
  type PersonalConversationContributionRange,
} from "./conversation-knowledge-source-custody.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_NOTICE,
  renderConversationKnowledgePacketText,
  type ConversationKnowledgeReference,
} from "./conversation-knowledge.js";
import { appendSessionTranscriptReportBatch } from "./session-accessor.sqlite-transcript-reports.js";
import type { CustomMessageReportAppend } from "./session-accessor.sqlite-transcript-reports.types.js";
import type {
  SessionTranscriptRuntimeTarget,
  SessionTranscriptWriteScope,
} from "./session-accessor.types.js";
import { assertSessionEntryCohortScope } from "./session-entry-cohort-scope.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import type { SessionSourceAssertion, SessionSourcePredicate } from "./session-source-authority.js";
import { composeSessionSourceAssertion } from "./session-source-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";

export const CONVERSATION_KNOWLEDGE_CONTEXT = "openclaw.conversation-knowledge-context.v1";
export {
  CONVERSATION_KNOWLEDGE_NOTICE,
  conversationKnowledgeContributionId,
  conversationKnowledgePacketId,
};

export type ConversationKnowledgePacketProgress = {
  complete: boolean;
  nextOffset: number;
  coverage?: "summary";
};

type ConversationKnowledgePacketReportInput = {
  branch: ConversationKnowledgeBranch;
  receipt: ConversationKnowledgeReference;
  text: string;
  offset: number;
  nextOffset: number;
  complete: boolean;
};

/** Live hydration and durable admission use the same quoted-data envelope and receipt identity. */
export function createConversationKnowledgePacketReport(
  params: ConversationKnowledgePacketReportInput,
) {
  const contributionId = conversationKnowledgeContributionId(params.receipt);
  const packetId = conversationKnowledgePacketId(contributionId, params.offset);
  return {
    customType: CONVERSATION_KNOWLEDGE_CONTEXT,
    display: false,
    content: `${CONVERSATION_KNOWLEDGE_NOTICE}\n${renderConversationKnowledgePacketText(params.receipt, params.text)}`,
    details: {
      version: 1,
      packetId,
      contributionId,
      rootSessionId: params.branch.root.sessionId,
      rootLifecycleRevision: params.branch.root.lifecycleRevision,
      source: params.receipt.source,
      through: params.receipt.through,
      offset: params.offset,
      nextOffset: params.nextOffset,
      complete: params.complete,
      coverage: "durably-admitted-observation-not-proof-of-task-execution",
    },
  } satisfies CustomMessageReportAppend;
}

export type ConversationKnowledgeImportProgress = {
  packets: Map<string, ConversationKnowledgePacketProgress>;
  checkpoints: ConversationKnowledgeCheckpointContext[];
};

/** Receipt scan only; never follows root chains or silently treats summarized coverage as absent. */
export async function readConversationKnowledgeImportProgress(params: {
  branch: ConversationKnowledgeBranch;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
}): Promise<ConversationKnowledgeImportProgress> {
  const events = await readConversationKnowledgeReports({
    target: params.branch,
    customTypes: [CONVERSATION_KNOWLEDGE_CONTEXT, CONVERSATION_KNOWLEDGE_CHECKPOINT_CONTEXT],
    detailsOnly: true,
    assertCurrent: params.assertCurrent,
    signal: params.signal,
  });
  const progress = new Map<string, ConversationKnowledgePacketProgress>();
  const checkpoints = new Map<string, ConversationKnowledgeCheckpointContext>();
  for (const event of events) {
    const record = asOptionalRecord(event);
    if (record?.customType === CONVERSATION_KNOWLEDGE_CHECKPOINT_CONTEXT) {
      const checkpoint = readConversationKnowledgeCheckpointContext(record.details);
      if (
        checkpoint?.rootSessionId === params.branch.root.sessionId &&
        checkpoint.rootLifecycleRevision === params.branch.root.lifecycleRevision
      ) {
        checkpoints.set(checkpoint.checkpointId, checkpoint);
      }
      continue;
    }
    const packet = asOptionalRecord(record?.details);
    if (
      packet?.version !== 1 ||
      packet.rootSessionId !== params.branch.root.sessionId ||
      packet.rootLifecycleRevision !== params.branch.root.lifecycleRevision ||
      typeof packet.contributionId !== "string" ||
      typeof packet.complete !== "boolean" ||
      !Number.isSafeInteger(packet.nextOffset) ||
      Number(packet.nextOffset) < 0
    ) {
      continue;
    }
    const previous = progress.get(packet.contributionId);
    if (!previous?.complete && (!previous || previous.nextOffset <= Number(packet.nextOffset))) {
      progress.set(packet.contributionId, {
        complete: packet.complete,
        nextOffset: Number(packet.nextOffset),
      });
    }
  }
  return { packets: progress, checkpoints: [...checkpoints.values()] };
}

/** Admission, not semantic comprehension. Native history/compaction retains admitted text. */
export async function readConversationKnowledgePacketProgress(params: {
  branch: ConversationKnowledgeBranch;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
  checkpointCoverage?: ReadonlyMap<string, PreparedConversationKnowledgeCheckpointCoverage>;
  /** Background preparation only; model boundaries supply already prepared progress. */
  prepareCheckpointCoverage?: (
    checkpoints: readonly ConversationKnowledgeCheckpointContext[],
  ) => Promise<ReadonlyMap<string, PreparedConversationKnowledgeCheckpointCoverage>>;
}): Promise<ReadonlyMap<string, ConversationKnowledgePacketProgress>> {
  const imports = await readConversationKnowledgeImportProgress(params);
  const checkpointCoverage =
    imports.checkpoints.length && params.prepareCheckpointCoverage
      ? await params.prepareCheckpointCoverage(imports.checkpoints)
      : params.checkpointCoverage;
  params.assertCurrent();
  params.signal?.throwIfAborted();
  return resolveConversationKnowledgeImportProgress({ ...params, imports, checkpointCoverage });
}

/** Recheck only carriers still owned by native context, never their compacted ancestors. */
export async function readActiveConversationKnowledgePacketIds(params: {
  branch: ConversationKnowledgeBranch;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
}): Promise<string[]> {
  const events = await readConversationKnowledgeReports({
    target: params.branch,
    customTypes: [CONVERSATION_KNOWLEDGE_CONTEXT, CONVERSATION_KNOWLEDGE_CHECKPOINT_CONTEXT],
    modelContextOnly: true,
    detailsOnly: true,
    assertCurrent: params.assertCurrent,
    signal: params.signal,
  });
  return events.flatMap((event) => {
    const record = asOptionalRecord(event);
    const packet =
      record?.customType === CONVERSATION_KNOWLEDGE_CHECKPOINT_CONTEXT
        ? readConversationKnowledgeCheckpointContext(record.details)
        : asOptionalRecord(record?.details);
    return packet?.version === 1 &&
      packet.rootSessionId === params.branch.root.sessionId &&
      packet.rootLifecycleRevision === params.branch.root.lifecycleRevision &&
      typeof packet.packetId === "string"
      ? [packet.packetId]
      : [];
  });
}

/** Original live source checks authorize the copy; subsequent replay is recipient history. */
export async function retainConversationKnowledgePacket(
  params: ConversationKnowledgePacketReportInput & {
    writeTarget: SessionTranscriptRuntimeTarget &
      Pick<SessionTranscriptWriteScope, "expectedWriterRunId" | "expectedLifecycleRevision">;
    reader: SessionEntryCohortReader;
    sourceVersion: SessionTranscriptContextVersion;
    source: SessionSourceAssertion;
    historicalCustody?: PersonalConversationContributionRange;
    signal?: AbortSignal;
    contextLimits?: { maxBytes: number; maxEvents: number };
  },
): Promise<string | undefined> {
  const { branch, writeTarget, reader, signal, contextLimits, ...packet } = params;
  const result = await retainConversationKnowledgePackets({
    branch,
    writeTarget,
    reader,
    signal,
    contextLimits,
    packets: [packet],
  });
  return result.packetIds[0];
}

export type ConversationKnowledgePacketAdmission = Omit<
  ConversationKnowledgePacketReportInput,
  "branch"
> & {
  sourceVersion: SessionTranscriptContextVersion;
  source: SessionSourceAssertion;
  /** Only the native personal read owner may bridge an original lifecycle to current custody. */
  historicalCustody?: PersonalConversationContributionRange;
};

/** A bounded native publication retains individual receipts and exact committed-prefix progress. */
export async function retainConversationKnowledgePackets(params: {
  branch: ConversationKnowledgeBranch;
  writeTarget: SessionTranscriptRuntimeTarget &
    Pick<SessionTranscriptWriteScope, "expectedWriterRunId" | "expectedLifecycleRevision">;
  reader: SessionEntryCohortReader;
  packets: readonly ConversationKnowledgePacketAdmission[];
  signal?: AbortSignal;
  contextLimits?: { maxBytes: number; maxEvents: number };
}): Promise<{ accepted: number; appended: number; deferred: boolean; packetIds: string[] }> {
  params.signal?.throwIfAborted();
  const custody = params.packets.map((packet) =>
    packet.historicalCustody
      ? readPersonalConversationContributionCustody({
          proof: packet.historicalCustody,
          reference: packet.receipt,
          target: params.branch,
        })
      : undefined,
  );
  const originalSources = composeSessionSourceAssertion([
    ...new Set(params.packets.map((packet) => packet.source)),
    ...new Set(custody.flatMap((held) => (held ? [held.source] : []))),
  ]);
  originalSources();
  if (!params.packets.length) {
    return { accepted: 0, appended: 0, deferred: false, packetIds: [] };
  }
  const writeTarget = { ...params.writeTarget };
  assertSessionEntryCohortScope(params.reader, writeTarget);
  if (
    writeTarget.agentId !== params.branch.agentId ||
    writeTarget.sessionKey !== params.branch.sessionKey ||
    writeTarget.sessionId !== params.branch.sessionId ||
    (writeTarget.expectedLifecycleRevision !== undefined &&
      writeTarget.expectedLifecycleRevision !== params.branch.lifecycleRevision)
  ) {
    throw new Error("Conversation knowledge packet writer differs from its recipient");
  }
  const reports = params.packets.map((packet) =>
    createConversationKnowledgePacketReport({ ...packet, branch: params.branch }),
  );
  const predicates = await params.reader.withRead(
    {
      sessionKeys: [
        ...new Set([
          params.branch.sessionKey,
          ...params.packets.map((packet) => packet.receipt.source.sessionKey),
        ]),
      ],
    },
    originalSources,
    (facts) => {
      const recipient = facts.entries.find(
        (row) => row.sessionKey === params.branch.sessionKey,
      )?.entry;
      if (
        recipient?.sessionId !== params.branch.sessionId ||
        recipient.lifecycleRevision !== params.branch.lifecycleRevision
      ) {
        throw new Error("Conversation knowledge packet source or recipient changed");
      }
      const selected = new Map<string, SessionSourcePredicate>();
      for (const [index, packet] of params.packets.entries()) {
        const donor = facts.entries.find(
          (row) => row.sessionKey === packet.receipt.source.sessionKey,
        )?.entry;
        if (
          donor?.sessionId !== packet.receipt.source.sessionId ||
          donor.lifecycleRevision !==
            (custody[index]?.lifecycleRevision ?? packet.receipt.source.lifecycleRevision)
        ) {
          throw new Error("Conversation knowledge packet source or recipient changed");
        }
        // One fresh cohort owns these identical donor/version predicates. Keep
        // every packet's donor check above and every distinct live grant owner.
        const key = JSON.stringify([
          packet.receipt.source.agentId,
          packet.receipt.source.sessionKey,
          donor.sessionId,
          donor.lifecycleRevision,
          packet.sourceVersion.generation,
          packet.sourceVersion.rawSeq,
          packet.sourceVersion.updatedAt,
        ]);
        if (!selected.has(key)) {
          selected.set(key, {
            source: facts.source,
            sessionKey: packet.receipt.source.sessionKey,
            fields: ["sessionId", "lifecycleRevision"],
            expected: donor,
            transcript: {
              sessionId: donor.sessionId,
              version: packet.sourceVersion,
              consistency: "prefix",
            },
          });
        }
      }
      return [...selected.values()];
    },
  );
  const source = composeSessionSourceAssertion([
    originalSources,
    Object.assign(() => originalSources(), {
      prepareSessionSource: async () => ({
        assertCurrent: originalSources,
        checks: predicates.map((predicate) => ({
          predicate,
          refuse: (): never => {
            throw new SessionTranscriptReadFenceError("Knowledge packet source anchor changed");
          },
        })),
      }),
    }),
  ]);
  const result = await appendSessionTranscriptReportBatch(
    {
      ...writeTarget,
      expectedLifecycleRevision: params.branch.lifecycleRevision,
    },
    reports.map((report) => ({
      report,
      receipt: { field: "packetId", value: report.details.packetId },
    })),
    {
      source,
      ...(params.contextLimits
        ? {
            contextAdmission: {
              limits: params.contextLimits,
              onDeferred: () => {},
            },
          }
        : {}),
    },
  );
  originalSources();
  params.signal?.throwIfAborted();
  if (!result.ok) {
    throw new Error("Conversation knowledge packet admission was refused", { cause: result.error });
  }
  return {
    ...result.value,
    packetIds: reports.slice(0, result.value.accepted).map((report) => report.details.packetId),
  };
}
