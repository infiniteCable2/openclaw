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
import type { RealtimeVoiceToolCallEvent } from "../provider-types.js";
import type { RealtimeVoiceSessionHarness } from "../realtime-session-harness.js";
import type { RealtimeVoiceBridgeSession } from "../session-runtime.js";
import type { TalkEvent, TalkEventInput } from "../talk-events.js";
import type { SpeechAudioFormat, SpeechInputAudioFormat } from "./audio-format.js";
import type { PreparedSpeechGreeting } from "./greeting.js";
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
export type SpeechRealtimeToolCallParams = {
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
};

type SpeechAgentControlOptions = {
  mode?: RealtimeVoiceAgentControlMode;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
type SpeechAgentRunControl = (
  text: string,
  onQueueAccepted?: (accepted: boolean) => void,
  options?: SpeechAgentControlOptions,
) => Promise<RealtimeVoiceAgentControlResult>;

export type SpeechAgentConsultParams = {
  sessionId: string;
  requesterSessionKey?: string;
  args: unknown;
  transcript: RealtimeVoiceAgentConsultTranscriptEntry[];
  abortSignal?: AbortSignal;
  onSpeakableText?: (event: RealtimeVoiceAgentConsultSpeechEvent) => void | Promise<void>;
  speechExpressionCaptureOnly?: true;
  waitForPendingInput?: (signal?: AbortSignal) => void | Promise<void>;
  /** Exact active native owner; undefined revokes admission. Never replay a queued input. */
  onRunControl?: (control: SpeechAgentRunControl | undefined) => void;
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
