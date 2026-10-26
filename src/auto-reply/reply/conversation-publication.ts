import type { PreparedAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeFrontier } from "../../config/sessions/conversation-knowledge.js";
import { startConversationKnowledgePublication } from "../../config/sessions/conversation-publication-reconcile.js";
import type { ConversationPublicationIntent } from "../../config/sessions/conversation-publication.types.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { readMessageIdempotencyKey } from "../../config/sessions/transcript-message-identity.js";
import { drainAgentRunTerminalWrites } from "../../infra/agent-run-terminal-writes.js";
import type { AgentTurnInternalResult, AgentTurnParams } from "./agent-runner-execution.types.js";

/** Terminal settlement wakes recovery; original entries were already journaled independently. */
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
  params.assertCurrent();
  // No completed-turn reference recopies entries already published as observations.
  startConversationKnowledgePublication({
    agentId: branch.agentId,
    path: branch.storePath,
    env: params.getEnvironment(),
  });
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
  role?: "user" | "assistant";
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
    (anchor || params.role === "user") &&
    proof.agentId === branch.agentId &&
    proof.sessionKey === branch.sessionKey &&
    conversationKnowledgeParticipantIdentity(participant) ===
      conversationKnowledgeParticipantIdentity(followupRun.conversationParticipant)
      ? { participant, admission: params.role === "user" ? ("self" as const) : anchor! }
      : undefined;
  return {
    intent: {
      version: 1,
      kind: "utterance-observation",
      role: params.role ?? "assistant",
      sourceMode,
      source: {
        sessionKey: branch.sessionKey,
        sessionId: branch.sessionId,
        lifecycleRevision: branch.lifecycleRevision,
      },
      root: branch.root,
      ...(params.role === "user"
        ? {
            inputKey:
              readMessageIdempotencyKey(followupRun.userTurnTranscriptRecorder?.message) ??
              undefined,
          }
        : { runId: admission.operationalRunInstance.runId }),
      observed: params.observed ?? [],
      ...(privateAudience ? { privateAudience } : {}),
    },
    assertCurrent: composeSessionSourceAssertion([
      params.assertCurrent,
      admission.assertSourceCurrent,
      ...(privateAudience ? [() => proof!.assertCurrent()] : []),
    ]),
  };
}
