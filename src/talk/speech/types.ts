import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRuntime, RuntimeLogger } from "../../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import type {
  RealtimeVoiceAgentConsultResult,
  RealtimeVoiceAgentConsultSpeechEvent,
} from "../agent-consult-runtime.js";
import type {
  RealtimeVoiceAgentConsultToolPolicy,
  RealtimeVoiceAgentConsultTranscriptEntry,
} from "../agent-consult-tool.js";
import type {
  RealtimeVoiceAgentControlMode,
  RealtimeVoiceAgentControlResult,
} from "../agent-run-control-shared.js";
import type { ConversationInputScopeV1 } from "../conversation-input.types.js";
import type { ConversationReplyParams, ConversationReplyResult } from "../conversation-reply.js";
import type { RealtimeVoiceToolCallEvent } from "../provider-types.js";
import type { RealtimeVoiceSessionHarness } from "../realtime-session-harness.js";
import type { TalkConnectionPresentation } from "../session-registry.js";
import type { RealtimeVoiceBridgeSession } from "../session-runtime.js";
import type { TalkEvent, TalkEventInput } from "../talk-events.js";
import type { SpeechAudioFormat, SpeechInputAudioFormat } from "./audio-format.js";
import type { PreparedSpeechGreeting } from "./greeting.js";
import type { SpeechPlaybackObservation } from "./playback-observation.js";
import type { SpeechAudioTransport, SpeechAudioTransportHealth } from "./transport.js";
import type { SpeechWaitingAudioConfig } from "./waiting-audio.js";

/** Alternative native realtime-provider strategy under the same speech owner. */
export type SpeechRealtimeSessionConfig = SpeechSessionConfig & {
  strategy: string;
  voiceProvider?: string;
  model?: string;
  instructions?: string;
  introMessage?: string;
  toolPolicy?: RealtimeVoiceAgentConsultToolPolicy;
};
/** Host input identity only; these fields do not themselves grant admission. */
export type SpeechInputIdentity = Pick<ConversationInputScopeV1, "inputId" | "purpose">;

export type SpeechRealtimeToolCallParams = Partial<SpeechInputIdentity> & {
  strategy: string;
  session: RealtimeVoiceBridgeSession;
  event: RealtimeVoiceToolCallEvent;
  sessionId: string;
  requesterSessionKey?: string;
  transcript: RealtimeVoiceAgentConsultTranscriptEntry[];
  onTalkEvent: (event: TalkEventInput) => void;
};
export type SpeechRealtimeSessionHandle = Pick<
  SpeechSessionHandle,
  "providerId" | "speak" | "getHealth" | "stop"
>;

export type SpeechRuntimeSurface = {
  displayName: string;
  logScope: string;
  sessionIdPrefix: string;
};

export type SpeechSessionStartParams = {
  config: SpeechSessionConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  surface: SpeechRuntimeSurface;
  sessionId: string;
  requesterSessionKey?: string;
  ttsContext?: { agentId?: string; channelId?: string; accountId?: string };
  logPrefix?: "node";
  transport: SpeechAudioTransport;
  logger: RuntimeLogger;
  providers?: RealtimeTranscriptionProviderPlugin[];
  signal?: AbortSignal;
  consultAgent: (params: SpeechAgentConsultParams) => Promise<RealtimeVoiceAgentConsultResult>;
  /** V2 hosts dispatch each original input through the native reply/queue owner. */
  nativeInput?: (params: SpeechNativeInputParams) => Promise<ConversationReplyResult>;
  /** Host-only presentation of this exact connection; never input or send authority. */
  connectionPresentation?: Omit<TalkConnectionPresentation, "state">;
  initialGreeting?: PreparedSpeechGreeting;
  /** Optional device presentation hint; never changes turn or media ownership. */
  onTalkEvent?: (event: TalkEvent) => void;
  onActivity?: (activity: "listening" | "sensing" | "hearing" | "processing" | "speaking") => void;
  /** Retain teardown ownership before provider setup can fail. */
  onSession?: (session: SpeechSessionHandle) => void;
};

/** Transport-neutral admission data; browser and channel configuration stays at the edge. */
export type SpeechSessionConfig = {
  audioFormat: SpeechAudioFormat;
  inputAudioFormat?: SpeechInputAudioFormat;
  agentId?: string;
  transcriptionProvider?: string;
  provider?: string;
  providers: Record<string, Record<string, unknown>>;
  responseStreaming?: "off" | "sentence";
  waitingAudio?: SpeechWaitingAudioConfig;
  video?: import("../../config/zod-schema.media-frames.js").SpeechVideoConfig;
};

type SpeechAgentControlOptions = Partial<SpeechInputIdentity> & {
  mode?: RealtimeVoiceAgentControlMode;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  images?: import("../../llm/types.js").ImageContent[];
};
type SpeechAgentRunControl = (
  text: string,
  onQueueAccepted?: (accepted: boolean) => void,
  options?: SpeechAgentControlOptions,
) => Promise<RealtimeVoiceAgentControlResult>;

export type SpeechActiveConsult = {
  control?: SpeechAgentRunControl;
  admissions: Promise<void>;
  adoptedGeneration: number;
  unconfirmed: boolean;
  followupOnly: boolean;
  question: string;
  releaseVideo: Set<() => void>;
};

export type SpeechAgentConsultParams = Partial<SpeechInputIdentity> & {
  sessionId: string;
  requesterSessionKey?: string;
  args: unknown;
  images?: import("../../llm/types.js").ImageContent[];
  toolBindings?: Readonly<Record<string, unknown>>;
  transcript: RealtimeVoiceAgentConsultTranscriptEntry[];
  abortSignal?: AbortSignal;
  onSpeakableText?: (event: RealtimeVoiceAgentConsultSpeechEvent) => void | Promise<void>;
  speechExpressionCaptureOnly?: true;
  speechSegmentationProfile?: import("../../tts/provider-types.js").SpeechSegmentationProfile;
  waitForPendingInput?: (signal?: AbortSignal) => void | Promise<void>;
  /** Host-owned native run observer, never a transport/model-supplied authority. */
  onRunStarted?: ConversationReplyParams["onRunStarted"];
  /** Receipt from the existing native recorder for this exact original input. */
  onOriginalInputCommitted?: ConversationReplyParams["onOriginalInputCommitted"];
  /** Additional host failure fence; never authority or playback lifetime. */
  assertWorkCurrent?: ConversationReplyParams["assertWorkCurrent"];
  /** Exact active native owner; undefined revokes admission. Never replay a queued input. */
  onRunControl?: (control: SpeechAgentRunControl | undefined) => void;
};

export type SpeechNativeInputParams = Omit<SpeechAgentConsultParams, "onSpeakableText"> &
  SpeechInputIdentity & {
    onSpeakableText?: ConversationReplyParams["speech"]["onSpeakableText"];
    /** Original connection-owned playback/onset data; never a user request or work outcome. */
    playbackObservation?: SpeechPlaybackObservation;
    bufferReply: boolean;
    queueMode: "steer" | "followup";
    onNativeRunBound: ConversationReplyParams["onNativeRunBound"];
    onInputDisposition: ConversationReplyParams["onInputDisposition"];
    onQueueAccepted: () => void;
  };

export type SpeechSessionHealth = ReturnType<RealtimeVoiceSessionHarness["getHealth"]> &
  SpeechAudioTransportHealth & { lastClearAt?: string; clearCount?: number; bridgeClosed: boolean };

type SpeechOutputCancellationResult = {
  status: "applied" | "stale" | "idle";
  turnId?: string;
};
export type SpeechSessionHandle = {
  providerId: string;
  speak: (instructions?: string) => void;
  getHealth: () => SpeechSessionHealth;
  stop: () => Promise<void>;
  /** Cancel delivery only; the native agent task and its tool results remain owned by that run. */
  cancelOutput: (params?: { turnId?: string; reason?: string }) => SpeechOutputCancellationResult;
  steer: (
    params: SpeechAgentControlOptions & { text: string },
  ) => Promise<RealtimeVoiceAgentControlResult>;
};

export const SPEECH_AGENT_TRANSCRIPT_DEBOUNCE_MS = 900;
export const SPEECH_OUTPUT_ECHO_SUPPRESSION_TAIL_MS = 3_000;
export const SPEECH_TRANSCRIPT_ECHO_LOOKBACK_MS = 45_000;
