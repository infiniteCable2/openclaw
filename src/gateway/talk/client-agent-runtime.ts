import type {
  AdmittedRunOperatorAuthority,
  OperationalRunInstanceRef,
} from "../../agents/admitted-run-context.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { drainAgentRunTerminalWrites } from "../../infra/agent-run-terminal-writes.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { getRpcSourceForGateway } from "../../sessions/session-controller.rpc-sources.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import {
  prepareVoiceConversationKnowledge,
  type PreparedVoiceConversationKnowledge,
} from "../../talk/voice-conversation-knowledge.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import { captureGatewayPrivateConversationAudience } from "../session-input-participant.js";
import type { TalkClientRunAuthority } from "./client-run-authority.js";

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

const log = createSubsystemLogger("gateway/talk-agent-runtime");

/** Original Gateway source, not a policy reconstructed from the voice tool allowlist. */
export type TalkOperatorRunSource = (invocation: {
  assertCurrent: () => void;
  signal?: AbortSignal;
}) => Promise<{ authority: AdmittedRunOperatorAuthority; release: () => void } | undefined>;

export function createTalkClientAgentRuntime(params: {
  config: OpenClawConfig;
  getRuntimeConfig?: () => OpenClawConfig;
  participant?: SessionParticipantIdentity;
  getAdditionalSystemPrompt?: () => string | undefined;
  resolveGatewayContext?: GatewayContextResolver;
  rawSourceRef?: string;
  runAuthority?: TalkClientRunAuthority;
  assertCurrent?: () => void;
  bindOperationalRunInstance?: (instance: OperationalRunInstanceRef) => void;
}) {
  const participant = params.participant && Object.freeze({ ...params.participant });
  const agentRuntime = createPluginRuntime().agent;
  if (params.assertCurrent) {
    const assertCurrent = params.assertCurrent;
    const preparePatch = agentRuntime.session.prepareSessionEntryPatch;
    agentRuntime.session.prepareSessionEntryPatch = (request) => {
      const authority = request.authority;
      return preparePatch({
        ...request,
        // Consult metadata commits before backend registration. Carry its live
        // admission through storage preparation to the existing commit guard.
        authority:
          authority?.kind === "host"
            ? {
                kind: "host",
                assertCurrent: () => {
                  assertCurrent();
                  authority.assertCurrent();
                },
              }
            : authority,
      });
    };
  }
  const runEmbeddedAgent: typeof agentRuntime.runEmbeddedAgent = async (requestedParams) => {
    const { agentId, sessionId, sessionKey, storePath } = requestedParams.sessionTarget ?? {};
    if (!agentId || !sessionId || !sessionKey || !storePath) {
      throw new Error("Talk consult requires its prepared transcript target");
    }
    const source = getRpcSourceForGateway(requestedParams.runId, params.resolveGatewayContext);
    params.assertCurrent?.();
    return await withSessionTurn(
      {
        sessionKey,
        sessionId,
        agentId,
        storePath,
        controllerInput: source?.input,
        abortSignal: requestedParams.abortSignal,
      },
      async (_operation, abortSignal) => {
        const runParams = { ...requestedParams, abortSignal };
        runParams.abortSignal?.throwIfAborted();
        const config = runParams.config ?? params.config;
        params.assertCurrent?.();
        const retained = await params.runAuthority?.retainRun(runParams.runId);
        let knowledge: PreparedVoiceConversationKnowledge | undefined;
        try {
          runParams.abortSignal?.throwIfAborted();
          const execution = await loadTalkAgentExecution();
          runParams.abortSignal?.throwIfAborted();
          // Accepted work outlives audio transport; the source and retained run authority govern it.
          if (
            source &&
            getRpcSourceForGateway(runParams.runId, params.resolveGatewayContext) !== source
          ) {
            throw new Error("Talk source changed during runtime preparation");
          }
          const operationalRunInstance = execution.createOperationalRunInstanceRef(runParams.runId);
          retained?.assertSourceCurrent();
          params.bindOperationalRunInstance?.(operationalRunInstance);

          const assertHostCurrent = composeSessionSourceAssertion(
            [retained?.assertSourceCurrent],
            (check) => {
              runParams.abortSignal?.throwIfAborted();
              check();
            },
          );
          const target = { agentId, sessionId, sessionKey, storePath };
          const entry =
            participant?.type === "profile" && retained?.authority
              ? await readSessionEntryReadOnlyInWorker(target)
              : undefined;
          const destinationAudience =
            entry?.sessionId === sessionId && participant?.type === "profile" && retained?.authority
              ? captureGatewayPrivateConversationAudience({
                  agentId,
                  sessionKey,
                  participant,
                  operatorAuthority: retained.authority,
                  entry,
                  assertCurrent: assertHostCurrent,
                })
              : undefined;
          knowledge = await prepareVoiceConversationKnowledge({
            target,
            assertCurrent: assertHostCurrent,
            participant,
            destinationAudience,
            getRuntimeConfig: params.getRuntimeConfig ?? (() => params.config),
            signal: runParams.abortSignal,
          });
          const assertSourceCurrent = composeSessionSourceAssertion([
            assertHostCurrent,
            knowledge?.assertCurrent,
          ]);
          assertSourceCurrent();
          const preparedRunAdmission = execution.prepareAgentRunAdmission({
            cfg: config,
            operationalRunInstance,
            assertSourceCurrent,
            operatorAuthority: retained?.authority,
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
              runtimeContextFragments: [
                ...(runParams.runtimeContextFragments ?? []),
                ...(knowledge?.fragments ?? []),
              ],
              preparedRunAdmission,
              // Speech is mirrored separately. Keep generated input in current-turn custody,
              // but never display it or replay it as a later user request.
              userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
                sessionLifecyclePatch: { lastInteractionAt: Date.now() },
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
                  config,
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
        } finally {
          try {
            await knowledge?.release();
          } catch (error) {
            log.warn("Talk conversation context release failed after accepted work settled.", {
              error: formatErrorMessage(error),
            });
          } finally {
            retained?.release();
          }
        }
      },
    );
  };
  Object.defineProperty(agentRuntime, "runEmbeddedAgent", {
    configurable: true,
    enumerable: true,
    value: runEmbeddedAgent,
  });
  return agentRuntime;
}
