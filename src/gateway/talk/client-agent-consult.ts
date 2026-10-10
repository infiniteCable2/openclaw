import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { EmbeddedRunCompletionRegistration } from "../../agents/embedded-agent-runner/run-state.js";
import { prepareEmbeddedAgentRunCompletionClaim } from "../../agents/embedded-agent-runner/runs.js";
import { registerRequesterFinalAttachment } from "../../agents/subagents/requester-final-attachment.js";
import { normalizeTalkSection } from "../../config/talk.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { drainAgentRunTerminalWrites } from "../../infra/agent-run-terminal-writes.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  GatewayDrainingError,
  runOutsideGatewayRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import {
  consultRealtimeVoiceAgent,
  type RealtimeVoiceAgentConsultResult,
} from "../../talk/agent-consult-runtime.js";
import { parseRealtimeVoiceAgentConsultArgs } from "../../talk/agent-consult-tool.js";
import {
  authorizeClientVoiceConfirmation,
  authorizeObservedClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  observeClientVoiceConfirmationRun,
} from "../../talk/client-voice-confirmation.js";
import {
  assertClientVoiceSessionOpen,
  registerClientVoiceConsultRun,
} from "../../talk/client-voice-session.js";
import type { SpeechAgentConsultParams } from "../../talk/speech/types.js";
import { registerChatAbortController } from "../chat-abort.js";
import type { GatewayRequestContext } from "../server-methods/shared-types.js";
import {
  controlTalkClientAgentConsult,
  prepareTalkClientControlAuthority,
} from "./client-agent-consult-control.js";
import type {
  TalkAgentConsultPromptOwner as PromptOwner,
  TalkAgentConsultRequest,
  TalkAgentConsultSource,
  TalkRequesterFinalBinding,
} from "./client-agent-consult.types.js";
import {
  resolveTalkAgentConsultAuthority,
  type TalkAgentConsultAuthority,
} from "./client-gateway-control.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

const loadTalkAgentExecution = createLazyRuntimeModule(async () => {
  const [embeddedAgent, admission] = await Promise.all([
    import("../../agents/embedded-agent.js"),
    import("../../agents/admitted-run-context.js"),
  ]);
  return {
    runEmbeddedAgent: embeddedAgent.runEmbeddedAgent,
    createOperationalRunInstanceRef: admission.createOperationalRunInstanceRef,
    prepareAgentRunAdmission: admission.prepareAgentRunAdmission,
  };
});

type TalkRequesterFinalRegistration = ReturnType<typeof registerRequesterFinalAttachment>;

function createTalkClientAgentRuntime(params: {
  config: OpenClawConfig;
  rawSourceRef?: string;
  assertCurrent?: () => void;
  getAdditionalSystemPrompt?: () => string | undefined;
  bindOperationalRunInstance?: (instance: OperationalRunInstanceRef) => void;
}) {
  const agentRuntime = createPluginRuntime().agent;
  const runEmbeddedAgent: typeof agentRuntime.runEmbeddedAgent = async (runParams) => {
    runParams.abortSignal?.throwIfAborted();
    const execution = await loadTalkAgentExecution();
    runParams.abortSignal?.throwIfAborted();
    const { agentId, sessionId, sessionKey, storePath } = runParams.sessionTarget ?? {};
    if (!agentId || !sessionId || !sessionKey || !storePath) {
      throw new Error("Talk consult requires its prepared transcript target");
    }
    const operationalRunInstance = execution.createOperationalRunInstanceRef(runParams.runId);
    params.assertCurrent?.();
    params.bindOperationalRunInstance?.(operationalRunInstance);
    const preparedRunAdmission = execution.prepareAgentRunAdmission({
      cfg: params.config,
      operationalRunInstance,
      facts: {
        runId: runParams.runId,
        agentId,
        ingress: {
          kind: "gateway-client",
          boundary: "talk-agent-consult",
          state: "present",
          ...(params.rawSourceRef ? { rawSourceRef: params.rawSourceRef } : {}),
        },
      },
    });
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        preparedRunAdmission.close();
      }
    };
    // Abort owns authority revocation independently of core completion; the
    // post-registration check closes the prepare-to-listener race.
    runParams.abortSignal?.addEventListener("abort", close, { once: true });
    try {
      runParams.abortSignal?.throwIfAborted();
      // Provider-owned work can outlive or replace its audio transport. Unlike
      // chat-backed Talk, it has no independent Chat terminal delivery; hiding
      // its final transcript would lose the answer when no spoken replacement arrives.
      return await execution.runEmbeddedAgent({
        ...runParams,
        extraSystemPrompt: [runParams.extraSystemPrompt, params.getAdditionalSystemPrompt?.()]
          .filter(Boolean)
          .join("\n\n"),
        preparedRunAdmission,
        // Speech is mirrored separately. Keep generated input in current-turn custody,
        // but never display it or replay it as a later user request.
        userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
          input: {
            text: runParams.prompt,
            display: false,
            excludeFromContext: true,
            idempotencyKey: buildRunUserTurnIdempotencyKey(runParams.runId),
          },
          target: {
            agentId,
            sessionId,
            sessionKey,
            storePath,
            expectedSessionId: sessionId,
            sessionEntry: undefined,
            config: params.config,
            cwd: runParams.workspaceDir,
          },
        }),
      });
    } finally {
      // Accepted terminal writes commit under this admission; abort still closes it immediately.
      try {
        await drainAgentRunTerminalWrites(operationalRunInstance);
      } finally {
        runParams.abortSignal?.removeEventListener("abort", close);
        close();
      }
    }
  };
  Object.defineProperty(agentRuntime, "runEmbeddedAgent", {
    configurable: true,
    enumerable: true,
    value: runEmbeddedAgent,
  });
  return agentRuntime;
}

export { prepareTalkClientControlAuthority } from "./client-agent-consult-control.js";

export function createTalkClientAgentConsultRunner(params: {
  config: OpenClawConfig;
  context: Pick<GatewayRequestContext, "chatAbortControllers" | "logGateway">;
  sessionTarget: PreparedTalkSessionTarget;
  ownerConnId?: string;
  authority?: TalkAgentConsultAuthority;
  getVoiceSessionId: () => string | undefined;
  initialItems: Array<{ role: "user" | "assistant"; text: string }>;
  runIdPrefix?: string;
  surface?: string;
  registerRun?: (params: { runId: string }) => void;
  isRunCurrent?: (runId: string) => boolean;
}) {
  const { agentId, sessionKey, canonicalKey, storePath } = params.sessionTarget;
  const authority = params.authority ?? resolveTalkAgentConsultAuthority(undefined);
  let agentRuntime: ReturnType<typeof createPluginRuntime>["agent"] | undefined;
  const getAgentRuntime = () =>
    (agentRuntime ??= createTalkClientAgentRuntime({
      config: params.config,
      ...(params.ownerConnId ? { rawSourceRef: params.ownerConnId } : {}),
    }));
  const getControlAuthority = (source?: "reply" | "attempt", currentAuthority = authority) =>
    prepareTalkClientControlAuthority({
      config: params.config,
      sessionTarget: params.sessionTarget,
      authority: currentAuthority,
      source,
      agentRuntime: getAgentRuntime(),
    });
  let promptOwner: PromptOwner | undefined;
  let requesterFinalRegistration: TalkRequesterFinalRegistration | undefined;
  const createOwnedAgentRuntime = (
    owner: PromptOwner,
    assertCurrent?: () => void,
    getAdditionalSystemPrompt?: () => string | undefined,
  ) =>
    createTalkClientAgentRuntime({
      config: params.config,
      ...(params.ownerConnId ? { rawSourceRef: params.ownerConnId } : {}),
      assertCurrent,
      getAdditionalSystemPrompt,
      bindOperationalRunInstance: (instance) => {
        const identity = owner.identity;
        if (
          promptOwner !== owner ||
          !identity ||
          identity.runId !== instance.runId ||
          owner.isCurrent?.(identity.sessionId) !== true ||
          owner.completionClaim?.bindOperationalRunInstance(instance) !== true
        ) {
          throw new Error("The active Talk consult admission is no longer current");
        }
      },
    });
  const runArgs = async (
    args: unknown,
    signal?: AbortSignal,
    owner?: PromptOwner,
    ready?: () => Promise<void>,
    assertCurrent?: () => void,
    source: TalkAgentConsultSource = "tool-call",
    speech?: SpeechAgentConsultParams & { speakCommentary?: boolean },
  ) => {
    const parsedArgs = parseRealtimeVoiceAgentConsultArgs(args);
    const voiceSessionId = params.getVoiceSessionId();
    if (!voiceSessionId) {
      throw new Error("Realtime browser voice session is not ready for agent consult");
    }
    if (owner) {
      owner.voiceSessionId = voiceSessionId;
    }
    await ready?.();
    signal?.throwIfAborted();
    // Readiness can outlive its physical browser owner. Recheck after that
    // suspension and keep this path synchronous until backend admission.
    assertCurrent?.();
    // Relays own admission before their lazy record registration. Browser callbacks
    // must validate the durable call before accepting a new run.
    if (!params.registerRun) {
      assertClientVoiceSessionOpen({ agentId, sessionKey, voiceSessionId });
    }
    const confirmationGrant = parsedArgs.confirmationId
      ? authorizeClientVoiceConfirmation({
          agentId,
          voiceSessionId,
          confirmationId: parsedArgs.confirmationId,
        })
      : source === "native-delegation"
        ? authorizeObservedClientVoiceConfirmation({ agentId, voiceSessionId })
        : undefined;
    let confirmationRetryContext: string | undefined;
    const getAdditionalSystemPrompt = () => confirmationRetryContext;
    const runtime = owner
      ? createOwnedAgentRuntime(owner, assertCurrent, getAdditionalSystemPrompt)
      : assertCurrent || source === "native-delegation" || confirmationGrant
        ? createTalkClientAgentRuntime({
            config: params.config,
            ...(params.ownerConnId ? { rawSourceRef: params.ownerConnId } : {}),
            assertCurrent,
            getAdditionalSystemPrompt,
          })
        : getAgentRuntime();
    const talkConfig = normalizeTalkSection(params.config.talk);
    // A voice turn outlives offer setup and must drain under its own root,
    // while new turns still respect suspension and restart admission.
    const admission = runOutsideGatewayRootWorkAdmission(tryBeginGatewayRootWorkAdmission);
    if (!admission) {
      throw new GatewayDrainingError();
    }
    let confirmationObservation: ReturnType<typeof observeClientVoiceConfirmationRun> | undefined;
    let yielded = false;
    return await admission
      .run(() =>
        consultRealtimeVoiceAgent({
          cfg: params.config,
          agentRuntime: runtime,
          logger: params.context.logGateway,
          agentId,
          sessionKey: canonicalKey,
          storePath,
          messageProvider: "webchat",
          lane: "talk",
          runIdPrefix: params.runIdPrefix ?? "talk-realtime-consult",
          args: parsedArgs,
          transcript: speech?.transcript ?? params.initialItems,
          surface: params.surface ?? "a browser Talk session",
          userLabel: "User",
          questionSourceLabel: "user",
          thinkLevel: talkConfig?.consultThinkingLevel,
          fastMode: talkConfig?.consultFastMode,
          ...authority,
          abortSignal: signal,
          onSpeakableText: speech?.onSpeakableText
            ? (event) => {
                if (event.type !== "abort") {
                  assertCurrent?.();
                  // A blocked action's challenge belongs to the host, not model narration.
                  // The canonical reply is delivered after consultation settles.
                  if (confirmationObservation?.readReply()) {
                    return;
                  }
                }
                return speech.onSpeakableText?.(event);
              }
            : undefined,
          waitForPendingInput: speech?.waitForPendingInput,
          speakCommentary: speech?.speakCommentary,
          onRunStarted: ({ runId, sessionId, timeoutMs }) => {
            if (owner) {
              if (
                promptOwner !== owner ||
                owner.requestSignal?.aborted === true ||
                !isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration) ||
                params.getVoiceSessionId() !== voiceSessionId
              ) {
                throw new Error("The active Talk consult admission is no longer current");
              }
            }
            assertCurrent?.();
            if (params.registerRun) {
              params.registerRun({ runId });
            } else {
              registerClientVoiceConsultRun({
                agentId,
                sessionKey,
                voiceSessionId,
                runId,
                config: params.config,
              });
            }
            confirmationObservation = observeClientVoiceConfirmationRun({
              agentId,
              voiceSessionId,
              runId,
            });
            if (owner) {
              owner.identity = { runId, sessionId };
              owner.completionClaim = prepareEmbeddedAgentRunCompletionClaim(sessionId, runId);
              if (owner.requesterFinal) {
                const requesterFinal = owner.requesterFinal;
                const registration = registerRequesterFinalAttachment({
                  requesterAgentId: agentId,
                  requesterSessionKey: canonicalKey,
                  requesterSessionId: sessionId,
                  requesterTurnRunId: runId,
                  lifecycleGeneration: owner.lifecycleGeneration,
                  timeoutMs,
                  append: (text) =>
                    requesterFinal.append(confirmationObservation?.readReply() ?? text),
                });
                owner.requesterFinalRegistration = registration;
                requesterFinalRegistration = registration;
              }
              void owner.completionClaim.registered.then(owner.resolveRegistration);
            }
            if (
              confirmationGrant &&
              bindAuthorizedClientVoiceConfirmation({ grant: confirmationGrant, runId })
            ) {
              confirmationRetryContext = confirmationGrant.retryContext;
            }
            const registration = params.ownerConnId
              ? registerChatAbortController({
                  chatAbortControllers: params.context.chatAbortControllers,
                  runId,
                  sessionId,
                  sessionKey: canonicalKey,
                  agentId,
                  timeoutMs,
                  ownerConnId: params.ownerConnId,
                  controlUiVisible: false,
                  kind: "chat-send",
                })
              : undefined;
            if (owner) {
              const entry = registration?.entry;
              const generation = entry?.lifecycleGeneration;
              owner.cleanup = registration?.cleanup;
              owner.signal = entry?.controller.signal;
              owner.isCurrent = (resolvedSessionId) =>
                params.getVoiceSessionId() === voiceSessionId &&
                owner.requestSignal?.aborted !== true &&
                (!params.ownerConnId ||
                  (params.context.chatAbortControllers.get(runId) === entry &&
                    entry?.controller.signal.aborted === false &&
                    entry.ownerConnId === params.ownerConnId &&
                    entry.sessionId === sessionId &&
                    entry.sessionKey === canonicalKey &&
                    entry.registrationCleanupRequested !== true &&
                    generation !== undefined &&
                    entry.lifecycleGeneration === generation &&
                    isAgentEventLifecycleGenerationCurrent(generation))) &&
                (resolvedSessionId === undefined || resolvedSessionId === sessionId) &&
                (params.isRunCurrent?.(runId) ?? true);
              if (speech?.onRunControl) {
                speech.onRunControl((text, onQueueAccepted, options) =>
                  controlTalkClientAgentConsult({
                    owner,
                    config: params.config,
                    sessionTarget: params.sessionTarget,
                    isCurrent: (candidateSessionId) => isOwnerCurrent(owner, candidateSessionId),
                    assertCurrent: () => {
                      assertCurrent?.();
                      options?.assertCurrent?.();
                    },
                    getToolAuthorityOverlay: getControlAuthority,
                    text,
                    signal: options?.signal,
                    mode: options?.mode ?? "followup",
                    onQueueAccepted,
                  }),
                );
              }
            }
            return registration
              ? {
                  abortSignal: registration.controller.signal,
                  cleanup: owner ? undefined : registration.cleanup,
                }
              : undefined;
          },
        }),
      )
      .then((result) => {
        yielded = result.yielded === true;
        const confirmationReply = confirmationObservation?.readReply({
          includeConfirmationId: source === "tool-call",
        });
        return confirmationReply
          ? {
              ...result,
              text: confirmationReply,
              ...(result.delivered ? { delivered: false } : {}),
            }
          : result;
      })
      .finally(() => {
        // Yielded runs keep observing until run.completed; retained replies read historical facts.
        if (!yielded) {
          confirmationObservation?.release();
        }
        admission.release();
      });
  };
  const isOwnerCurrent = (owner: PromptOwner, sessionId?: string): boolean =>
    promptOwner === owner && owner.isCurrent?.(sessionId) === true;
  const clearOwner = (owner: PromptOwner): void => {
    if (promptOwner === owner) {
      promptOwner = undefined;
    }
    owner.cleanup?.();
  };
  const clearRequesterFinalRegistration = (
    owner: PromptOwner,
    disposition: "release" | "revoke",
  ): void => {
    const registration = owner.requesterFinalRegistration;
    if (!registration) {
      return;
    }
    if (disposition === "release") {
      registration.releaseProvisional();
    } else {
      registration.revoke();
      if (requesterFinalRegistration === registration) {
        requesterFinalRegistration = undefined;
      }
    }
    owner.requesterFinalRegistration = undefined;
  };
  const claimAppend = (): boolean => {
    const owner = promptOwner;
    if (!owner) {
      return false;
    }
    const current = isOwnerCurrent(owner);
    const completed = owner.completionClaim?.claimCompletion() === true;
    clearRequesterFinalRegistration(owner, current && completed ? "release" : "revoke");
    clearOwner(owner);
    return current && completed;
  };
  const claimFailureAppend = (): boolean => {
    const owner = promptOwner;
    if (!owner) {
      return false;
    }
    const identity = owner.identity;
    const current =
      owner.requestSignal?.aborted !== true &&
      isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration) &&
      params.getVoiceSessionId() === owner.voiceSessionId &&
      (identity ? isOwnerCurrent(owner, identity.sessionId) : promptOwner === owner);
    const claimed = owner.completionClaim
      ? owner.completionClaim.claimFailure()
      : identity === undefined &&
        owner.voiceSessionId !== undefined &&
        isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration);
    owner.resolveRegistration(undefined);
    clearRequesterFinalRegistration(owner, "revoke");
    clearOwner(owner);
    return current && claimed;
  };
  const revokeRequesterFinal = (): void => {
    requesterFinalRegistration?.revoke();
    requesterFinalRegistration = undefined;
    if (promptOwner) {
      promptOwner.requesterFinalRegistration = undefined;
    }
  };
  const steer = async ({ prompt, signal }: { prompt: string; signal?: AbortSignal }) => {
    signal?.throwIfAborted();
    const owner = promptOwner;
    if (!owner) {
      throw new Error("No active Talk consult is available to steer");
    }
    const result = await controlTalkClientAgentConsult({
      owner,
      config: params.config,
      sessionTarget: params.sessionTarget,
      isCurrent: (sessionId) => isOwnerCurrent(owner, sessionId),
      getToolAuthorityOverlay: getControlAuthority,
      text: prompt,
      signal,
      mode: "steer",
    });
    if (!result.ok || result.queued !== true || !isOwnerCurrent(owner, owner.identity?.sessionId)) {
      throw new Error(result.message);
    }
    return { text: "" };
  };
  const runOwnedArgs = async (
    args: unknown,
    signal?: AbortSignal,
    ready?: () => Promise<void>,
    assertCurrent?: () => void,
    requesterFinal?: TalkRequesterFinalBinding,
    source: TalkAgentConsultSource = "tool-call",
    speech?: SpeechAgentConsultParams & { speakCommentary?: boolean },
  ) => {
    if (promptOwner) {
      throw new Error("A Talk consult is already active");
    }
    const { promise: registered, resolve: resolveRegistration } = createDeferredCore<
      EmbeddedRunCompletionRegistration | undefined
    >();
    const owner: PromptOwner = {
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      registered,
      requestSignal: signal,
      requesterFinal,
      source,
      resolveRegistration,
    };
    const revokeRegistrationOnAbort = () => resolveRegistration(undefined);
    promptOwner = owner;
    signal?.addEventListener("abort", revokeRegistrationOnAbort, { once: true });
    try {
      return await runArgs(args, signal, owner, ready, assertCurrent, source, speech);
    } catch (error) {
      resolveRegistration(undefined);
      throw error;
    } finally {
      signal?.removeEventListener("abort", revokeRegistrationOnAbort);
    }
  };
  const lifecycleMethods = params.ownerConnId
    ? { claimAppend, claimFailureAppend, revokeRequesterFinal, steer }
    : { claimAppend, claimFailureAppend, revokeRequesterFinal };
  const lifecycleBoundRunArgs = Object.assign(runOwnedArgs, lifecycleMethods);
  let completionClaimsAdopted = false;
  const runPrompt = Object.assign(
    async ({ prompt, signal, requesterFinal }: TalkAgentConsultRequest) => {
      if (completionClaimsAdopted) {
        return await lifecycleBoundRunArgs(
          { question: prompt },
          signal,
          undefined,
          undefined,
          requesterFinal,
          "native-delegation",
        );
      }
      return await runArgs(
        { question: prompt },
        signal,
        undefined,
        undefined,
        undefined,
        "native-delegation",
      );
    },
    {
      ...lifecycleMethods,
      // The released provider callback is reusable. Providers must explicitly
      // adopt delayed completion claims before the host retains an owner past settlement.
      adoptCompletionClaims: () => {
        completionClaimsAdopted = true;
      },
    },
  );
  return {
    getToolAuthorityOverlay: (currentAuthority = authority, source?: "reply" | "attempt") =>
      getControlAuthority(source, currentAuthority),
    runArgs: (
      args: unknown,
      signal?: AbortSignal,
      assertCurrent?: () => void,
      source?: TalkAgentConsultSource,
    ) => runArgs(args, signal, undefined, undefined, assertCurrent, source),
    runOwnedArgs: lifecycleBoundRunArgs,
    runPrompt,
    runSpeechConsult: async (
      speech: SpeechAgentConsultParams & { speakCommentary?: boolean },
      assertCurrent?: () => void,
    ): Promise<RealtimeVoiceAgentConsultResult> => {
      if (!params.ownerConnId) {
        throw new Error("Speech consultation requires its current Gateway connection");
      }
      // The prepared target, not caller-provided keys, owns consultation and steering.
      if (
        speech.sessionId !== params.getVoiceSessionId() ||
        (speech.requesterSessionKey !== undefined && speech.requesterSessionKey !== canonicalKey)
      ) {
        throw new Error("Speech consultation does not match its prepared Talk target");
      }
      if (promptOwner) {
        throw new Error("A Talk consult is already active");
      }
      assertCurrent?.();
      const revokeControl = () => speech.onRunControl?.(undefined);
      speech.abortSignal?.addEventListener("abort", revokeControl, { once: true });
      let speechOwner: PromptOwner | undefined;
      try {
        const run = runOwnedArgs(
          speech.args,
          speech.abortSignal,
          undefined,
          assertCurrent,
          undefined,
          "native-delegation",
          speech,
        );
        speechOwner = promptOwner;
        const result = await run;
        assertCurrent?.();
        if (promptOwner !== speechOwner || !claimAppend()) {
          throw new Error("Speech consultation completion custody is no longer current");
        }
        return result;
      } catch (error) {
        if (promptOwner === speechOwner) {
          claimFailureAppend();
        }
        throw error;
      } finally {
        speech.abortSignal?.removeEventListener("abort", revokeControl);
        revokeControl();
      }
    },
  };
}
