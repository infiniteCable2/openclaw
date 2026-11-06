import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import type { ConversationKnowledgeReference } from "../../config/sessions/conversation-knowledge.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("auto-reply/conversation-knowledge");
const reportedOutcomes = new Map<string, string>();
const MAX_REPORTED_OUTCOMES = 256;

function failureCause(failure: unknown) {
  if (failure === undefined) {
    return undefined;
  }
  if (failure instanceof Error) {
    switch (failure.name) {
      case "SessionMutationFactsUnavailableError":
        return "session-facts-unavailable";
      case "SessionEntryChangedDuringReadError":
        return "session-entry-changed-during-read";
      case "SessionTranscriptReadFenceError":
        return "source-range-unverified";
      case "SessionMutationAuthorizationChangedError":
        return "authority-changed";
      case "AbortError":
        return "cancelled";
    }
  }
  return "native-outcome-unavailable";
}

type OutcomeFields = Record<string, unknown> & {
  outcome: "prepared" | "admitted" | "deferred";
  recipientHash: string;
  sourceHash?: string;
  sourceChunk?: number;
};

/** Bounded diagnostic memory only; it never records or decides transfer progress. */
function operationalOutcome(fields: OutcomeFields, repeat = false) {
  if (!log.isEnabled("info")) {
    return;
  }
  const signature = JSON.stringify(fields);
  const recipient = fields.recipientHash;
  const scope =
    fields.sourceHash !== undefined
      ? `source:${fields.sourceHash}`
      : fields.sourceChunk !== undefined
        ? `chunk:${fields.sourceChunk}`
        : "all";
  const key = `${recipient}|${fields.outcome}|${scope}`;
  if (!repeat && reportedOutcomes.get(key) === signature) {
    return;
  }
  if (fields.outcome === "admitted") {
    for (const previous of reportedOutcomes.keys()) {
      if (
        previous.startsWith(`${recipient}|prepared|`) ||
        previous.startsWith(`${recipient}|deferred|`)
      ) {
        reportedOutcomes.delete(previous);
      }
    }
  }
  reportedOutcomes.delete(key);
  reportedOutcomes.set(key, signature);
  if (reportedOutcomes.size > MAX_REPORTED_OUTCOMES) {
    const oldest = reportedOutcomes.keys().next().value;
    if (oldest !== undefined) {
      reportedOutcomes.delete(oldest);
    }
  }
  log.info("Conversation knowledge transfer outcome", fields);
}

/** Every observed source is included; each individual record remains bounded. */
function sourceOutcomes(
  fields: OutcomeFields,
  sources: readonly Record<string, unknown>[],
  repeat = false,
) {
  if (!log.isEnabled("info")) {
    return;
  }
  const chunks = Math.max(1, Math.ceil(sources.length / 3));
  const prefix = `${fields.recipientHash}|${fields.outcome}|chunk:`;
  for (const previous of reportedOutcomes.keys()) {
    if (previous.startsWith(prefix) && Number(previous.slice(prefix.length)) > chunks) {
      reportedOutcomes.delete(previous);
    }
  }
  for (let index = 0; index < chunks; index++) {
    operationalOutcome(
      {
        ...fields,
        sourceChunk: index + 1,
        sourceChunks: chunks,
        sources: sources.slice(index * 3, (index + 1) * 3),
      },
      repeat,
    );
  }
}

/** An acknowledged native batch can contain both new appends and existing receipts. */
export function logConversationKnowledgeAdmission(params: {
  recipient: string;
  packets: readonly {
    receipt: ConversationKnowledgeReference;
    offset: number;
    complete: boolean;
  }[];
  appended: number;
}) {
  if (!params.packets.length || !log.isEnabled("info")) {
    return;
  }
  const sources = new Map<
    string,
    {
      packets: number;
      completePackets: number;
      throughSeq: number;
      firstOffset: number;
      lastOffset: number;
    }
  >();
  for (const { receipt, offset, complete } of params.packets) {
    const id = receipt.source.sessionId;
    const previous = sources.get(id);
    sources.set(id, {
      packets: (previous?.packets ?? 0) + 1,
      completePackets: (previous?.completePackets ?? 0) + Number(complete),
      throughSeq: Math.max(previous?.throughSeq ?? 0, receipt.through.rawSeq),
      firstOffset: Math.min(previous?.firstOffset ?? offset, offset),
      lastOffset: Math.max(previous?.lastOffset ?? offset, offset),
    });
  }
  sourceOutcomes(
    {
      outcome: "admitted",
      cause: params.appended ? "native-transcript-commit" : "existing-native-receipt",
      recipientHash: redactIdentifier(params.recipient),
      packets: params.packets.length,
      appendedPackets: params.appended,
      reusedPackets: params.packets.length - params.appended,
      sourceCount: sources.size,
    },
    [...sources].map(([id, counts]) => Object.assign({ sourceHash: redactIdentifier(id) }, counts)),
    params.appended > 0,
  );
}

/** A summary has one native receipt; its contents and original donors stay private. */
export function logConversationKnowledgeCheckpointAdmission(params: {
  recipient: string;
  root: string;
  checkpointId: string;
  appended: boolean;
  coveredRanges: number;
}) {
  if (!log.isEnabled("info")) {
    return;
  }
  operationalOutcome(
    {
      outcome: "admitted",
      cause: params.appended ? "native-checkpoint-commit" : "existing-native-checkpoint",
      recipientHash: redactIdentifier(params.recipient),
      sourceHash: redactIdentifier(params.root),
      checkpointHash: redactIdentifier(params.checkpointId),
      checkpoints: 1,
      appendedCheckpoints: Number(params.appended),
      coveredRanges: params.coveredRanges,
    },
    params.appended,
  );
}

/** Observe successful staging under native custody, not durable admission or model use. */
export function logConversationKnowledgePreparedRanges(params: {
  recipient: string;
  ranges: readonly { receipt: ConversationKnowledgeReference; offset: number; complete: boolean }[];
}) {
  if (!params.ranges.length || !log.isEnabled("info")) {
    return;
  }
  const sources = new Map<string, { ranges: number; completeRanges: number; throughSeq: number }>();
  for (const { receipt, complete } of params.ranges) {
    const previous = sources.get(receipt.source.sessionId);
    sources.set(receipt.source.sessionId, {
      ranges: (previous?.ranges ?? 0) + 1,
      completeRanges: (previous?.completeRanges ?? 0) + Number(complete),
      throughSeq: Math.max(previous?.throughSeq ?? 0, receipt.through.rawSeq),
    });
  }
  sourceOutcomes(
    {
      outcome: "prepared",
      cause: "native-source-preparation",
      recipientHash: redactIdentifier(params.recipient),
      ranges: params.ranges.length,
      sourceCount: sources.size,
    },
    [...sources].map(([id, counts]) => Object.assign({ sourceHash: redactIdentifier(id) }, counts)),
  );
}

export type ConversationKnowledgeIdleDeferralReason =
  | "missing-budget"
  | "config-version"
  | "no-prepared"
  | "busy"
  | "context-engine"
  | "model"
  | "harness"
  | "context-window"
  | "context-unavailable"
  | "capacity"
  | "no-progress";

/** Observe the existing idle decision without publishing status into model history. */
export function logConversationKnowledgeIdleDeferral(params: {
  recipient: string;
  reason: ConversationKnowledgeIdleDeferralReason;
  preparedPackets: number;
  checkpoint: boolean;
  consumptionChanges?: number;
  capacityChecks?: number;
  capacityRefusals?: number;
}) {
  if (!params.preparedPackets && !params.checkpoint) {
    return;
  }
  operationalOutcome({
    outcome: "deferred",
    cause: params.reason,
    recipientHash: redactIdentifier(params.recipient),
    preparedPackets: params.preparedPackets,
    checkpoint: params.checkpoint,
    consumptionChanges: params.consumptionChanges ?? 0,
    capacityChecks: params.capacityChecks ?? 0,
    capacityRefusals: params.capacityRefusals ?? 0,
  });
  if (!log.isEnabled("debug")) {
    return;
  }
  log.debug("Conversation knowledge idle admission deferred", {
    recipientHash: redactIdentifier(params.recipient),
    reason: params.reason,
    preparedPackets: params.preparedPackets,
    checkpoint: params.checkpoint,
    consumptionChanges: params.consumptionChanges ?? 0,
    capacityChecks: params.capacityChecks ?? 0,
    capacityRefusals: params.capacityRefusals ?? 0,
  });
}

/** Correlate disposable readiness with native admission without recording dialogue. */
export function logConversationKnowledgeTransfer(params: {
  phase: "prepared" | "admitted";
  recipient: string;
  receipt: ConversationKnowledgeReference;
  offset: number;
  complete: boolean;
}) {
  if (!log.isEnabled("debug")) {
    return;
  }
  log.debug("Conversation knowledge transfer", {
    phase: params.phase,
    recipientHash: redactIdentifier(params.recipient),
    sourceHash: redactIdentifier(params.receipt.source.sessionId),
    contributionHash: redactIdentifier(conversationKnowledgeContributionId(params.receipt)),
    throughSeq: params.receipt.through.rawSeq,
    offset: params.offset,
    complete: params.complete,
  });
}

/** The fresh native read proves reuse; observe it without another append transaction. */
export function logConversationKnowledgeReusedAdmission(
  params: Omit<Parameters<typeof logConversationKnowledgeTransfer>[0], "phase">,
) {
  logConversationKnowledgeAdmission({
    recipient: params.recipient,
    packets: [params],
    appended: 0,
  });
  logConversationKnowledgeTransfer({ ...params, phase: "admitted" });
}

export type ConversationKnowledgeGap = {
  sourceSessionId: string;
  throughEntryId: string;
  reason:
    | "source-access-unavailable"
    | "source-range-unverified"
    | "source-range-over-capacity"
    | "admission-deferred";
};

/** Keep source-specific diagnostics separate from knowledge admission and its authority. */
export function createConversationKnowledgeGapCollector() {
  const gaps: ConversationKnowledgeGap[] = [];
  return {
    gaps,
    gap: (
      receipt: { source: { sessionId: string }; through: { entryId: string } },
      reason: ConversationKnowledgeGap["reason"],
    ) => {
      gaps.push({
        sourceSessionId: receipt.source.sessionId,
        throughEntryId: receipt.through.entryId,
        reason,
      });
    },
  };
}

/** Operational diagnostics only: never append status to a transcript or model context. */
export function logConversationKnowledgeDiagnostic(params: {
  recipient: string;
  gaps?: readonly ConversationKnowledgeGap[];
  pending?: "context-window" | "maintenance-deferred" | "snapshot-capacity";
  failure?: unknown;
  reason?:
    | "initial-history-not-yet-verified"
    | "preparation-deferred"
    | "original-participant-unconfirmed"
    | "private-destination-audience-unconfirmed";
}) {
  const gaps = params.gaps ?? [];
  if (
    (!gaps.length && !params.pending && !params.reason && params.failure === undefined) ||
    (!log.isEnabled("debug") && !log.isEnabled("info"))
  ) {
    return;
  }
  const groups = new Map<string, ConversationKnowledgeGap & { ranges: number }>();
  for (const gap of gaps) {
    const key = JSON.stringify([gap.sourceSessionId, gap.reason]);
    const previous = groups.get(key);
    groups.set(key, { ...gap, ranges: (previous?.ranges ?? 0) + 1 });
  }
  const sources = [...groups.values()].map((gap) => ({
    sourceHash: redactIdentifier(gap.sourceSessionId),
    cause: gap.reason,
    ranges: gap.ranges,
  }));
  sourceOutcomes(
    {
      outcome: "deferred",
      cause: failureCause(params.failure) ?? params.reason ?? params.pending ?? "source-gaps",
      recipientHash: redactIdentifier(params.recipient),
      unresolvedRanges: gaps.length,
      sourceCauseGroups: groups.size,
    },
    sources,
  );
  if (!log.isEnabled("debug")) {
    return;
  }
  log.debug("Supplementary conversation catch-up deferred", {
    recipientHash: redactIdentifier(params.recipient),
    unresolvedRanges: gaps.length,
    gaps: [...groups.values()].slice(0, 3).map((gap) => ({
      sourceHash: redactIdentifier(gap.sourceSessionId),
      endpointHash: redactIdentifier(gap.throughEntryId),
      reason: gap.reason,
      ranges: gap.ranges,
    })),
    ...(groups.size > 3 ? { additionalGapGroups: groups.size - 3 } : {}),
    ...(params.pending ? { pending: params.pending } : {}),
    ...(params.reason ? { reason: params.reason } : {}),
  });
}
