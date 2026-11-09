import type { TalkProviderConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ResolvedTtsPersona, TtsModelOverrideConfig } from "../config/types.tts.js";
import type { SpeechExpression } from "../llm/types.js";
import type {
  SpeechProviderConfig,
  SpeechProviderId,
  SpeechProviderOverrides,
  SpeechSynthesisTarget,
} from "./tts-runtime-types.js";
export type { SpeechExpression } from "../llm/types.js";

/** Admitted, provider/model-specific presentation vocabulary, not a markup dialect. */
export type SpeechExpressionCapabilities = {
  emotions: readonly string[];
  vocalEvents: readonly string[];
  emphasis: boolean;
  whisper: boolean;
};

/** Model-owned synthesis budgets, admitted with the selected worker generation. */
export type SpeechSegmentationProfile = {
  minChars: number;
  targetWords: number;
  maxWords: number;
  maxChars: number;
  pauses: { paragraph: number; sentence: number; clause: number; fragment: number };
};

/** Native source slices; adapters must not normalize or independently split them again. */
export type SpeechSynthesisSegment = { text: string; pauseMs: number };

/** Policy controlling which [[tts:*]] directive fields can affect synthesis. */
export type SpeechModelOverridePolicy = {
  [Key in keyof TtsModelOverrideConfig]-?: Exclude<TtsModelOverrideConfig[Key], undefined>;
};

/** Context for checking whether a provider has enough config to synthesize. */
export type SpeechProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  timeoutMs: number;
};

/** Request for buffered speech synthesis. */
export type SpeechSynthesisRequest = {
  text: string;
  expression?: SpeechExpression;
  segments?: readonly SpeechSynthesisSegment[];
  cfg: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  target: SpeechSynthesisTarget;
  providerOverrides?: SpeechProviderOverrides;
  timeoutMs: number;
  /** Caller-owned task/tool cancellation, independent of worker readiness. */
  signal?: AbortSignal;
  localServiceAdmission?: import("../agents/provider-local-service-target.js").ProviderLocalServiceLease["admission"];
};

export type SpeechSynthesisStreamRequest = SpeechSynthesisRequest;

/** Telephony synthesis request for provider output that needs a fixed sample rate. */
export type SpeechTelephonySynthesisRequest = Omit<SpeechSynthesisRequest, "target">;

/** Streaming telephony synthesis request with caller-owned cancellation. */
export type SpeechTelephonySynthesisStreamRequest = SpeechTelephonySynthesisRequest & {
  signal?: AbortSignal;
};

/** Provider hook input for applying persona/config before synthesis. */
export type SpeechProviderPrepareSynthesisContext = SpeechSynthesisRequest & {
  persona?: ResolvedTtsPersona;
  personaProviderConfig?: SpeechProviderConfig;
};

/** Provider voice-listing request with optional direct auth/URL overrides. */
export type SpeechListVoicesRequest = {
  cfg?: OpenClawConfig;
  providerConfig?: SpeechProviderConfig;
  apiKey?: string;
  baseUrl?: string;
  /** Core-resolved request timeout after config and provider defaults. */
  timeoutMs?: number;
};

/** Provider hook input for resolving normalized config from raw OpenClaw config. */
export type SpeechProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: Record<string, unknown>;
  timeoutMs: number;
};

/** One parsed directive key/value plus current provider override state. */
export type SpeechDirectiveTokenParseContext = {
  key: string;
  value: string;
  policy: SpeechModelOverridePolicy;
  selectedProvider?: SpeechProviderId;
  providerConfig?: SpeechProviderConfig;
  currentOverrides?: SpeechProviderOverrides;
};

/** Provider hook input for resolving talk-command speech config. */
export type SpeechProviderResolveTalkConfigContext = {
  cfg: OpenClawConfig;
  baseTtsConfig: Record<string, unknown>;
  talkProviderConfig: TalkProviderConfig;
  timeoutMs: number;
};

/** Provider hook input for per-call talk-command overrides. */
export type SpeechProviderResolveTalkOverridesContext = {
  talkProviderConfig: TalkProviderConfig;
  params: Record<string, unknown>;
};
