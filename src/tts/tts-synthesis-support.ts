import type { Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString as readTtsResultString } from "@openclaw/normalization-core/string-coerce";
import { createRuntimeConfigReader } from "../config/runtime-snapshot.js";
import type { OpenClawConfig, ResolvedTtsPersona, TtsProvider } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { redactSensitiveText } from "../logging/redact.js";
import {
  acquirePluginCapabilityProviders,
  finishCapabilityOperation,
} from "../plugins/capability-provider-acquisition.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import {
  assertSpeechExpressionSupported,
  isSpeechExpressionEnabled,
  parseSpeechExpression,
} from "./expression.js";
import type { MessageSpeechAdmission } from "./message-speech-admission.js";
import {
  createSpeechProviderRegistry,
  normalizeSpeechProviderId,
} from "./provider-registry-core.js";
import type {
  SpeechExpression,
  SpeechExpressionCapabilities,
  SpeechSegmentationProfile,
  SpeechProviderOverrides,
  SpeechProviderPrepareSynthesisContext,
  SpeechSynthesisRequest,
  SpeechSynthesisTarget,
} from "./provider-types.js";
import { assertSpeechSegmentationProfile, prepareSpeechSegments } from "./speech-segmentation.js";
import { acquireSpeechProviderLocalService } from "./tts-local-service.js";
import {
  resolvePersonaProviderConfig,
  resolvePrimaryTtsProviderCandidate,
  resolveReadySpeechProvider,
  resolveSpeechProviderTimeoutMs,
  resolveTtsProvider,
  resolveTtsProviderCandidates,
  type TtsProviderRegistry,
  type TtsProviderReadyResolution,
} from "./tts-provider-resolution.js";
import type { TtsProviderAttempt } from "./tts-runtime-types.js";
import {
  readTtsPrefs,
  normalizeConfiguredSpeechProviderId,
  resolveTtsPersonaFromPrefs,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsRuntimeConfig,
  type ResolvedTtsConfig,
} from "./tts-settings.js";
import type { VoiceProviderCandidate } from "./voice-models.js";

// The transport names its abort "TimeoutError" (fetch-timeout.ts) and provider
// deadlines throw plain Errors ending in "timed out"; AbortError alone misses both.
function isTtsTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.name === "AbortError" || err.name === "TimeoutError" || /\btimed out\b/iu.test(err.message)
  );
}

export function formatTtsProviderError(provider: TtsProvider, err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err));
  if (isTtsTimeoutError(error)) {
    return `${provider}: request timed out`;
  }
  return `${provider}: ${redactSensitiveText(error.message)}`;
}

export function sanitizeTtsErrorForLog(err: unknown): string {
  const raw = formatErrorMessage(err);
  return redactSensitiveText(raw).replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/** Projection diagnostics remain primary when releasing an already-created synthesis also fails. */
export async function throwTtsProjectionError(
  error: unknown,
  cleanup: () => void | Promise<void>,
): Promise<never> {
  const [result] = await Promise.allSettled([Promise.resolve().then(cleanup)]);
  if (result.status === "rejected") {
    throw new AggregateError([error, result.reason], formatErrorMessage(error), { cause: error });
  }
  throw error;
}

type TtsRequestSetupParams = {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  providerOverride?: TtsProvider;
  disableFallback?: boolean;
  agentId?: string;
  channelId?: string;
  accountId?: string;
};

type TtsRequestSetup = {
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  persona?: ResolvedTtsPersona;
  speechContext: { agentId?: string; channelId?: string };
  providers: VoiceProviderCandidate[];
  prepareProviderRegistry: () => Promise<TtsProviderRegistry>;
};

type AcquiredTtsRequest =
  | { error: string }
  | ({ setup: TtsRequestSetup } & Pick<
      Awaited<ReturnType<typeof acquirePluginCapabilityProviders<"speechProviders">>>,
      "run" | "release"
    >);

/** Keeps catalog and direct lookup selections in one explicit speech request owner. */
export async function acquireTtsRequest(
  params: TtsRequestSetupParams,
): Promise<AcquiredTtsRequest> {
  const cfg = resolveTtsRuntimeConfig(params.cfg);
  const config = resolveTtsConfig(cfg, {
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  if (params.text.length > config.maxTextLength) {
    return {
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }
  // Bind before provider work can reload the snapshot; fallback follows a known runtime
  // owner without letting an unrelated global snapshot replace explicit scoped config.
  const readRuntimeConfig = createRuntimeConfigReader(cfg);
  const prefs = readTtsPrefs(prefsPath);
  const persona = resolveTtsPersonaFromPrefs(config, prefs);
  const queries = await acquirePluginCapabilityProviders({ key: "speechProviders", cfg });
  try {
    const setup = await queries.run(async () => {
      const catalog = queries.providers;
      const defaultLookups = new Map<string, SpeechProviderPlugin | undefined>();
      let defaultCatalog: SpeechProviderPlugin[] = [];
      const preferred = normalizeSpeechProviderId(prefs.tts?.provider);
      if (preferred) {
        const provider = await queries.resolveProvider({ providerId: preferred });
        defaultLookups.set(preferred, provider);
        if (!provider) {
          defaultCatalog = await queries.resolveProviders({});
        }
      }
      const defaults = createSpeechProviderRegistry({
        getProvider: (providerId) => defaultLookups.get(providerId),
        listProviders: () => defaultCatalog,
      });
      const preferredProvider =
        defaults.canonicalizeSpeechProviderId(prefs.tts?.provider) ??
        normalizeConfiguredSpeechProviderId(prefs.tts?.provider);
      const overrideProvider = normalizeSpeechProviderId(params.providerOverride);
      const requestedInputs = [
        overrideProvider,
        !overrideProvider ? preferredProvider : undefined,
        !preferredProvider ? persona?.provider : undefined,
        !overrideProvider && !preferredProvider ? config.provider : undefined,
        ...catalog.map((provider) => provider.id),
      ];
      const prepareView = async (
        queryConfig: OpenClawConfig,
        providers: SpeechProviderPlugin[],
      ) => {
        const lookups = new Map<string, SpeechProviderPlugin | undefined>();
        const requested = new Set(
          [...requestedInputs, ...providers.map((provider) => provider.id)].flatMap((id) => {
            const normalized = normalizeSpeechProviderId(id);
            return normalized ? [normalized] : [];
          }),
        );
        for (const providerId of requested) {
          const provider = await queries.resolveProvider({ providerId, cfg: queryConfig });
          lookups.set(providerId, provider);
          const canonical = normalizeSpeechProviderId(provider?.id);
          if (canonical) {
            requested.add(canonical);
          }
        }
        return createSpeechProviderRegistry({
          getProvider: (providerId) => lookups.get(providerId),
          listProviders: () => providers,
        });
      };
      const prepareProviderRegistry = async (): Promise<TtsProviderRegistry> => {
        const inputView = await prepareView(cfg, await queries.resolveProviders({ cfg }));
        const runtimeConfig = readRuntimeConfig();
        const runtimeView =
          runtimeConfig === cfg
            ? inputView
            : await prepareView(
                runtimeConfig,
                await queries.resolveProviders({ cfg: runtimeConfig }),
              );
        // Policy helpers use the request config or the applicable config prepared for this phase.
        const selectRegistry = (queryConfig: OpenClawConfig | undefined) => {
          if (queryConfig === undefined) {
            return defaults;
          }
          return queryConfig === cfg ? inputView : runtimeView;
        };
        return {
          runtimeConfig,
          getSpeechProvider: (id, queryConfig) => selectRegistry(queryConfig).getSpeechProvider(id),
          canonicalizeSpeechProviderId: (id, queryConfig) =>
            selectRegistry(queryConfig).canonicalizeSpeechProviderId(id),
          listSpeechProviders: (queryConfig) => selectRegistry(queryConfig).listSpeechProviders(),
        };
      };
      const providerRegistry = await prepareProviderRegistry();
      const userProvider = resolveTtsProvider(config, prefsPath, providerRegistry, prefs);
      const provider =
        providerRegistry.canonicalizeSpeechProviderId(params.providerOverride, cfg) ?? userProvider;
      return {
        cfg,
        config,
        persona,
        speechContext: { agentId: params.agentId, channelId: params.channelId },
        providers: params.disableFallback
          ? [resolvePrimaryTtsProviderCandidate(provider, cfg, providerRegistry)]
          : resolveTtsProviderCandidates(provider, cfg, providerRegistry),
        prepareProviderRegistry,
      };
    });
    return { setup, run: queries.run, release: queries.release };
  } catch (error) {
    return await finishCapabilityOperation<never>({ ok: false, error }, queries.release);
  }
}

/** Finite speech calls finish their work before returning a materialized result. */
export async function withOwnedTtsRequest<T>(
  params: TtsRequestSetupParams,
  run: (setup: TtsRequestSetup | { error: string }) => T | Promise<T>,
): Promise<T> {
  const acquired = await acquireTtsRequest(params);
  if ("error" in acquired) {
    return await run(acquired);
  }
  let outcome: Result<T, unknown>;
  try {
    outcome = { ok: true, value: await acquired.run(() => run(acquired.setup)) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  return await finishCapabilityOperation(outcome, acquired.release);
}

type ReadySpeechProvider = Extract<TtsProviderReadyResolution, { kind: "ready" }>;
type TtsProviderOperation<TSynthesis> =
  | {
      kind: "ready";
      synthesize: (
        request: SpeechSynthesisRequest,
        lifecycle: {
          retainLocalService: () => { release: () => void } | undefined;
          expressionCapabilities?: SpeechExpressionCapabilities;
          segmentationProfile?: SpeechSegmentationProfile;
        },
      ) => Promise<TSynthesis>;
      cleanupFailedProjection?: (synthesis: TSynthesis) => Promise<void>;
    }
  | {
      kind: "skip";
      reasonCode: TtsProviderAttempt["reasonCode"];
      message: string;
    };
type TtsProviderSuccess<TSynthesis> = {
  synthesis: TSynthesis;
  latencyMs: number;
  provider: string;
  providerModel?: string;
  providerVoice?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders: string[];
  attempts: TtsProviderAttempt[];
};

export async function executeTtsProviderAttempts<TSynthesis, TResult>(params: {
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  persona?: ResolvedTtsPersona;
  providers: VoiceProviderCandidate[];
  synthesisText: string;
  expression?: SpeechExpression;
  speechContext?: { agentId?: string; channelId?: string };
  providerOverrides?: Record<string, SpeechProviderOverrides>;
  timeoutMs?: number;
  signal?: AbortSignal;
  target: SpeechSynthesisTarget;
  localServiceAdmission?: SpeechSynthesisRequest["localServiceAdmission"];
  expectedSpeechSelection?: MessageSpeechAdmission["expectedSpeechSelection"];
  logLabel: string;
  requireStreamingTelephony?: boolean;
  prepareSynthesis?: boolean;
  /** Exact expressive readiness intent; ordinary synthesis must keep capability hooks cold. */
  prepareExpressionCapabilities?: boolean;
  prepareProviderRegistry: () => Promise<TtsProviderRegistry>;
  selectOperation: (params: {
    provider: TtsProvider;
    resolvedProvider: ReadySpeechProvider;
  }) => TtsProviderOperation<TSynthesis>;
  buildSuccess: (params: TtsProviderSuccess<TSynthesis>) => TResult;
}) {
  const { cfg, config, persona, providers } = params;
  const prepareExpressionCapabilities =
    params.expression !== undefined || params.prepareExpressionCapabilities === true;
  const errors: string[] = [];
  const attemptedProviders: string[] = [];
  const attempts: TtsProviderAttempt[] = [];
  const primaryProvider = providers[0]?.provider;
  const recordSkipped = (
    provider: TtsProvider,
    skipped: Extract<TtsProviderOperation<TSynthesis>, { kind: "skip" }>,
    binding: Pick<TtsProviderAttempt, "personaBinding">,
  ) => {
    errors.push(skipped.message);
    attempts.push({
      provider,
      outcome: "skipped",
      reasonCode: skipped.reasonCode,
      persona: persona?.id,
      ...binding,
      error: skipped.message,
    });
    logVerbose(`${params.logLabel}: provider ${provider} skipped (${skipped.message})`);
  };
  logVerbose(
    `${params.logLabel}: starting with provider ${primaryProvider}, fallbacks: ${
      providers
        .slice(1)
        .map((entry) => entry.provider)
        .join(", ") || "none"
    }`,
  );

  for (const { provider, voiceModel } of providers) {
    params.signal?.throwIfAborted();
    attemptedProviders.push(provider);
    const providerStart = Date.now();
    try {
      const providerRegistry = await params.prepareProviderRegistry();
      params.signal?.throwIfAborted();
      const resolvedProvider = resolveReadySpeechProvider({
        provider,
        cfg,
        config,
        persona,
        voiceModel,
        target: params.target,
        requireStreamingTelephony: params.requireStreamingTelephony,
        providerRegistry,
      });
      if (resolvedProvider.kind === "skip") {
        recordSkipped(
          provider,
          resolvedProvider,
          resolvedProvider.personaBinding
            ? { personaBinding: resolvedProvider.personaBinding }
            : {},
        );
        continue;
      }

      const providerOverrides = params.providerOverrides?.[resolvedProvider.provider.id];
      if (
        params.expectedSpeechSelection &&
        resolvedProvider.provider.id !== params.expectedSpeechSelection.provider
      ) {
        throw new Error("Selected speech provider changed after native expression admission");
      }
      if (params.expression) {
        if (!isSpeechExpressionEnabled({ cfg, ...params.speechContext, target: params.target })) {
          throw new Error(
            "Speech expressions are disabled for this exact agent, channel and target",
          );
        }
        parseSpeechExpression(params.expression, params.synthesisText);
        if (!resolvedProvider.provider.prepareExpressionCapabilities) {
          assertSpeechExpressionSupported(
            params.expression,
            resolvedProvider.provider.getExpressionCapabilities?.({
              providerConfig: resolvedProvider.providerConfig,
              providerOverrides,
            }),
          );
        }
      }

      const operation = params.selectOperation({ provider, resolvedProvider });
      if (operation.kind === "skip") {
        recordSkipped(provider, operation, { personaBinding: resolvedProvider.personaBinding });
        continue;
      }

      const timeoutMs = resolveSpeechProviderTimeoutMs({
        timeoutMs: params.timeoutMs ?? voiceModel?.timeoutMs,
        config,
        provider: resolvedProvider.provider,
      });
      const localServiceLease = await acquireSpeechProviderLocalService({
        providerId: resolvedProvider.provider.id,
        providerConfig: resolvedProvider.localServiceProviderConfig,
        signal: params.signal,
      });
      let localServiceLeaseTransferred = false;
      let localServiceLeaseRetained = false;
      let localServiceLeaseReleased = false;
      const releaseLocalService = () => {
        if (!localServiceLeaseReleased) {
          localServiceLeaseReleased = true;
          localServiceLease?.release();
        }
      };
      try {
        params.signal?.throwIfAborted();
        if (params.expression && params.localServiceAdmission) {
          params.localServiceAdmission.signal.throwIfAborted();
          if (
            params.localServiceAdmission.generation !== localServiceLease?.admission?.generation
          ) {
            const error = new Error(
              "Speech worker generation changed after speech context admission",
            );
            error.name = "LocalServiceAdmissionError";
            throw error;
          }
        }
        const prepared =
          params.prepareSynthesis === false && !resolvedProvider.provider.getSegmentationProfile
            ? {
                text: params.synthesisText,
                providerConfig: resolvedProvider.providerConfig,
                providerOverrides,
              }
            : await prepareSpeechSynthesis(resolvedProvider.provider, {
                text: params.synthesisText,
                cfg,
                providerConfig: resolvedProvider.providerConfig,
                providerOverrides,
                ...(params.expression ? { expression: params.expression } : {}),
                persona: resolvedProvider.synthesisPersona,
                personaProviderConfig: resolvedProvider.personaProviderConfig,
                target: params.target,
                timeoutMs,
                signal: params.signal,
                localServiceAdmission: localServiceLease?.admission,
              });
        // Preparation may select a different model, but cannot borrow readiness from another endpoint.
        if (
          ((prepareExpressionCapabilities &&
            resolvedProvider.provider.prepareExpressionCapabilities) ||
            resolvedProvider.provider.prepareSegmentationProfile) &&
          localServiceLease?.admission &&
          prepared.providerConfig.baseUrl !== resolvedProvider.localServiceProviderConfig.baseUrl
        ) {
          throw new Error("Speech preparation changed the admitted local service endpoint");
        }
        params.signal?.throwIfAborted();
        localServiceLease?.admission?.signal.throwIfAborted();
        const expectedSelection = params.expectedSpeechSelection;
        // The native directive owner has already applied allowVoice before selecting
        // these per-request overrides. Its explicit voice wins over readiness's default;
        // provider/model/capability/worker checks still bind this expressive utterance.
        const hasExplicitVoiceOverride =
          resolveTtsResultDetail({ providerConfig: {}, providerOverrides }, [
            "speakerVoiceId",
            "speakerVoice",
            "voiceId",
            "voiceName",
            "voice",
          ]) !== undefined;
        if (
          expectedSelection &&
          ((expectedSelection.model !== undefined &&
            resolveTtsResultDetail(prepared, ["modelId", "model"]) !== expectedSelection.model) ||
            (!hasExplicitVoiceOverride &&
              expectedSelection.voice !== undefined &&
              resolveTtsResultDetail(prepared, [
                "speakerVoiceId",
                "speakerVoice",
                "voiceId",
                "voiceName",
                "voice",
              ]) !== expectedSelection.voice))
        ) {
          throw new Error(
            "Selected speech model or voice changed after native expression admission",
          );
        }
        if (prepareExpressionCapabilities) {
          await resolvedProvider.provider.prepareExpressionCapabilities?.({
            providerConfig: prepared.providerConfig,
            providerOverrides: prepared.providerOverrides,
            timeoutMs,
            signal: params.signal,
            localServiceAdmission: localServiceLease?.admission,
          });
        }
        params.signal?.throwIfAborted();
        localServiceLease?.admission?.signal.throwIfAborted();
        const expressionCapabilities = prepareExpressionCapabilities
          ? resolvedProvider.provider.getExpressionCapabilities?.({
              providerConfig: prepared.providerConfig,
              providerOverrides: prepared.providerOverrides,
              localServiceAdmission: localServiceLease?.admission,
            })
          : undefined;
        await resolvedProvider.provider.prepareSegmentationProfile?.({
          providerConfig: prepared.providerConfig,
          providerOverrides: prepared.providerOverrides,
          timeoutMs,
          signal: params.signal,
          localServiceAdmission: localServiceLease?.admission,
        });
        params.signal?.throwIfAborted();
        localServiceLease?.admission?.signal.throwIfAborted();
        const segmentationProfile = resolvedProvider.provider.getSegmentationProfile?.({
          providerConfig: prepared.providerConfig,
          providerOverrides: prepared.providerOverrides,
          localServiceAdmission: localServiceLease?.admission,
        });
        if (resolvedProvider.provider.prepareSegmentationProfile && !segmentationProfile) {
          throw new Error("Speech segmentation budgets were not admitted for the selected worker");
        }
        if (segmentationProfile) {
          assertSpeechSegmentationProfile(segmentationProfile);
        }
        if (params.expression) {
          params.localServiceAdmission?.signal.throwIfAborted();
        }
        if (params.expression) {
          // Provider preparation must not detach expression spans from their admitted plain text.
          parseSpeechExpression(params.expression, prepared.text);
          assertSpeechExpressionSupported(params.expression, expressionCapabilities);
        }
        const synthesis = await operation.synthesize(
          {
            ...prepared,
            ...(segmentationProfile && prepared.text.trim()
              ? {
                  segments: prepareSpeechSegments(
                    prepared.text,
                    segmentationProfile,
                    params.expression,
                  ),
                }
              : {}),
            ...(params.expression ? { expression: params.expression } : {}),
            cfg,
            target: params.target,
            timeoutMs,
            signal: params.signal,
            localServiceAdmission: localServiceLease?.admission,
          },
          {
            expressionCapabilities,
            segmentationProfile,
            retainLocalService: () => {
              if (!localServiceLease) {
                return undefined;
              }
              localServiceLeaseRetained = true;
              return { release: releaseLocalService };
            },
          },
        );
        try {
          params.signal?.throwIfAborted();
          localServiceLease?.admission?.signal.throwIfAborted();
          if (params.expression) {
            params.localServiceAdmission?.signal.throwIfAborted();
          }
          const latencyMs = Date.now() - providerStart;
          attempts.push({
            provider,
            outcome: "success",
            reasonCode: "success",
            persona: persona?.id,
            personaBinding: resolvedProvider.personaBinding,
            latencyMs,
          });
          const result = params.buildSuccess({
            synthesis,
            latencyMs,
            provider,
            providerModel: resolveTtsResultDetail(prepared, ["modelId", "model"]),
            providerVoice: resolveTtsResultDetail(prepared, [
              "speakerVoiceId",
              "speakerVoice",
              "voiceId",
              "voiceName",
              "voice",
            ]),
            persona: persona?.id,
            fallbackFrom: provider !== primaryProvider ? primaryProvider : undefined,
            attemptedProviders,
            attempts,
          });
          localServiceLeaseTransferred = localServiceLeaseRetained;
          return result;
        } catch (error) {
          return await throwTtsProjectionError(error, () =>
            operation.cleanupFailedProjection?.(synthesis),
          );
        }
      } finally {
        if (!localServiceLeaseTransferred) {
          releaseLocalService();
        }
      }
    } catch (err) {
      // Caller cancellation ends the owned request, never another provider attempt.
      params.signal?.throwIfAborted();
      const errorMsg = formatTtsProviderError(provider, err);
      const latencyMs = Date.now() - providerStart;
      errors.push(errorMsg);
      attempts.push({
        provider,
        outcome: "failed",
        reasonCode: isTtsTimeoutError(err) ? "timeout" : "provider_error",
        latencyMs,
        persona: persona?.id,
        personaBinding: resolvePersonaBinding(persona, provider),
        error: errorMsg,
      });
      const rawError = sanitizeTtsErrorForLog(err);
      // A generation conflict must not reroute an expressive utterance to another worker/provider.
      if (params.expression && err instanceof Error && err.name === "LocalServiceAdmissionError") {
        break;
      }
      if (provider === primaryProvider) {
        const hasFallbacks = providers.length > 1;
        logVerbose(
          `${params.logLabel}: primary provider ${provider} failed (${rawError})${hasFallbacks ? "; trying fallback providers." : "; no fallback providers configured."}`,
        );
      } else {
        logVerbose(`${params.logLabel}: ${provider} failed (${rawError}); trying next provider.`);
      }
    }
  }

  return {
    success: false as const,
    error: `TTS conversion failed: ${errors.join("; ") || "no providers available"}`,
    attemptedProviders,
    attempts,
    persona: persona?.id,
  };
}

async function prepareSpeechSynthesis(
  provider: SpeechProviderPlugin,
  request: SpeechProviderPrepareSynthesisContext,
) {
  const overrides = await provider.prepareSynthesis?.({ ...request });
  return {
    text: overrides?.text ?? request.text,
    providerConfig: overrides?.providerConfig
      ? { ...request.providerConfig, ...overrides.providerConfig }
      : request.providerConfig,
    providerOverrides: overrides?.providerOverrides
      ? { ...request.providerOverrides, ...overrides.providerOverrides }
      : request.providerOverrides,
  };
}

function resolveTtsResultDetail(
  prepared: Pick<SpeechSynthesisRequest, "providerConfig" | "providerOverrides">,
  keys: readonly string[],
): string | undefined {
  for (const config of [prepared.providerOverrides, prepared.providerConfig]) {
    for (const key of keys) {
      const value = readTtsResultString(config?.[key]);
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

function resolvePersonaBinding(
  persona: ResolvedTtsPersona | undefined,
  provider: string,
): "applied" | "missing" | "none" {
  return resolvePersonaProviderConfig(persona, provider) != null
    ? "applied"
    : persona
      ? "missing"
      : "none";
}
