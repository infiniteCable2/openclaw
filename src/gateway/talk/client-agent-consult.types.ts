import type { EmbeddedRunCompletionRegistration } from "../../agents/embedded-agent-runner/run-state.js";
import type { prepareEmbeddedAgentRunCompletionClaim } from "../../agents/embedded-agent-runner/runs.js";
import type { registerRequesterFinalAttachment } from "../../agents/subagents/requester-final-attachment.js";
import type { RealtimeVoiceAgentConsultRunner } from "../../talk/provider-types.js";

export type TalkRequesterFinalBinding = {
  append: (text: string) => boolean;
};

export type TalkAgentConsultRequest = Parameters<RealtimeVoiceAgentConsultRunner>[0] & {
  requesterFinal?: TalkRequesterFinalBinding;
};

export type TalkAgentConsultSource = "tool-call" | "native-delegation";

/** Custody of one admitted consultation, including delayed completion and steering. */
export type TalkAgentConsultPromptOwner = {
  completionClaim?: ReturnType<typeof prepareEmbeddedAgentRunCompletionClaim>;
  cleanup?: () => void;
  identity?: { runId: string; sessionId: string };
  isCurrent?: (sessionId?: string) => boolean;
  lifecycleGeneration: string;
  registered: Promise<EmbeddedRunCompletionRegistration | undefined>;
  requestSignal?: AbortSignal;
  requesterFinal?: TalkRequesterFinalBinding;
  requesterFinalRegistration?: ReturnType<typeof registerRequesterFinalAttachment>;
  resolveRegistration: (registration: EmbeddedRunCompletionRegistration | undefined) => void;
  signal?: AbortSignal;
  voiceSessionId?: string;
  source: TalkAgentConsultSource;
};

export type TalkAgentConsultLifecycleMethods = {
  adoptCompletionClaims?: () => void;
  claimAppend?: () => boolean;
  claimFailureAppend?: () => boolean;
  revokeRequesterFinal?: () => void;
  steer?: RealtimeVoiceAgentConsultRunner;
};

export type LifecycleBoundTalkAgentConsult = ((
  args: unknown,
  signal: AbortSignal,
  ready?: () => Promise<void>,
  assertCurrent?: () => void,
  requesterFinal?: TalkRequesterFinalBinding,
  source?: TalkAgentConsultSource,
) => Promise<{ text: string; yielded?: true }>) &
  TalkAgentConsultLifecycleMethods;

export type ReusableTalkAgentConsult = (
  args: unknown,
  signal: AbortSignal,
  assertCurrent?: () => void,
  source?: TalkAgentConsultSource,
) => Promise<{ text: string }>;
