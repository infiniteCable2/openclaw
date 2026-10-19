import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { runAgentHarnessBeforeMessageWriteHook } from "../../../agents/harness/hook-helpers.js";
import { normalizeChatType } from "../../../channels/chat-type.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { channelRouteDedupeKey } from "../../../plugin-sdk/channel-route.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { resolveCollectedRun } from "./collected-run.js";
import {
  collectRuntimeMetadata,
  getFollowupOriginRouting,
  resolveFollowupReplyAnchor,
  resolveOverflowSummaryInboundEventKind,
} from "./delivery-context.js";
import { completeFollowupRuns } from "./lifecycle.js";
import type { FollowupRun } from "./types.js";

export function resolveOriginRoutingMetadata(items: FollowupRun[]) {
  const source =
    items.find((item) => item.originatingChannel && item.originatingTo) ??
    items.find(
      (item) =>
        item.originatingChannel ||
        item.originatingTo ||
        item.originatingAccountId ||
        item.originatingThreadId != null ||
        item.originatingChatId ||
        item.originatingReplyToId ||
        item.originatingReplyToMode ||
        item.originatingChatType,
    );
  return source ? getFollowupOriginRouting(source) : {};
}

export function resolveFollowupTranscriptTarget(source: FollowupRun) {
  const sessionKey = normalizeOptionalString(source.run.sessionKey) ?? source.run.sessionId;
  const storePath = resolveSessionStorePathCore(source.run.config.session?.store, {
    agentId: source.run.agentId,
  });
  const sessionEntry = loadSessionEntryReadOnly({
    storePath,
    sessionKey,
    clone: false,
  });
  return {
    sessionId: sessionEntry?.sessionId ?? source.run.sessionId,
    sessionKey,
    sessionEntry,
    storePath,
    agentId: source.run.agentId,
    cwd: source.run.cwd ?? source.run.workspaceDir,
    config: source.run.config,
  };
}

export function createAggregateLifecycle(
  items: readonly FollowupRun[],
  onAdopted: NonNullable<FollowupRun["turnAdoptionLifecycle"]>["onAdopted"],
  onSettled: () => void,
): NonNullable<FollowupRun["turnAdoptionLifecycle"]> {
  return {
    // Synthetic aggregates own cancellation; sources keep their own admission.
    admission: "cancel-only",
    ...(items.some(
      (item) =>
        item.turnAdoptionLifecycle?.cronCreatorAuthorityUnavailable === "queued-local-operator",
    )
      ? { cronCreatorAuthorityUnavailable: "queued-local-operator" as const }
      : {}),
    onAdopted,
    onSettled,
  };
}

export async function runSyntheticOverflowSummary(params: {
  source: FollowupRun;
  sources: FollowupRun[];
  prompt: string;
  abortSignal?: AbortSignal;
  onAdmitted?: () => void | Promise<void>;
  runFollowup: (run: FollowupRun) => Promise<void>;
}): Promise<void> {
  const promptHash = createHash("sha256").update(params.prompt).digest("hex");
  const routeHash = createHash("sha256")
    .update(
      JSON.stringify([
        channelRouteDedupeKey({
          channel: params.source.originatingChannel,
          to: params.source.originatingTo,
          accountId: params.source.originatingAccountId,
          threadId: params.source.originatingThreadId,
        }),
        resolveFollowupReplyAnchor(params.source) ?? "",
        params.source.originatingReplyToMode ?? "",
        normalizeChatType(params.source.originatingChatType) ?? "",
      ]),
    )
    .digest("hex");
  const userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
    input: {
      text: params.prompt,
      idempotencyKey: `followup-overflow:${params.source.run.sessionId}:${routeHash}:${params.source.messageId ?? params.source.enqueuedAt}:${promptHash}`,
      senderIsOwner: params.source.run.senderIsOwner,
      provenance: params.source.run.inputProvenance,
    },
    target: () => resolveFollowupTranscriptTarget(params.source),
    pendingInputSources: params.sources.flatMap(
      (source) => source.userTurnTranscriptRecorder ?? [],
    ),
    beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    errorContext: "followup overflow summary transcript",
  });
  const currentInboundEventKind = resolveOverflowSummaryInboundEventKind(params.sources);
  const runtimeMetadata = collectRuntimeMetadata(params.sources);
  let admitted = false;
  await params.runFollowup({
    prompt: params.prompt,
    sourceTurnId: runtimeMetadata.sourceTurnId,
    queueAbortSignal: params.source.queueAbortSignal,
    transcriptPrompt: params.prompt,
    messageId: params.source.messageId,
    userTurnTranscriptRecorder,
    run: resolveCollectedRun(params.sources, params.source.run),
    enqueuedAt: Date.now(),
    abortSignal: params.abortSignal,
    explicitSkillSelections: runtimeMetadata.explicitSkillSelections,
    channelAdmissionEvidence: runtimeMetadata.channelAdmissionEvidence,
    gatewayLocalUserIngress: runtimeMetadata.gatewayLocalUserIngress,
    operatorAuthority: runtimeMetadata.operatorAuthority,
    assertSourceCurrent: runtimeMetadata.assertSourceCurrent,
    speechPresentation: runtimeMetadata.speechPresentation,
    personalBootstrapEligible: runtimeMetadata.personalBootstrapEligible,
    conversationParticipant: runtimeMetadata.conversationParticipant,
    conversationAudience: runtimeMetadata.conversationAudience,
    toolsAllow: runtimeMetadata.toolsAllow,
    disableTools: runtimeMetadata.disableTools,
    queuedFollowupReplyDisposition: runtimeMetadata.queuedFollowupReplyDisposition,
    runObservers: runtimeMetadata.runObservers,
    replyOperationRunStates: runtimeMetadata.replyOperationRunStates,
    ...(params.onAdmitted
      ? {
          turnAdoptionLifecycle: createAggregateLifecycle(
            params.sources,
            async () => {
              await params.onAdmitted?.();
              admitted = true;
            },
            () => {
              if (admitted) {
                completeFollowupRuns(params.sources);
              }
            },
          ),
        }
      : {}),
    ...resolveOriginRoutingMetadata([params.source]),
    ...(currentInboundEventKind ? { currentInboundEventKind } : {}),
  });
}
