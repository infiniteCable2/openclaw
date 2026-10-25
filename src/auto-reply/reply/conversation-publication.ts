import type { PreparedAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeFrontier } from "../../config/sessions/conversation-knowledge.js";
import { startConversationKnowledgePublication } from "../../config/sessions/conversation-publication-reconcile.js";
import { openConversationPublicationStore } from "../../config/sessions/conversation-publication.js";
import type { ConversationPublicationIntent } from "../../config/sessions/conversation-publication.types.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { drainAgentRunTerminalWrites } from "../../infra/agent-run-terminal-writes.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AgentTurnInternalResult, AgentTurnParams } from "./agent-runner-execution.types.js";

const log = createSubsystemLogger("sessions/conversation-publication");
const knowledgeLog = createSubsystemLogger("auto-reply/conversation-knowledge");

/** Audio has settled; accept only the original successful terminal after its writes drain. */
export async function recordReplyConversationPublication(params: {
  result: AgentTurnInternalResult;
  execution?: { admission: PreparedAgentRunAdmission; signal: AbortSignal };
  enabled: boolean;
  seedPending: boolean;
  branch?: ConversationKnowledgeBranch;
  sessionId: string;
  getEnvironment(): NodeJS.ProcessEnv | undefined;
  assertCurrent: SessionSourceAssertion;
}): Promise<void> {
  const { result, execution, branch } = params;
  if (!execution) {
    throw new Error("Conversation knowledge execution was not prepared");
  }
  const { admission, signal } = execution;
  const runId = admission.operationalRunInstance.runId;
  const terminal =
    result.kind === "settled" && result.status === "ok"
      ? result.result.meta.agentMeta?.terminalReceipt
      : undefined;
  if (
    !params.enabled ||
    params.seedPending ||
    !branch ||
    !terminal ||
    terminal.runId !== runId ||
    terminal.sessionId !== params.sessionId ||
    (!terminal.assistantTranscriptEntryId && !terminal.assistantTranscriptIdempotencyKey) ||
    signal.aborted
  ) {
    return;
  }
  await drainAgentRunTerminalWrites(admission.operationalRunInstance);
  admission.assertSourceCurrent();
  signal.throwIfAborted();
  try {
    await acceptReplyConversationPublication({
      branch,
      env: params.getEnvironment(),
      assertCurrent: composeSessionSourceAssertion([
        params.assertCurrent,
        admission.assertSourceCurrent,
      ]),
      runId: terminal.runId,
      entryId: terminal.assistantTranscriptEntryId,
      idempotencyKey: terminal.assistantTranscriptIdempotencyKey,
    });
  } catch {
    // Consolidation cannot turn committed native work into a failed/retryable task.
    // Output still belongs to its original live delivery authority.
    knowledgeLog.warn(
      "Completed turn retained; conversation publication acceptance remains unconfirmed. Do not repeat completed work.",
      { runId, errorCode: "publication-acceptance-unconfirmed" },
    );
  }
}

/** Capture only original ingress proof, before the source occurrence is committed. */
export function captureReplyConversationPublication(params: {
  followupRun: AgentTurnParams["followupRun"];
  branch: ConversationKnowledgeBranch | undefined;
  sourceMode: "native" | "branches" | undefined;
  admission: PreparedAgentRunAdmission | undefined;
  seedPending: boolean;
  observed?: ConversationKnowledgeFrontier[];
  assertCurrent: SessionSourceAssertion;
}): { intent: ConversationPublicationIntent; assertCurrent: SessionSourceAssertion } | undefined {
  const { followupRun, branch, admission, sourceMode } = params;
  if (!branch || !admission || !sourceMode || params.seedPending) {
    return undefined;
  }
  const proof = followupRun.conversationAudience;
  const participant = proof?.participant;
  const anchor = followupRun.userTurnTranscriptRecorder?.getAdmissionReceipt();
  const privateAudience =
    proof &&
    participant &&
    (participant.type === "remote" || participant.type === "profile") &&
    anchor &&
    proof.agentId === branch.agentId &&
    proof.sessionKey === branch.sessionKey &&
    conversationKnowledgeParticipantIdentity(participant) ===
      conversationKnowledgeParticipantIdentity(followupRun.conversationParticipant)
      ? { participant, admission: anchor }
      : undefined;
  return {
    intent: {
      version: 1,
      kind: "completed-turn",
      sourceMode,
      source: {
        sessionKey: branch.sessionKey,
        sessionId: branch.sessionId,
        lifecycleRevision: branch.lifecycleRevision,
      },
      root: branch.root,
      runId: admission.operationalRunInstance.runId,
      observed: params.observed,
      ...(privateAudience ? { privateAudience } : {}),
    },
    assertCurrent: composeSessionSourceAssertion([
      params.assertCurrent,
      admission.assertSourceCurrent,
      ...(privateAudience ? [() => proof!.assertCurrent()] : []),
    ]),
  };
}

/** A successful result upgrades only its exact original append candidate, never new provenance. */
export async function acceptReplyConversationPublication(params: {
  branch: ConversationKnowledgeBranch;
  runId: string;
  entryId?: string;
  idempotencyKey?: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent: SessionSourceAssertion;
}): Promise<void> {
  const { branch } = params;
  const target = { agentId: branch.agentId, path: branch.storePath, env: params.env };
  const accepted = await openConversationPublicationStore({
    ...target,
    assertCurrent: params.assertCurrent,
  }).accept({
    sessionKey: branch.sessionKey,
    sessionId: branch.sessionId,
    lifecycleRevision: branch.lifecycleRevision,
    runId: params.runId,
    entryId: params.entryId,
    idempotencyKey: params.idempotencyKey,
  });
  if (accepted === undefined) {
    log.warn(
      "Exact conversation completion candidate unavailable; completed work must not be repeated.",
      {
        agentId: branch.agentId,
        errorCode: "completion-candidate-unavailable",
      },
    );
  }
  startConversationKnowledgePublication(target);
}
