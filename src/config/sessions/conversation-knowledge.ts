import type { AgentMessage } from "@openclaw/agent-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  classifyToolUseResultPairing,
  isSyntheticMissingToolResult,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import type { CustomMessageReport } from "./session-accessor.sqlite-transcript-reports.types.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import { isReadableSessionMessage } from "./session-entry-codec.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export const CONVERSATION_KNOWLEDGE_REPORT = "openclaw.conversation-knowledge.v1";
export const CONVERSATION_UTTERANCE_REPORT = "openclaw.conversation-utterance.v1";
export const CONVERSATION_KNOWLEDGE_LIMITS = Object.freeze({ maxBytes: 48_000, maxEvents: 96 });
const MAX_CONTEXT_CHARS = 12_000;
const MAX_SOURCE_CHARS = 4_000;
const MAX_SOURCES = 4;

/** A root stores references, never a second copy of another audience's dialogue. */
type ConversationKnowledgeReferenceBase = {
  version: 1;
  origin: string;
  source: { agentId: string; sessionKey: string; sessionId: string; lifecycleRevision: string };
  through: TranscriptEntryAnchor;
  observed?: ConversationKnowledgeFrontier[];
};

export type ConversationKnowledgeReceipt = ConversationKnowledgeReferenceBase & { runId: string };
/** A committed utterance is observed dialogue, not proof that a model/tool turn completed. */
export type ConversationUtteranceObservation = ConversationKnowledgeReferenceBase & {
  kind: "utterance-observation";
  role: "user" | "assistant";
};
export type ConversationKnowledgeReference =
  | ConversationKnowledgeReceipt
  | ConversationUtteranceObservation;

export type ConversationKnowledgeFrontier = {
  origin: string;
  generation: string;
  throughRawSeq: number;
  throughEntryId: string;
};

function exact(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

export function conversationKnowledgeOrigin(
  source: ConversationKnowledgeReceipt["source"],
  kind?: "utterance-observation",
): string {
  return sha256Hex(
    JSON.stringify([
      source.agentId,
      source.sessionKey,
      source.sessionId,
      source.lifecycleRevision,
      ...(kind ? [kind] : []),
    ]),
  );
}

function readConversationKnowledgeReferenceBase(
  value: unknown,
): ConversationKnowledgeReferenceBase | undefined {
  const record = asOptionalRecord(value);
  const source = asOptionalRecord(record?.source);
  const through = asOptionalRecord(record?.through);
  if (
    record?.version !== 1 ||
    !exact(record.origin) ||
    !source ||
    !through ||
    !exact(source.agentId) ||
    !exact(source.sessionKey) ||
    !exact(source.sessionId) ||
    !exact(source.lifecycleRevision) ||
    through.agentId !== source.agentId ||
    through.sessionKey !== source.sessionKey ||
    through.sessionId !== source.sessionId ||
    !exact(through.storePath) ||
    !exact(through.generation) ||
    !exact(through.entryId) ||
    !Number.isSafeInteger(through.rawSeq) ||
    Number(through.rawSeq) < 0 ||
    !Number.isSafeInteger(through.activeMessagePosition) ||
    Number(through.activeMessagePosition) < 0 ||
    (through.effectiveParentId !== null && !exact(through.effectiveParentId))
  ) {
    return undefined;
  }
  const receipt: ConversationKnowledgeReferenceBase = {
    version: 1,
    origin: record.origin,
    source: {
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      sessionId: source.sessionId,
      lifecycleRevision: source.lifecycleRevision,
    },
    through: {
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      sessionId: source.sessionId,
      storePath: through.storePath,
      generation: through.generation,
      entryId: through.entryId,
      rawSeq: Number(through.rawSeq),
      activeMessagePosition: Number(through.activeMessagePosition),
      effectiveParentId: through.effectiveParentId,
    },
  };
  if (record.observed !== undefined) {
    if (!Array.isArray(record.observed) || record.observed.length > MAX_SOURCES) {
      return undefined;
    }
    receipt.observed = [];
    for (const observation of record.observed) {
      const frontier = asOptionalRecord(observation);
      if (
        !frontier ||
        !exact(frontier.origin) ||
        !exact(frontier.generation) ||
        !exact(frontier.throughEntryId) ||
        !Number.isSafeInteger(frontier.throughRawSeq) ||
        Number(frontier.throughRawSeq) < 0
      ) {
        return undefined;
      }
      receipt.observed.push({
        origin: frontier.origin,
        generation: frontier.generation,
        throughRawSeq: Number(frontier.throughRawSeq),
        throughEntryId: frontier.throughEntryId,
      });
    }
  }
  return receipt;
}

export function readConversationKnowledgeReceipt(
  value: unknown,
): ConversationKnowledgeReceipt | undefined {
  const record = asOptionalRecord(value);
  const base = readConversationKnowledgeReferenceBase(value);
  return base &&
    record &&
    record.kind === undefined &&
    exact(record.runId) &&
    base.origin === conversationKnowledgeOrigin(base.source)
    ? { ...base, runId: record.runId }
    : undefined;
}

export function readConversationUtteranceObservation(
  value: unknown,
): ConversationUtteranceObservation | undefined {
  const record = asOptionalRecord(value);
  const base = readConversationKnowledgeReferenceBase(value);
  return base &&
    record?.kind === "utterance-observation" &&
    record.runId === undefined &&
    (record.role === "user" || record.role === "assistant") &&
    base.origin === conversationKnowledgeOrigin(base.source, "utterance-observation")
    ? { ...base, kind: "utterance-observation", role: record.role }
    : undefined;
}

/** The native report owner reselects this receipt atomically against the current root path. */
export function selectConversationKnowledgeReport(
  receipt: ConversationKnowledgeReference,
  latest: CustomMessageReport | undefined,
) {
  const utterance = "kind" in receipt;
  const previous = utterance
    ? readConversationUtteranceObservation(latest?.details)
    : readConversationKnowledgeReceipt(latest?.details);
  if (
    previous &&
    previous.origin === receipt.origin &&
    previous.through.generation === receipt.through.generation &&
    previous.through.rawSeq >= receipt.through.rawSeq
  ) {
    return undefined;
  }
  return {
    customType: utterance ? CONVERSATION_UTTERANCE_REPORT : CONVERSATION_KNOWLEDGE_REPORT,
    content: `${utterance ? "Committed utterance observation" : "Completed conversation"} reference. Readable source content requires its original current permission.`,
    display: false,
    details: receipt,
  };
}

/** Bounded active root history supplies only each source incarnation's newest reference. */
export function selectConversationKnowledgeReceipts(
  events: readonly TranscriptEvent[],
  currentSessionId: string,
  currentSessionKey?: string,
) {
  const selected = new Map<string, ConversationKnowledgeReference>();
  const incarnationByKey = new Map<string, string>();
  for (const event of events) {
    const record = asOptionalRecord(event);
    if (record?.type !== "custom_message") {
      continue;
    }
    const receipt =
      record.customType === CONVERSATION_KNOWLEDGE_REPORT
        ? readConversationKnowledgeReceipt(record.details)
        : record.customType === CONVERSATION_UTTERANCE_REPORT
          ? readConversationUtteranceObservation(record.details)
          : undefined;
    if (
      !receipt ||
      receipt.source.sessionId === currentSessionId ||
      receipt.source.sessionKey === currentSessionKey
    ) {
      continue;
    }
    const sourceKey = JSON.stringify([receipt.source.agentId, receipt.source.sessionKey]);
    const incarnation = conversationKnowledgeOrigin(receipt.source);
    const oldOrigin = incarnationByKey.get(sourceKey);
    if (oldOrigin && oldOrigin !== incarnation) {
      for (const [origin, previous] of selected) {
        if (
          previous.source.agentId === receipt.source.agentId &&
          previous.source.sessionKey === receipt.source.sessionKey
        ) {
          selected.delete(origin);
        }
      }
    }
    incarnationByKey.set(sourceKey, incarnation);
    const previous = selected.get(receipt.origin);
    if (
      !previous ||
      previous.through.generation !== receipt.through.generation ||
      previous.through.rawSeq < receipt.through.rawSeq
    ) {
      // Reports are admitted against their current native transcript generation.
      // A replacement generation cannot be ordered using the old generation's sequence.
      selected.delete(receipt.origin);
      selected.set(receipt.origin, receipt);
    }
  }
  return [...selected.values()].slice(-MAX_SOURCES);
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .flatMap((value) => {
      const block = asOptionalRecord(value);
      return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n");
}

/** Never turn unfinished tool work, native runtime carriers, or directives into new input. */
function completedConversationKnowledgeStart(
  receipt: ConversationKnowledgeReceipt,
  events: readonly TranscriptEvent[],
) {
  const terminalIndex = events.findIndex(
    (event) => asOptionalRecord(event)?.id === receipt.through.entryId,
  );
  const terminal = events[terminalIndex];
  const final = asOptionalRecord(asOptionalRecord(terminal)?.message);
  if (
    !final ||
    final.role !== "assistant" ||
    readSessionTranscriptRunId(final) !== receipt.runId ||
    final.stopReason !== "stop"
  ) {
    return undefined;
  }
  const ownedStart = events.findIndex(
    (event, index) =>
      index <= terminalIndex &&
      asOptionalRecord(asOptionalRecord(event)?.message)?.role === "assistant" &&
      readSessionTranscriptRunId(asOptionalRecord(event)?.message) === receipt.runId,
  );
  const userStart = events.findLastIndex(
    (event, index) =>
      index < ownedStart && asOptionalRecord(asOptionalRecord(event)?.message)?.role === "user",
  );
  if (userStart < 0) {
    return undefined;
  }
  const messages: AgentMessage[] = [];
  let sawUser = false;
  for (const event of events.slice(userStart, terminalIndex + 1)) {
    const record = asOptionalRecord(event);
    const message = asOptionalRecord(record?.message);
    if (record?.type !== "message" || !message || !isReadableSessionMessage(message)) {
      continue;
    }
    if (message.role === "user") {
      sawUser = true;
    }
    messages.push(message);
    if (record.id === receipt.through.entryId) {
      const pairing = classifyToolUseResultPairing(messages);
      const complete =
        sawUser &&
        pairing.droppedOrphanCount === 0 &&
        pairing.droppedDuplicateCount === 0 &&
        pairing.frames.every(
          (frame) =>
            !frame.failed &&
            frame.occurrences.every(
              (occurrence) =>
                occurrence.sourceResult && !isSyntheticMissingToolResult(occurrence.sourceResult),
            ),
        );
      return complete ? userStart : undefined;
    }
  }
  return undefined;
}

export function isCompletedConversationKnowledge(
  receipt: ConversationKnowledgeReceipt,
  events: readonly TranscriptEvent[],
) {
  return completedConversationKnowledgeStart(receipt, events) !== undefined;
}

/** Only the exact committed realtime utterance is data; adjacent tool work is never implied. */
export function isConversationUtteranceObservation(
  receipt: ConversationUtteranceObservation,
  events: readonly TranscriptEvent[],
) {
  const event = asOptionalRecord(
    events.find((candidate) => asOptionalRecord(candidate)?.id === receipt.through.entryId),
  );
  return committedVoiceRole(event) === receipt.role;
}

function committedVoiceRole(event: Record<string, unknown> | undefined) {
  const message = asOptionalRecord(event?.message);
  const provenance = asOptionalRecord(message?.provenance);
  const role = message?.role;
  return event?.type === "message" &&
    message &&
    (role === "user" || role === "assistant") &&
    provenance?.kind === "realtime_voice" &&
    provenance.sourceChannel === "talk" &&
    (role !== "assistant" || (message.api === "realtime" && message.stopReason === "stop")) &&
    !readSessionTranscriptRunId(message) &&
    (!Array.isArray(message.content) ||
      message.content.every((block) => asOptionalRecord(block)?.type === "text"))
    ? role
    : undefined;
}

export function projectConversationKnowledge(
  receipt: ConversationKnowledgeReference,
  events: readonly TranscriptEvent[],
  frontier?: ConversationKnowledgeFrontier,
  sourceAudience: "private-direct" | "shared" | "unknown" = "unknown",
) {
  if (
    frontier &&
    frontier.origin === receipt.origin &&
    frontier.generation === receipt.through.generation &&
    frontier.throughRawSeq >= receipt.through.rawSeq
  ) {
    return undefined;
  }
  const utterance = "kind" in receipt;
  const start = utterance
    ? isConversationUtteranceObservation(receipt, events)
      ? 0
      : undefined
    : completedConversationKnowledgeStart(receipt, events);
  if (start === undefined) {
    return undefined;
  }
  const rows: Array<{ speaker: "user" | "assistant"; text: string }> = [];
  const previous =
    frontier?.origin === receipt.origin && frontier.generation === receipt.through.generation
      ? events.findIndex((event) => asOptionalRecord(event)?.id === frontier.throughEntryId)
      : -1;
  const frontierRebased =
    frontier?.origin === receipt.origin && frontier.generation !== receipt.through.generation;
  // Compaction or bounded truncation can remove a prior frontier. Never invent an offset.
  // A separately admitted new generation gets an explicit bounded rebase, not an old offset.
  if (frontier && !frontierRebased && previous < 0) {
    return undefined;
  }
  // The terminal receipt validates only its own completed exchange, not an earlier
  // interrupted run between frontiers. Omit that older prefix rather than replay it.
  const selectedStart = Math.max(start, previous + 1);
  let sawUser = utterance;
  for (const event of events.slice(selectedStart)) {
    const record = asOptionalRecord(event);
    const message = asOptionalRecord(record?.message);
    if (record?.type !== "message" || !message) {
      continue;
    }
    if (utterance && !committedVoiceRole(record)) {
      continue;
    }
    if (message.role === "user") {
      sawUser = true;
    }
    if (
      (message.role === "user" || message.role === "assistant") &&
      (utterance ||
        message.role === "user" ||
        readSessionTranscriptRunId(message) === receipt.runId)
    ) {
      const text = messageText(message).trim();
      if (text && sawUser) {
        rows.push({ speaker: message.role, text });
      }
    }
    if (record.id === receipt.through.entryId) {
      break;
    }
  }
  if (!sawUser) {
    return undefined;
  }
  const observations = rows.slice(-4).map((row) => ({
    speaker: row.speaker,
    text: row.text.slice(0, 450),
  }));
  const truncated =
    (!utterance &&
      events.slice(previous + 1, start).some((event) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return (
          message &&
          (message.role === "user" || message.role === "assistant") &&
          messageText(message).trim()
        );
      })) ||
    rows.length !== observations.length ||
    observations.some((row, index) => row.text !== rows.slice(-4)[index]?.text);
  // Bounded completed exchanges are quoted knowledge, not a replayable conversation or task.
  const text = JSON.stringify({
    source: receipt.origin,
    sourceAudience,
    speakerIdentity: "not-attributed-to-the-current-user",
    sourceSessionKey: receipt.source.sessionKey,
    throughEntryId: receipt.through.entryId,
    ...(utterance
      ? { kind: receipt.kind, taskCompletion: "not-implied" }
      : { completedRun: receipt.runId }),
    frontierRebased,
    contentTruncated: truncated,
    observations,
  });
  if (text.length > MAX_SOURCE_CHARS) {
    return undefined;
  }
  return {
    text,
    frontier: {
      origin: receipt.origin,
      generation: receipt.through.generation,
      throughRawSeq: receipt.through.rawSeq,
      throughEntryId: receipt.through.entryId,
    },
  };
}

export function combineConversationKnowledge(
  parts: readonly { text: string; frontier: ConversationKnowledgeFrontier }[],
) {
  const selected: (typeof parts)[number][] = [];
  let chars = 0;
  for (const part of parts) {
    if (chars + part.text.length > MAX_CONTEXT_CHARS) {
      break;
    }
    selected.push(part);
    chars += part.text.length;
  }
  return {
    text: selected.map((part) => part.text).join("\n"),
    frontiers: selected.map((part) => part.frontier),
  };
}
