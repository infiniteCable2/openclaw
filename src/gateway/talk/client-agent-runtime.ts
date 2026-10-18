import type {
  AdmittedRunOperatorAuthority,
  OperationalRunInstanceRef,
} from "../../agents/admitted-run-context.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import {
  composeSessionSourceAssertion,
  createDynamicSessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { drainAgentRunTerminalWrites } from "../../infra/agent-run-terminal-writes.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import {
  prepareVoiceConversationKnowledge,
  type PreparedVoiceConversationKnowledge,
} from "../../talk/voice-conversation-knowledge.js";

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
  rawSourceRef?: string;
  assertCurrent?: () => void;
  captureOperatorAuthority?: TalkOperatorRunSource;
  participant?: SessionParticipantIdentity;
  getAdditionalSystemPrompt?: () => string | undefined;
  bindOperationalRunInstance?: (instance: OperationalRunInstanceRef) => void;
}) {
  const participant = params.participant && Object.freeze({ ...params.participant });
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
    const assertHostCurrent = composeSessionSourceAssertion(
      [params.assertCurrent],
      (assertSources) => {
        runParams.abortSignal?.throwIfAborted();
        assertSources();
      },
    );
    let knowledge: PreparedVoiceConversationKnowledge | undefined;
    const assertKnowledgeCurrent = createDynamicSessionSourceAssertion(
      () => knowledge?.assertCurrent,
      () => {
        throw new Error("Talk consult knowledge source changed");
      },
    );
    const assertSourceCurrent = composeSessionSourceAssertion([
      assertHostCurrent,
      assertKnowledgeCurrent,
    ]);
    let operatorSource: Awaited<ReturnType<TalkOperatorRunSource>>;
    let preparedRunAdmission: ReturnType<typeof execution.prepareAgentRunAdmission> | undefined;
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        preparedRunAdmission?.close();
      }
    };
    // Abort owns authority revocation independently of core completion; the
    // post-registration check closes the prepare-to-listener race.
    try {
      assertSourceCurrent();
      operatorSource = await params.captureOperatorAuthority?.({
        assertCurrent: assertHostCurrent,
        signal: runParams.abortSignal,
      });
      assertSourceCurrent();
      knowledge = await prepareVoiceConversationKnowledge({
        target: { agentId, sessionId, sessionKey, storePath },
        assertCurrent: assertHostCurrent,
        participant,
        getRuntimeConfig: params.getRuntimeConfig ?? (() => params.config),
        signal: runParams.abortSignal,
      });
      assertSourceCurrent();
      preparedRunAdmission = execution.prepareAgentRunAdmission({
        cfg: params.config,
        operationalRunInstance,
        assertSourceCurrent,
        operatorAuthority: operatorSource?.authority,
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
      runParams.abortSignal?.addEventListener("abort", close, { once: true });
      assertSourceCurrent();
      // Provider-owned work can outlive or replace its audio transport. Unlike
      // chat-backed Talk, it has no independent Chat terminal delivery; hiding
      // its final transcript would lose the answer when no spoken replacement arrives.
      return await execution.runEmbeddedAgent({
        ...runParams,
        extraSystemPrompt: [runParams.extraSystemPrompt, params.getAdditionalSystemPrompt?.()]
          .filter(Boolean)
          .join("\n\n"),
        preparedRunAdmission,
        runtimeContextFragments: [
          ...(runParams.runtimeContextFragments ?? []),
          ...(knowledge?.fragments ?? []),
        ],
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
        if (preparedRunAdmission) {
          await drainAgentRunTerminalWrites(operationalRunInstance);
        }
      } finally {
        runParams.abortSignal?.removeEventListener("abort", close);
        try {
          close();
        } finally {
          try {
            await knowledge?.release();
          } catch (error) {
            log.warn("Talk conversation context release failed after accepted work settled.", {
              error: formatErrorMessage(error),
            });
          } finally {
            operatorSource?.release();
          }
        }
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
