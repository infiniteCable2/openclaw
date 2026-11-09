import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { resolveAgentRunCwd } from "../agents/agent-scope-config.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { withCommentaryGuidance } from "../agents/commentary-guidance.js";
import { hasDeliberateSilentTerminalReply } from "../agents/embedded-agent-runner/result-fallback-classifier.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunMeta } from "../agents/embedded-agent-runner/types.js";
import type { ProviderLocalServiceLease } from "../agents/provider-local-service-target.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../agents/spawned-context.js";
import { resolveLoadedSessionThreadInfo } from "../channels/plugins/session-thread-info-loaded.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AssistantDeliveryTtsFacts } from "../llm/types.js";
import type { RuntimeLogger, PluginRuntimeCore } from "../plugins/runtime/types-core.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isModelSelectionLocked, ModelSelectionLockedError } from "../sessions/model-overrides.js";
import type { ReplyToolAuthorityOverlay } from "../sessions/session-controller.contracts.js";
import type { PreparedSpeechExpressionContext } from "../tts/expression-preparation.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { hasDeliveryTargetFields, type DeliveryContext } from "../utils/delivery-context.shared.js";
import {
  resolveRealtimeVoiceAgentConsultSessionEntry,
  resolveRealtimeVoiceContextSource,
  type RealtimeVoiceAgentConsultContextMode,
} from "./agent-consult-session.js";
import {
  createRealtimeVoiceConsultSpeechDelivery,
  resolveRealtimeVoiceYieldAcknowledgment,
} from "./agent-consult-speech-delivery.js";
import {
  buildRealtimeVoiceAgentConsultPrompt,
  type RealtimeVoiceAgentConsultTranscriptEntry,
} from "./agent-consult-tool.js";

export type RealtimeVoiceAgentConsultRuntime = PluginRuntimeCore["agent"];

/**
 * Speakable text returned to the realtime voice bridge after an agent consult.
 */
export type RealtimeVoiceSpeechUtterance = {
  text: string;
  /** Admitted commentary remains distinct from final-answer text. */
  purpose?: "commentary";
  speech?: AssistantDeliveryTtsFacts;
  /** Transient provider generation; never part of transcript or delivery metadata. */
  localServiceAdmission?: NonNullable<ProviderLocalServiceLease["admission"]>;
  expectedSpeechSelection?: PreparedSpeechExpressionContext["expectedSpeechSelection"];
};
export type RealtimeVoiceAgentConsultResult = {
  text: string;
  delivered?: boolean;
  yielded?: true;
  /** Ordered admitted utterances for buffered playback; includes explicit commentary. */
  utterances?: RealtimeVoiceSpeechUtterance[];
};
export type RealtimeVoiceSpeechExpressionContext = {
  guidance: string;
  assertCurrent: () => void;
  localServiceAdmission?: NonNullable<ProviderLocalServiceLease["admission"]>;
  expectedSpeechSelection?: PreparedSpeechExpressionContext["expectedSpeechSelection"];
};

/** Safe speech chunks, including explicitly admitted commentary, and final answer completion. */
export type RealtimeVoiceAgentConsultSpeechEvent =
  | ({ type: "chunk" } & RealtimeVoiceSpeechUtterance)
  | { type: "done"; text: string }
  | { type: "abort" };

/**
 * Sender-auth contract revision for official realtime voice plugins.
 *
 * Revision 1 forwards ingress-authenticated `senderId` and `senderIsOwner` unchanged. Ingress
 * owns authentication; consumers that require this handoff must fail closed on other revisions.
 */
export const REALTIME_VOICE_AGENT_CONSULT_SENDER_AUTH_VERSION = 1;

type RealtimeVoiceAgentConsultRunRegistration = {
  abortSignal?: AbortSignal;
  cleanup?: () => void;
  cleanupBeforeRun?: () => void;
};

type RealtimeVoiceAgentConsultModelLockParams = {
  cfg: OpenClawConfig;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  agentId: string;
  sessionKey: string;
  spawnedBy?: string | null;
  contextSourceSessionKey?: string;
  storePath?: string;
};

/**
 * Fails closed when a realtime consult would cross a model-selection lock.
 */
export function assertRealtimeVoiceAgentConsultModelSelectionUnlocked(
  params: RealtimeVoiceAgentConsultModelLockParams,
): void {
  for (const candidate of collectModelSelectionLockCandidates(params)) {
    assertModelSelectionUnlocked(
      params.agentRuntime.session.getSessionEntry({ ...candidate, readConsistency: "latest" }),
    );
  }
}

/** Gateway consults read lock state through the worker-backed session reader. */
async function assertConsultModelSelectionUnlocked(
  params: RealtimeVoiceAgentConsultModelLockParams,
): Promise<void> {
  for (const candidate of collectModelSelectionLockCandidates(params)) {
    assertModelSelectionUnlocked(
      await params.agentRuntime.session.getSessionEntryAsync({
        ...candidate,
        readConsistency: "latest",
      }),
    );
  }
}

function assertModelSelectionUnlocked(entry: SessionEntry | undefined): void {
  // Realtime consults select a configured provider/model and may run fast-context first.
  // Until they preserve native bindings, a locked transcript must never cross runtimes.
  if (isModelSelectionLocked(entry)) {
    throw new ModelSelectionLockedError();
  }
}

function collectModelSelectionLockCandidates(params: RealtimeVoiceAgentConsultModelLockParams) {
  const candidates = new Map<string, { agentId: string; sessionKey: string; storePath: string }>();
  const remember = (sessionKey: string, fallbackAgentId: string, storePath?: string) => {
    const candidateAgentId = parseAgentSessionKey(sessionKey)?.agentId ?? fallbackAgentId;
    const candidateStorePath =
      storePath ??
      params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, {
        agentId: candidateAgentId,
      });
    candidates.set(`${candidateStorePath}\u0000${sessionKey}`, {
      agentId: candidateAgentId,
      sessionKey,
      storePath: candidateStorePath,
    });
  };

  remember(params.sessionKey, params.agentId, params.storePath);
  resolveRealtimeVoiceContextSource(params);
  const requesterSessionKey = params.spawnedBy?.trim();
  const requesterAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
  const targetAgentId = parseAgentSessionKey(params.sessionKey)?.agentId ?? params.agentId;
  if (requesterSessionKey && (!requesterAgentId || requesterAgentId === targetAgentId)) {
    const requesterAgent = requesterAgentId ?? params.agentId;
    remember(requesterSessionKey, requesterAgent);
    const { baseSessionKey } = resolveLoadedSessionThreadInfo(requesterSessionKey);
    if (baseSessionKey && baseSessionKey !== requesterSessionKey) {
      remember(baseSessionKey, requesterAgent);
    }
  }

  return candidates.values();
}

function resolveRealtimeVoiceAgentSandboxSessionKey(agentId: string, sessionKey: string): string {
  // Embedded agent runs expect agent-scoped sandbox keys; keep already-scoped keys intact so
  // callers can deliberately share a sandbox with an existing agent session.
  const trimmed = sessionKey.trim();
  if (trimmed.toLowerCase().startsWith("agent:")) {
    return trimmed;
  }
  return `agent:${agentId}:${trimmed}`;
}

export function buildRealtimeVoiceAgentToolAuthorityOverlay(params: {
  sessionEntry?: SessionEntry;
  deliveryContext?: DeliveryContext;
  messageProvider: string;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderIsOwner?: boolean;
  toolsAllow?: string[];
}): ReplyToolAuthorityOverlay {
  return {
    permissionMode: params.sessionEntry?.permissionMode,
    toolOverrides: params.sessionEntry?.toolOverrides,
    messageProvider: params.deliveryContext?.channel ?? params.messageProvider,
    agentAccountId: params.deliveryContext?.accountId,
    spawnedBy: params.spawnedBy ?? undefined,
    senderId: params.senderId ?? undefined,
    senderIsOwner: params.senderIsOwner === true,
    toolsAllow: params.toolsAllow,
    disableTools: false,
    traceAuthorized: false,
  };
}

function assertRealtimeVoiceConsultNotInterrupted(
  abortSignal: AbortSignal,
  meta?: EmbeddedAgentRunMeta,
): void {
  const outcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase: "end",
    data: meta,
    abortSignal,
  });
  const classification = classifyAgentRunTerminalOutcome(outcome);
  // Preserve the run owner's interruption before projecting partial or empty text
  // into speech. A timeout must remain a failure, not a silent cancellation.
  if (classification === "cancellation") {
    throw new DOMException("Realtime voice agent consult cancelled", "AbortError");
  }
  if (classification === "timeout") {
    throw new DOMException("Realtime voice agent consult timed out", "TimeoutError");
  }
}

export async function consultRealtimeVoiceAgent(params: {
  cfg: OpenClawConfig;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  logger: Pick<RuntimeLogger, "warn">;
  sessionKey: string;
  /** Prepared concrete store; omitted callers retain their configured store selection. */
  storePath?: string;
  messageProvider: string;
  lane: string;
  runIdPrefix: string;
  args: unknown;
  /** Host-admitted image snapshots belonging to this exact user input. */
  images?: RunEmbeddedAgentParams["images"];
  transcript: RealtimeVoiceAgentConsultTranscriptEntry[];
  surface: string;
  userLabel: string;
  assistantLabel?: string;
  questionSourceLabel?: string;
  agentId?: string;
  spawnedBy?: string | null;
  /** Host-admitted snapshot source only; never infers task authority, sender rights, or delivery. */
  contextSourceSessionKey?: string;
  /** Sender identity established by the caller's ingress authorization boundary. */
  senderId?: string | null;
  /** Trusted owner bit established by the caller's ingress authorization boundary. */
  senderIsOwner?: boolean;
  contextMode?: RealtimeVoiceAgentConsultContextMode;
  provider?: RunEmbeddedAgentParams["provider"];
  model?: RunEmbeddedAgentParams["model"];
  thinkLevel?: RunEmbeddedAgentParams["thinkLevel"];
  fastMode?: RunEmbeddedAgentParams["fastMode"];
  /** Authorized ingress channel of this live conversation, not its output transport. */
  speechChannelId?: string;
  timeoutMs?: number;
  toolsAllow?: string[];
  toolBindings?: RunEmbeddedAgentParams["toolBindings"];
  extraSystemPrompt?: string;
  fallbackText?: string;
  abortSignal?: AbortSignal;
  /**
   * Optional low-latency speech sink. Native visible answer blocks are forwarded as
   * they complete. Reasoning and error blocks stay excluded; commentary requires
   * an explicit caller opt-in and does not become final-answer text.
   */
  onSpeakableText?: (event: RealtimeVoiceAgentConsultSpeechEvent) => void | Promise<void>;
  /** Speak completed commentary blocks on this consult only, without adding them to final text. */
  speakCommentary?: boolean;
  /** Caller has already admitted the exact speech target and retained its provider lease. */
  speechExpressionContext?: RealtimeVoiceSpeechExpressionContext;
  /** Precompute greeting utterances; never execute external actions or play audio. */
  speechExpressionCaptureOnly?: true;
  /** Prepared selected-model budgets; only speech opts into word-based block streaming. */
  speechSegmentationProfile?: import("../tts/provider-types.js").SpeechSegmentationProfile;
  waitForPendingInput?: RunEmbeddedAgentParams["waitForPendingInput"];
  /** Gateway ingress adapts authenticated policy; channel bridges keep their own authority. */
  prepareToolContext?: (
    sessionEntry: SessionEntry,
  ) => Partial<
    Pick<
      RunEmbeddedAgentParams,
      | "permissionMode"
      | "toolOverrides"
      | "senderIsOwner"
      | "senderId"
      | "messageProvider"
      | "agentAccountId"
      | "approvalReviewerDeviceId"
      | "clientCaps"
      | "execOverrides"
      | "bashElevated"
      | "currentChannelId"
      | "currentThreadTs"
    >
  >;
  onRunStarted?: (params: {
    runId: string;
    sessionId: string;
    timeoutMs: number;
  }) =>
    | RealtimeVoiceAgentConsultRunRegistration
    | void
    | Promise<RealtimeVoiceAgentConsultRunRegistration | void>;
}): Promise<RealtimeVoiceAgentConsultResult> {
  params.abortSignal?.throwIfAborted();
  const [{ beginSessionEffect }, { resolveSessionWorkStartError }] = await Promise.all([
    import("../sessions/session-controller.lifecycle.js"),
    import("../config/sessions/lifecycle.js"),
  ]);
  params.abortSignal?.throwIfAborted();
  const agentId =
    params.agentId ?? resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey });
  const storePath =
    params.storePath ??
    params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, { agentId });
  const initialSessionEntry = await params.agentRuntime.session.getSessionEntryAsync({
    agentId,
    storePath,
    sessionKey: params.sessionKey,
    readConsistency: "latest",
  });
  const resolvedDeliveryContext =
    (await (async () => {
      const { cfg, agentRuntime, sessionKey, spawnedBy } = params;
      const requesterSessionKey = spawnedBy?.trim();
      try {
        // Prefer the live requester session, then its base thread, then the voice consult session.
        // This preserves channel/account/thread routing when a voice bridge delegates back to agent.
        const candidates: Array<{ sessionKey: string; storePath?: string }> = [];
        if (requesterSessionKey) {
          const { baseSessionKey } = resolveLoadedSessionThreadInfo(requesterSessionKey);
          for (const key of [requesterSessionKey, baseSessionKey]) {
            if (key) {
              candidates.push({ sessionKey: key });
            }
          }
        }
        candidates.push({ sessionKey, storePath });
        const visited = new Set<string>();
        for (const candidate of candidates) {
          const candidateAgentId = parseAgentSessionKey(candidate.sessionKey)?.agentId ?? agentId;
          const candidateStorePath =
            candidate.storePath ??
            agentRuntime.session.resolveStorePath(cfg.session?.store, {
              agentId: candidateAgentId,
            });
          const identity = `${candidateStorePath}\u0000${candidate.sessionKey}`;
          if (visited.has(identity)) {
            continue;
          }
          visited.add(identity);
          const entry =
            candidateStorePath === storePath && candidate.sessionKey === sessionKey
              ? initialSessionEntry
              : await agentRuntime.session.getSessionEntryAsync({
                  agentId: candidateAgentId,
                  storePath: candidateStorePath,
                  sessionKey: candidate.sessionKey,
                });
          const context = deliveryContextFromSession(entry);
          if (hasDeliveryTargetFields(context)) {
            return context;
          }
        }
      } catch {
        // Best-effort routing enrichment only; consults should still work without it.
      }
      return undefined;
    })()) ?? deliveryContextFromSession(initialSessionEntry);
  const agentDir = params.agentRuntime.resolveAgentDir(params.cfg, agentId);
  const workspaceDir =
    resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: initialSessionEntry?.spawnedBy,
      workspaceDir: initialSessionEntry?.spawnedWorkspaceDir,
      cwd: initialSessionEntry?.spawnedCwd,
    }) ?? params.agentRuntime.resolveAgentWorkspaceDir(params.cfg, agentId);
  const cwd =
    normalizeOptionalString(initialSessionEntry?.spawnedCwd) ??
    resolveAgentRunCwd(params.cfg, agentId);
  const modelLockParams = {
    cfg: params.cfg,
    agentRuntime: params.agentRuntime,
    agentId,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    contextSourceSessionKey: params.contextSourceSessionKey,
    storePath,
  };
  await assertConsultModelSelectionUnlocked(modelLockParams);
  const lifecycleAbortController = new AbortController();
  const lifecycleInterruption = new Error(
    "Realtime voice agent consult interrupted by a session lifecycle change.",
  );
  const sessionWorkAdmission = await beginSessionEffect({
    agentId,
    scope: storePath,
    identities: [params.sessionKey, initialSessionEntry?.sessionId],
    onInterrupt: () => lifecycleAbortController.abort(lifecycleInterruption),
    assertAllowed: async () => {
      const currentEntry = await params.agentRuntime.session.getSessionEntryAsync({
        agentId,
        storePath,
        sessionKey: params.sessionKey,
        readConsistency: "latest",
      });
      const changed = initialSessionEntry
        ? !currentEntry || currentEntry.sessionId !== initialSessionEntry.sessionId
        : Boolean(currentEntry);
      if (changed) {
        throw new Error(`Session "${params.sessionKey}" changed while starting work. Retry.`);
      }
      const archivedSessionError = resolveSessionWorkStartError(params.sessionKey, currentEntry);
      if (archivedSessionError) {
        throw new Error(archivedSessionError);
      }
      await assertConsultModelSelectionUnlocked(modelLockParams);
    },
  });
  const abortFromCaller = () => lifecycleAbortController.abort(params.abortSignal?.reason);
  if (params.abortSignal?.aborted) {
    abortFromCaller();
  } else {
    params.abortSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  try {
    return await sessionWorkAdmission.run(async () => {
      await params.agentRuntime.ensureAgentWorkspace({
        dir: workspaceDir,
        guard: {
          assertHost: () => {
            lifecycleAbortController.signal.throwIfAborted();
            if (!sessionWorkAdmission.isActive()) {
              throw lifecycleInterruption;
            }
          },
        },
      });

      // The consult session stores normal session metadata so subsequent voice turns can keep
      // routing and, in fork mode, recover useful conversation context from the requester.
      const { entry: sessionEntry, parentContextNotice } =
        await resolveRealtimeVoiceAgentConsultSessionEntry({
          agentId,
          cfg: params.cfg,
          sessionKey: params.sessionKey,
          spawnedBy: params.spawnedBy,
          contextSourceSessionKey: params.contextSourceSessionKey,
          senderIsOwner: params.senderIsOwner,
          contextMode: params.contextMode,
          deliveryContext: resolvedDeliveryContext,
          storePath,
          agentRuntime: params.agentRuntime,
          logger: params.logger,
          assertCurrent: () => {
            lifecycleAbortController.signal.throwIfAborted();
            if (!sessionWorkAdmission.isActive()) {
              throw lifecycleInterruption;
            }
          },
        });
      const consultDeliveryContext =
        resolvedDeliveryContext ?? deliveryContextFromSession(sessionEntry);
      const toolAuthorityOverlay = buildRealtimeVoiceAgentToolAuthorityOverlay({
        ...params,
        sessionEntry,
        deliveryContext: consultDeliveryContext,
      });
      const sessionId = sessionEntry.sessionId;
      await assertConsultModelSelectionUnlocked(modelLockParams);

      const runId = `${params.runIdPrefix}-${randomUUID()}`;
      const timeoutMs =
        params.timeoutMs ?? params.agentRuntime.resolveAgentTimeoutMs({ cfg: params.cfg });
      const runRegistration = await params.onRunStarted?.({ runId, sessionId, timeoutMs });
      const abortSignal = runRegistration?.abortSignal
        ? AbortSignal.any([lifecycleAbortController.signal, runRegistration.abortSignal])
        : lifecycleAbortController.signal;

      let sourceTargetOpen = true;
      const assertExpressionCurrent = () => {
        abortSignal.throwIfAborted();
        if (!sourceTargetOpen || !sessionWorkAdmission.isActive()) {
          throw new Error("Current-source speech target is no longer active");
        }
        params.speechExpressionContext?.assertCurrent();
      };
      const speechDelivery = createRealtimeVoiceConsultSpeechDelivery({
        runId,
        sessionId,
        abortSignal,
        assertExpressionCurrent,
        assertNotInterrupted: () => assertRealtimeVoiceConsultNotInterrupted(abortSignal),
        onSpeakableText: params.onSpeakableText,
        speakCommentary: params.speakCommentary,
        speechExpressionContext: params.speechExpressionContext,
        speechExpressionCaptureOnly: params.speechExpressionCaptureOnly,
        fallbackText: params.fallbackText,
        logger: params.logger,
      });
      const { currentSourceReplyTarget, spokenCommentaryEnabled, abortSpeechDelivery } =
        speechDelivery;
      const onSpeechAbort = () => {
        void abortSpeechDelivery();
      };
      abortSignal.addEventListener("abort", onSpeechAbort, { once: true });

      let runStarted = false;
      try {
        assertRealtimeVoiceConsultNotInterrupted(abortSignal);
        await assertConsultModelSelectionUnlocked(modelLockParams);
        abortSignal.throwIfAborted();
        if (params.speechExpressionContext) {
          assertExpressionCurrent();
        }
        // Voice consults suppress verbose/reasoning presentation because the bridge needs a short,
        // speakable answer, not agent-run diagnostics or hidden reasoning artifacts.
        const runPromise = params.agentRuntime.runEmbeddedAgent({
          sessionId,
          sessionKey: params.sessionKey,
          sessionTarget: {
            agentId,
            sessionId,
            sessionKey: params.sessionKey,
            storePath,
          },
          spawnedBy: sessionEntry.spawnedBy,
          sandboxSessionKey: resolveRealtimeVoiceAgentSandboxSessionKey(agentId, params.sessionKey),
          agentId,
          ...toolAuthorityOverlay,
          // ASR voice ingress has no trace/client-tool or privileged handoff capability.
          messageProvider: toolAuthorityOverlay.messageProvider,
          messageTo: consultDeliveryContext?.to,
          messageThreadId: consultDeliveryContext?.threadId,
          currentChannelId: consultDeliveryContext?.to,
          currentThreadTs:
            consultDeliveryContext?.threadId != null
              ? String(consultDeliveryContext.threadId)
              : undefined,
          workspaceDir,
          cwd,
          config: params.cfg,
          prompt: buildRealtimeVoiceAgentConsultPrompt({
            args: params.args,
            transcript: params.transcript,
            surface: params.surface,
            userLabel: params.userLabel,
            assistantLabel: params.assistantLabel,
            questionSourceLabel: params.questionSourceLabel,
            commentaryEnabled: spokenCommentaryEnabled,
          }),
          images: params.images,
          provider: params.provider,
          model: params.model,
          thinkLevel: params.thinkLevel ?? "high",
          fastMode: params.fastMode,
          ...(params.speechChannelId
            ? {
                modelRequestProfile: { kind: "speech" as const, channelId: params.speechChannelId },
              }
            : {}),
          verboseLevel: "off",
          reasoningLevel: "off",
          toolResultFormat: "plain",
          ...(params.speechExpressionContext
            ? { nativeSpeechPresentation: { assertCurrent: assertExpressionCurrent } }
            : {}),
          ...(currentSourceReplyTarget
            ? {
                currentSourceReplyTarget,
              }
            : {}),
          ...(params.onSpeakableText
            ? {
                deliverCommentaryBlocks: spokenCommentaryEnabled,
                blockReplyBreak: "text_end" as const,
                blockReplyChunking: {
                  minChars: params.speechSegmentationProfile?.minChars ?? 48,
                  maxChars: params.speechSegmentationProfile?.maxChars ?? 320,
                  breakPreference: "sentence" as const,
                  ...(params.speechSegmentationProfile
                    ? { speech: params.speechSegmentationProfile }
                    : {}),
                },
                onBlockReply: speechDelivery.onBlockReply,
              }
            : {}),
          execSession: sessionEntry,
          sessionRoot: normalizeOptionalString(sessionEntry.sessionRoot),
          toolsAllow: params.toolsAllow,
          toolBindings: params.toolBindings,
          timeoutMs,
          runId,
          lane: params.lane,
          extraSystemPrompt: withCommentaryGuidance(
            [
              params.extraSystemPrompt ??
                "You are the configured OpenClaw agent participating in a live voice conversation. Respond to the user, use available tools when appropriate, and return a brief speakable result.",
              params.speechExpressionContext?.guidance,
              parentContextNotice,
            ]
              .filter(Boolean)
              .join("\n\n"),
            spokenCommentaryEnabled,
            "text",
          ),
          agentDir,
          ...params.prepareToolContext?.(sessionEntry),
          abortSignal,
          waitForPendingInput: params.waitForPendingInput,
        });
        runStarted = true;
        const result = await runPromise;
        assertRealtimeVoiceConsultNotInterrupted(abortSignal, result.meta);
        const yielded = result.meta?.yielded === true;
        const acknowledgment = resolveRealtimeVoiceYieldAcknowledgment(result.meta);
        return await speechDelivery.finish({
          yielded,
          acknowledgment,
          deliberateSilent: hasDeliberateSilentTerminalReply(result),
          payloads: result.payloads ?? [],
        });
      } catch (error) {
        if (!runStarted) {
          runRegistration?.cleanupBeforeRun?.();
        }
        await abortSpeechDelivery();
        assertRealtimeVoiceConsultNotInterrupted(abortSignal);
        throw error;
      } finally {
        sourceTargetOpen = false;
        abortSignal.removeEventListener("abort", onSpeechAbort);
        await speechDelivery.abortCompletion;
        runRegistration?.cleanup?.();
      }
    });
  } finally {
    params.abortSignal?.removeEventListener("abort", abortFromCaller);
    sessionWorkAdmission.release();
  }
}
