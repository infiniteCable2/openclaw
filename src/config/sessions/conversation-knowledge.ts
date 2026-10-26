import type { AgentMessage } from "@openclaw/agent-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  classifyToolUseResultPairing,
  isSyntheticMissingToolResult,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { normalizeInputProvenance } from "../../sessions/input-provenance.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import {
  readConversationKnowledgeRetirement,
  type ConversationKnowledgeRetirement,
} from "./conversation-knowledge-retirement.js";
import { readConversationObservationRole } from "./conversation-observation.js";
import type { CustomMessageReport } from "./session-accessor.sqlite-transcript-reports.types.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import { isReadableSessionMessage } from "./session-entry-codec.js";
import {
  readParticipantIdentity,
  type SessionParticipantIdentity,
} from "./session-participant-identity.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export const CONVERSATION_KNOWLEDGE_REPORT = "openclaw.conversation-knowledge.v1";
export const CONVERSATION_UTTERANCE_REPORT = "openclaw.conversation-utterance.v1";
export const CONVERSATION_KNOWLEDGE_LIMITS = Object.freeze({ maxBytes: 48_000, maxEvents: 96 });
export const CONVERSATION_KNOWLEDGE_SOURCE_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxEvents: 10_000,
});
const MAX_CONTEXT_CHARS = 12_000;
const MAX_SOURCE_CHARS = 4_000;

/** A root stores references, never a second copy of another audience's dialogue. */
type ConversationKnowledgeReferenceBase = {
  version: 1;
  /** Captured by the original admitted conversation, not inferred during later consumption. */
  sourceMode: "native" | "branches";
  origin: string;
  source: { agentId: string; sessionKey: string; sessionId: string; lifecycleRevision: string };
  through: TranscriptEntryAnchor;
  /** Native rewrite continuity for an unchanged range; never changes occurrence identity. */
  readRange?: { through: TranscriptEntryAnchor; admission?: TranscriptEntryAnchor };
  /** Not delivered: the final canonical source copy was intentionally pruned. */
  retirement?: ConversationKnowledgeRetirement;
  /** Evidence of an admitted private turn range, never authority to read it. */
  privateAudience?: {
    participant: Extract<SessionParticipantIdentity, { type: "profile" | "remote" }>;
    admission: TranscriptEntryAnchor;
  };
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
    (record.sourceMode !== "native" && record.sourceMode !== "branches") ||
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
    sourceMode: record.sourceMode,
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
  if (record.privateAudience !== undefined) {
    const audience = asOptionalRecord(record.privateAudience);
    const participant = asOptionalRecord(audience?.participant);
    const admission = asOptionalRecord(audience?.admission);
    if (
      !participant ||
      typeof participant.id !== "string" ||
      !admission ||
      admission.agentId !== through.agentId ||
      admission.sessionKey !== through.sessionKey ||
      admission.sessionId !== through.sessionId ||
      admission.storePath !== through.storePath ||
      admission.generation !== through.generation ||
      !exact(admission.entryId) ||
      !Number.isSafeInteger(admission.rawSeq) ||
      Number(admission.rawSeq) < 0 ||
      Number(admission.rawSeq) > receipt.through.rawSeq ||
      !Number.isSafeInteger(admission.activeMessagePosition) ||
      Number(admission.activeMessagePosition) < 0 ||
      (admission.effectiveParentId !== null && !exact(admission.effectiveParentId)) ||
      (admission.rawSeq === through.rawSeq && admission.entryId !== through.entryId)
    ) {
      return undefined;
    }
    const { id, ...namespace } = participant;
    let identity: SessionParticipantIdentity;
    try {
      identity = readParticipantIdentity(JSON.stringify(namespace), id);
    } catch {
      return undefined;
    }
    if (identity.type !== "profile" && identity.type !== "remote") {
      return undefined;
    }
    receipt.privateAudience = {
      participant: identity,
      admission: {
        agentId: receipt.source.agentId,
        sessionKey: receipt.source.sessionKey,
        sessionId: receipt.source.sessionId,
        storePath: receipt.through.storePath,
        generation: receipt.through.generation,
        entryId: admission.entryId,
        rawSeq: Number(admission.rawSeq),
        activeMessagePosition: Number(admission.activeMessagePosition),
        effectiveParentId: admission.effectiveParentId,
      },
    };
  }
  if (record.observed !== undefined) {
    if (!Array.isArray(record.observed)) {
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
  if (record.readRange !== undefined) {
    const range = asOptionalRecord(record.readRange);
    const renewedThrough = readRenewedKnowledgeAnchor(range?.through, receipt.through);
    const renewedAdmission = receipt.privateAudience
      ? readRenewedKnowledgeAnchor(range?.admission, receipt.privateAudience.admission)
      : undefined;
    if (
      !range ||
      !renewedThrough ||
      (receipt.privateAudience
        ? !renewedAdmission || renewedAdmission.generation !== renewedThrough.generation
        : range.admission !== undefined)
    ) {
      return undefined;
    }
    receipt.readRange = {
      through: renewedThrough,
      ...(renewedAdmission ? { admission: renewedAdmission } : {}),
    };
  }
  const retirement = readConversationKnowledgeRetirement(
    record.retirement,
    receipt.readRange?.through.generation ?? receipt.through.generation,
  );
  if (retirement) {
    receipt.retirement = retirement;
  }
  return receipt;
}

/** Continuity may renew a revision, never move or widen the originally admitted interval. */
function readRenewedKnowledgeAnchor(value: unknown, original: TranscriptEntryAnchor) {
  const anchor = asOptionalRecord(value);
  const fields = [
    "agentId",
    "sessionKey",
    "sessionId",
    "storePath",
    "entryId",
    "rawSeq",
    "effectiveParentId",
    "activeMessagePosition",
  ] as const;
  return anchor &&
    exact(anchor.generation) &&
    fields.every((field) => anchor[field] === original[field])
    ? { ...original, generation: anchor.generation }
    : undefined;
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

/** Compaction cannot turn a missing lower admission boundary into a read grant. */
function isWithinPrivateAudience(
  receipt: ConversationKnowledgeReference,
  events: readonly TranscriptEvent[],
  start: number,
) {
  if (!receipt.privateAudience) {
    return true;
  }
  const admission = receipt.privateAudience.admission;
  const admissionIndex = events.findIndex(
    (event) => asOptionalRecord(event)?.id === admission.entryId,
  );
  return admissionIndex >= 0 && start >= admissionIndex;
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
  // Collected/steered inputs can precede the first assistant occurrence. Keep
  // that contiguous input batch, not just its last message. A previous assistant
  // or tool result is a separate exchange, never implicit completed coverage.
  let userStart = -1;
  for (let index = ownedStart - 1; index >= 0; index -= 1) {
    const role = asOptionalRecord(asOptionalRecord(events[index])?.message)?.role;
    if (userStart >= 0 && (role === "assistant" || role === "toolResult")) {
      break;
    }
    if (role === "user") {
      userStart = index;
    }
  }
  if (userStart < 0 || !isWithinPrivateAudience(receipt, events, userStart)) {
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

/** Only the exact committed original occurrence is data; adjacent tool work is never implied. */
export function isConversationUtteranceObservation(
  receipt: ConversationUtteranceObservation,
  events: readonly TranscriptEvent[],
) {
  const index = events.findIndex(
    (candidate) => asOptionalRecord(candidate)?.id === receipt.through.entryId,
  );
  return (
    committedConversationRole(asOptionalRecord(events[index])) === receipt.role &&
    isWithinPrivateAudience(receipt, events, index)
  );
}

function committedConversationRole(event: Record<string, unknown> | undefined) {
  return event?.type === "message" ? readConversationObservationRole(event.message) : undefined;
}

/** A completed observed frontier covers only comparable endpoints of its original source. */
export function isConversationKnowledgeReferenceObserved(
  receipt: ConversationKnowledgeReference,
  frontier: ConversationKnowledgeFrontier | undefined,
): boolean {
  return (
    frontier !== undefined &&
    frontier.origin === receipt.origin &&
    frontier.generation === receipt.through.generation &&
    frontier.throughRawSeq >= receipt.through.rawSeq
  );
}

export function projectConversationKnowledge(
  receipt: ConversationKnowledgeReference,
  events: readonly TranscriptEvent[],
  frontier?: ConversationKnowledgeFrontier,
  sourceAudience: "private-direct" | "shared" | "unknown" = "unknown",
  options: { maxChars?: number; offset?: number } = {},
) {
  if (isConversationKnowledgeReferenceObserved(receipt, frontier)) {
    return undefined;
  }
  const utterance = "kind" in receipt;
  const start = utterance
    ? isConversationUtteranceObservation(receipt, events)
      ? events.findIndex((event) => asOptionalRecord(event)?.id === receipt.through.entryId)
      : undefined
    : completedConversationKnowledgeStart(receipt, events);
  if (start === undefined) {
    return undefined;
  }
  const rows: Array<{ speaker: "user" | "assistant"; text: string; routedInput: boolean }> = [];
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
    if (utterance && !committedConversationRole(record)) {
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
      const text = messageText(message);
      if (text.trim() && sawUser) {
        const provenance = normalizeInputProvenance(message.provenance);
        rows.push({
          speaker: message.role,
          text,
          routedInput:
            message.role === "user" &&
            provenance !== undefined &&
            provenance.kind !== "external_user",
        });
      }
    }
    if (record.id === receipt.through.entryId) {
      break;
    }
  }
  if (!sawUser) {
    return undefined;
  }
  const omittedPrefix =
    !utterance &&
    events.slice(previous + 1, start).some((event) => {
      const message = asOptionalRecord(asOptionalRecord(event)?.message);
      return (
        message &&
        (message.role === "user" || message.role === "assistant") &&
        messageText(message).trim()
      );
    });
  const totalChars = rows.reduce((total, row) => total + row.text.length, 0);
  const offset = options.offset ?? 0;
  const maxChars = options.maxChars ?? MAX_SOURCE_CHARS;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > totalChars ||
    !Number.isSafeInteger(maxChars) ||
    maxChars < 1
  ) {
    return undefined;
  }
  // Packet cuts always land between Unicode characters. JSON escapes an isolated
  // surrogate, which would otherwise also make size search non-monotonic.
  const safeEnd = (end: number) => {
    let position = 0;
    for (const row of rows) {
      const localEnd = end - position;
      if (localEnd > 0 && localEnd < row.text.length) {
        const before = row.text.charCodeAt(localEnd - 1);
        const after = row.text.charCodeAt(localEnd);
        return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
          ? end - 1
          : end;
      }
      position += row.text.length;
    }
    return end;
  };
  if (safeEnd(offset) !== offset) {
    return undefined;
  }
  // Existing packet offsets include routed user-role carriers. Keep those
  // coordinates stable, but never republish their payload as fresh dialogue.
  const skipRoutedInputs = (requestedEnd: number) => {
    let end = requestedEnd;
    let position = 0;
    for (const row of rows) {
      const rowStart = position;
      position += row.text.length;
      if (row.routedInput && end >= rowStart && end < position) {
        end = position;
      }
    }
    return end;
  };
  const render = (requestedEnd: number) => {
    const end = safeEnd(requestedEnd);
    let position = 0;
    const observations = rows.flatMap((row) => {
      const rowStart = position;
      position += row.text.length;
      const text = row.text.slice(
        Math.max(0, offset - rowStart),
        Math.min(row.text.length, end - rowStart),
      );
      return !row.routedInput && position > offset && rowStart < end && text
        ? [{ speaker: row.speaker, text }]
        : [];
    });
    // Each packet remains quoted data. Only its exact consumed offset advances;
    // a source frontier is issued after the complete contribution is included.
    return JSON.stringify({
      source: receipt.origin,
      sourceMode: receipt.sourceMode,
      sourceAudience,
      speakerIdentity: "not-attributed-to-the-current-user",
      sourceSessionKey: receipt.source.sessionKey,
      throughEntryId: receipt.through.entryId,
      ...(utterance
        ? { kind: receipt.kind, taskCompletion: "not-implied" }
        : { completedRun: receipt.runId }),
      frontierRebased,
      contentTruncated: omittedPrefix || end < totalChars,
      contentOffset: offset,
      contentComplete: end === totalChars,
      ...(rows.some((row) => row.routedInput) ? { routedInputsOmitted: true } : {}),
      observations,
    });
  };
  let end = safeEnd(skipRoutedInputs(Math.min(totalChars, skipRoutedInputs(offset) + maxChars)));
  let text = render(end);
  if (text.length > maxChars) {
    let low = offset;
    let high = end;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (render(middle).length <= maxChars) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    end = safeEnd(skipRoutedInputs(low));
    text = render(end);
  }
  if (text.length > maxChars || (end === offset && offset < totalChars)) {
    return undefined;
  }
  const complete = end === totalChars;
  return {
    origin: receipt.origin,
    text,
    complete,
    nextOffset: complete ? undefined : end,
    frontier: complete
      ? {
          origin: receipt.origin,
          generation: receipt.through.generation,
          throughRawSeq: receipt.through.rawSeq,
          throughEntryId: receipt.through.entryId,
        }
      : undefined,
  };
}

export function combineConversationKnowledge(
  parts: readonly { text: string; frontier?: ConversationKnowledgeFrontier; complete?: boolean }[],
) {
  const selected: (typeof parts)[number][] = [];
  let chars = 0;
  for (const part of parts) {
    const added = part.text.length + (selected.length ? 1 : 0);
    if (chars + added > MAX_CONTEXT_CHARS) {
      break;
    }
    selected.push(part);
    chars += added;
  }
  return {
    text: selected.map((part) => part.text).join("\n"),
    includedCount: selected.length,
    frontiers: [
      ...new Map(
        selected.flatMap((part) =>
          part.frontier ? [[part.frontier.origin, part.frontier] as const] : [],
        ),
      ).values(),
    ],
    pending: selected.length < parts.length || selected.some((part) => part.complete === false),
  };
}
