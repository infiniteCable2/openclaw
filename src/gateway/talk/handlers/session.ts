import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkSessionCreateParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import { assertSecretOwnerAvailable } from "../../../secrets/runtime-degraded-state.js";
import { createLazyRuntimeModule } from "../../../shared/lazy-runtime.js";
import { operatorScopeSatisfied } from "../../../shared/operator-scope-compat.js";
import { resolveSessionMethodScope } from "../../../shared/session-method-scopes-base.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../../talk/agent-run-control-shared.js";
import {
  projectInternalRealtimeVoicePublicConfig,
  resolveInternalRealtimeVoiceGatewayRelayLaunchError,
} from "../../../talk/provider-internal.js";
import { resolveConfiguredRealtimeVoiceProviderAsync } from "../../../talk/provider-resolver.js";
import { ADMIN_SCOPE, hasGatewayAdminScope } from "../../operator-scopes.js";
import { readGatewayPairedDeviceProfileBinding } from "../../paired-device-profile.js";
import { gatewayClientSenderFields } from "../../server-methods/gateway-client-identity.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type { GatewayRequestHandlers, RespondFn } from "../../server-methods/types.js";
import { defineValidatedGatewayHandler } from "../../server-methods/validation.js";
import { resolveGatewayInputParticipant } from "../../session-input-participant.js";
import { getSessionRowProjection } from "../../session-row-projection-access.js";
import { withPreparedSessionResolve } from "../../sessions-resolve.js";
import { retainTalkClientRunAuthority } from "../client-run-authority.js";
import { resolveTalkAgentConsultAuthority } from "../client-tool-authority.js";
import { prepareTalkProviderConversationContext } from "../conversation-context.js";
import { createTalkHandoff } from "../handoff.js";
import { createTalkOperatorRunSource } from "../operator-run-source.js";
import { stopTalkRealtimeRelaySession } from "../relay/operations.js";
import { publishTalkRealtimeRelayPresentation } from "../relay/presentation.js";
import { createTalkRealtimeRelaySession } from "../relay/session-create.js";
import { talkRequestError } from "../request-error.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  buildTalkTranscriptionConfig,
  resolveConfiguredRealtimeTranscriptionProvider,
  resolveTalkRealtimeProviderInstructions,
} from "../session-config.js";
import {
  buildTalkRealtimeHistoryInstructions,
  readTalkRealtimeInitialItems,
} from "../session-history.js";
import { ensureGatewayTalkSessionEntry } from "../session-initialization.js";
import { rememberUnifiedTalkSession } from "../session-registry.js";
import { restoreTalkSessionTarget } from "../session-start.js";
import { prepareTalkSessionTarget, requirePreparedTalkSessionTarget } from "../session-target.js";
import { createTalkTranscriptionRelaySession } from "../transcription-relay.js";
import { prepareTalkVoiceReplacement } from "../voice-selection.js";
import { createGatewayVoiceTranscriptAudience } from "../voice-transcript-audience.js";
import { talkSessionInputHandlers } from "./session-input.js";
import { talkSessionLifecycleHandlers } from "./session-lifecycle.js";
import { talkSessionOutputHandlers } from "./session-output.js";

function respondInvalidRequest(respond: RespondFn, message: string) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

const loadSpeechRelay = createLazyRuntimeModule(() => import("../speech-relay.js"));

const talkSessionError = (error: unknown) => talkRequestError(error, "session");

function respondOk(respond: RespondFn, payload: unknown = { ok: true }) {
  respond(true, payload, undefined);
}

export const talkSessionHandlers: GatewayRequestHandlers = {
  ...talkSessionLifecycleHandlers,
  ...talkSessionInputHandlers,
  ...talkSessionOutputHandlers,
  "talk.session.create": defineValidatedGatewayHandler(
    "talk.session.create",
    validateTalkSessionCreateParams,
    async (request) => {
      const {
        params,
        respond,
        context,
        client,
        sessionMutationAuthorization,
        sessionMutationCommitGuard,
        hasCurrentClientAuthority,
      } = request;
      const requester = readGatewayRequestMutationAuthority(request);
      const mode = params.mode ?? (params.transport === "managed-room" ? "stt-tts" : "realtime");
      const transport = params.transport ?? (mode === "stt-tts" ? "managed-room" : "gateway-relay");
      const brain = params.brain ?? (mode === "transcription" ? "none" : "agent-consult");
      if (
        !operatorScopeSatisfied("operator.talk", client?.connect.scopes ?? []) &&
        resolveSessionMethodScope("talk.session.create", params) !== "operator.sessions.write"
      ) {
        respondInvalidRequest(
          respond,
          "Session dictation requires a session target and configured transcription",
        );
        return;
      }

      if (transport === "webrtc" || transport === "provider-websocket") {
        respondInvalidRequest(
          respond,
          `talk.session.create is Gateway-managed; use talk.client.create for client transport "${transport}"`,
        );
        return;
      }
      sessionMutationAuthorization?.assertCurrent();
      if (
        (mode !== "stt-tts" || transport !== "gateway-relay") &&
        params.capabilities?.some((capability) => capability !== "voice-selection")
      ) {
        return respondInvalidRequest(
          respond,
          "Speech media capabilities require an STT/TTS speech relay",
        );
      }
      if (params.voiceChangeId && (mode !== "realtime" || transport !== "gateway-relay")) {
        respondInvalidRequest(respond, "A voice replacement requires a realtime relay session");
        return;
      }
      if (transport === "managed-room") {
        if (brain === "direct-tools" && !hasGatewayAdminScope(client)) {
          respondInvalidRequest(
            respond,
            `talk.session.create brain="direct-tools" requires gateway scope: ${ADMIN_SCOPE}`,
          );
          return;
        }
        const spawnedBy = normalizeOptionalString(params.spawnedBy);
        const requestedSessionKey = normalizeOptionalString(params.sessionKey);
        if (requestedSessionKey && !spawnedBy && !hasGatewayAdminScope(client)) {
          respondInvalidRequest(
            respond,
            `talk.session.create managed-room sessionKey requires spawnedBy or gateway scope: ${ADMIN_SCOPE}`,
          );
          return;
        }
        const target = requestedSessionKey
          ? requirePreparedTalkSessionTarget(sessionMutationAuthorization?.talkSessionTarget)
          : undefined;
        sessionMutationAuthorization?.assertCurrent();
        const projection = getSessionRowProjection(context);
        if (!projection) {
          respondInvalidRequest(respond, "Session rows are initializing; try again");
          return;
        }
        return await withPreparedSessionResolve(
          {
            projection,
            client,
            isCurrent: () => getSessionRowProjection(context) === projection,
            p: {
              key: target?.canonicalKey,
              ...(target ? { agentId: target.agentId } : {}),
              ...(spawnedBy ? { spawnedBy } : {}),
              includeGlobal: true,
              includeUnknown: true,
            },
          },
          (resolvedSession) => {
            if (!resolvedSession.ok) {
              respond(false, undefined, resolvedSession.error);
              return;
            }
            if ("missing" in resolvedSession || "ambiguous" in resolvedSession) {
              respondInvalidRequest(respond, `No session found: ${params.sessionKey}`);
              return;
            }
            sessionMutationCommitGuard?.();
            sessionMutationAuthorization?.assertCurrent();
            const handoff = createTalkHandoff({
              sessionKey: resolvedSession.key,
              provider: normalizeOptionalString(params.provider),
              model: normalizeOptionalString(params.model),
              voice: normalizeOptionalString(params.voice),
              mode,
              transport,
              brain,
              ttlMs: params.ttlMs,
            });
            rememberUnifiedTalkSession(handoff.id, {
              kind: "managed-room",
              handoffId: handoff.id,
              roomId: handoff.roomId,
            });
            return respondOk(respond, {
              sessionId: handoff.id,
              provider: handoff.provider,
              mode: handoff.mode,
              transport: handoff.transport,
              brain: handoff.brain,
              handoffId: handoff.id,
              roomId: handoff.roomId,
              roomUrl: handoff.roomUrl,
              token: handoff.token,
              model: handoff.model,
              voice: handoff.voice,
              expiresAt: handoff.expiresAt,
            });
          },
        );
      }

      const connId = client?.connId;
      if (!connId) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Talk session unavailable"));
        return;
      }

      if (mode === "stt-tts") {
        if (transport !== "gateway-relay" || brain !== "agent-consult") {
          return respondInvalidRequest(
            respond,
            'stt-tts Talk relay requires transport="gateway-relay" and brain="agent-consult"',
          );
        }
        if (
          params.voice ||
          params.voiceChangeId ||
          params.capabilities?.includes("voice-selection")
        ) {
          return respondInvalidRequest(
            respond,
            "Talk speech relay uses the agent's configured TTS voice; realtime voice replacement is not supported",
          );
        }
        const runtimeConfig = context.getRuntimeConfig();
        const target = requirePreparedTalkSessionTarget(
          sessionMutationAuthorization?.talkSessionTarget,
        );
        const assertConnectionCurrent = () => {
          if (!context.getClientConnIds?.((current) => current === client).has(connId)) {
            throw new Error("Talk speech connection is no longer active");
          }
        };
        const assertSourceCurrent = () => {
          sessionMutationCommitGuard?.();
          sessionMutationAuthorization?.assertCurrent();
          assertConnectionCurrent();
        };
        assertSourceCurrent();
        assertSecretOwnerAvailable("capability", "talk:speech");
        const transcriptionConfig = await buildTalkTranscriptionConfig(
          runtimeConfig,
          params.provider,
          params.model,
        );
        if (transcriptionConfig.file) {
          throw new Error("Talk speech relay requires a streaming transcription provider");
        }
        const resolution = await resolveConfiguredRealtimeTranscriptionProvider({
          config: runtimeConfig,
          configuredProviderId: transcriptionConfig.provider,
          providerConfigs: transcriptionConfig.providers,
          requestedModel: normalizeOptionalString(params.model),
          defaultModel: transcriptionConfig.model,
        });
        const ensuredSessionId = await ensureGatewayTalkSessionEntry({
          client,
          context,
          cfg: runtimeConfig,
          target,
          assertCurrent: assertSourceCurrent,
          request,
        });
        const assertCurrent = () => {
          // The guarded ensure may materialize this exact previously absent
          // row. Revalidate its admitted target/id, not the absent snapshot.
          sessionMutationCommitGuard?.();
          sessionMutationAuthorization?.assertTargetCurrent({
            agentId: target.agentId,
            sessionKey: target.canonicalKey,
            ensuredSessionId,
          });
          assertConnectionCurrent();
        };
        assertCurrent();
        const { createTalkSpeechRelaySession } = await loadSpeechRelay();
        assertCurrent();
        const pairedSource = readGatewayPairedDeviceProfileBinding(client);
        pairedSource?.authority.assertCurrent();
        const runAuthority = await retainTalkClientRunAuthority({
          client,
          context,
          hasCurrentClientAuthority,
          session: { target, sessionId: ensuredSessionId },
        });
        let transferred = false;
        try {
          assertCurrent();
          const session = await createTalkSpeechRelaySession({
            context,
            connId,
            cfg: runtimeConfig,
            sessionTarget: target,
            authority: resolveTalkAgentConsultAuthority(client?.connect?.scopes, client),
            captureOperatorAuthority: createTalkOperatorRunSource({ client, context }),
            callerId: gatewayClientSenderFields(client).sender?.id ?? undefined,
            participant: resolveGatewayInputParticipant(client),
            verifiedSource: pairedSource?.identity,
            provider: resolution.provider,
            providerConfig: resolution.providerConfig,
            capabilities: params.capabilities,
            runAuthority,
            assertStartupCurrent: assertCurrent,
            assertCurrent: () => {
              runAuthority.assertCurrent();
              assertConnectionCurrent();
            },
          });
          transferred = true;
          return respondOk(respond, session);
        } finally {
          if (!transferred) {
            runAuthority.release();
          }
        }
      }

      if (mode === "realtime") {
        if (transport !== "gateway-relay" || brain !== "agent-consult") {
          return respondInvalidRequest(
            respond,
            `realtime talk.session.create requires transport="gateway-relay" and brain="agent-consult"`,
          );
        }
        const replacement = prepareTalkVoiceReplacement({
          voiceChangeId: params.voiceChangeId,
          connId,
          sessionKey: params.sessionKey,
        });
        const requested = replacement ? { ...params, ...replacement.launch } : params;
        const runtimeConfig = context.getRuntimeConfig();
        const realtimeConfig = await buildTalkRealtimeConfig(
          runtimeConfig,
          requested.provider,
          requested.model,
        );
        const launchOptions = buildRealtimeVoiceLaunchOptions({
          requested,
          defaults: realtimeConfig,
        });
        const target = requirePreparedTalkSessionTarget(
          sessionMutationAuthorization?.talkSessionTarget,
        );
        replacement?.assertCurrent(target);
        const { agentId } = target;
        const assertCommitAllowed = composeSessionSourceAssertion(
          [sessionMutationCommitGuard, sessionMutationAuthorization?.assertCurrent],
          (assertSources) => {
            assertSources();
            replacement?.assertCurrent(target);
          },
        );
        assertCommitAllowed();
        assertSecretOwnerAvailable("capability", "talk:realtime");
        const resolution = await resolveConfiguredRealtimeVoiceProviderAsync({
          configuredProviderId: realtimeConfig.provider,
          providerConfigs: realtimeConfig.providers,
          providerConfigOverrides: launchOptions.model ? { model: launchOptions.model } : {},
          cfg: runtimeConfig,
          agentId,
          defaultModel: realtimeConfig.model,
          surface: "gateway-relay",
          autoRespondToAudio: realtimeConfig.consultRouting !== "force-agent-consult",
        });
        const forceAgentConsultOnFinalTranscript =
          realtimeConfig.consultRouting === "force-agent-consult";
        const { model: _model, ...overrides } = launchOptions;
        const providerConfig =
          Object.keys(overrides).length > 0
            ? { ...resolution.providerConfig, ...overrides }
            : resolution.providerConfig;
        const launchError = resolveInternalRealtimeVoiceGatewayRelayLaunchError({
          provider: resolution.provider,
          cfg: runtimeConfig,
          providerConfig,
          model: launchOptions.model,
          autoRespondToAudio: !forceAgentConsultOnFinalTranscript,
        });
        if (launchError) {
          // GPT-Live delegates natively; forced transcript consults are a GA-model mode.
          return respondInvalidRequest(respond, launchError);
        }
        const capabilities = resolution.capabilities;
        const controlSource =
          capabilities?.handlesAgentConsult === true ? "delegation" : "transcript";
        const providerInstructions = await resolveTalkRealtimeProviderInstructions({
          config: runtimeConfig,
          agentId,
          configuredInstructions: realtimeConfig.instructions,
          sessionKey: target.canonicalKey,
          warn: (message) => context.logGateway.warn(`talk realtime context: ${message}`),
        });
        assertCommitAllowed();
        await restoreTalkSessionTarget(request, target, replacement?.source(target).assertCurrent);
        const ensuredSessionId = await ensureGatewayTalkSessionEntry({
          client,
          context,
          cfg: runtimeConfig,
          target,
          assertCurrent: assertCommitAllowed,
          request,
        });
        const assertEnsuredTargetCurrent = () => {
          sessionMutationCommitGuard?.();
          sessionMutationAuthorization?.assertTargetCurrent({
            agentId,
            sessionKey: target.canonicalKey,
            ensuredSessionId,
          });
          replacement?.assertCurrent(target);
        };
        const initialItems = replacement
          ? await readTalkRealtimeInitialItems(target, assertEnsuredTargetCurrent)
          : [];
        assertEnsuredTargetCurrent();
        const model =
          normalizeOptionalString(providerConfig.model) ?? resolution.provider.defaultModel;
        const voices = [
          ...(capabilities?.voices ??
            (model ? capabilities?.voicesByModel?.[model] : undefined) ??
            resolution.provider.voices ??
            []),
        ];
        const runAuthority = await retainTalkClientRunAuthority({
          client,
          context,
          hasCurrentClientAuthority,
          session: { target, sessionId: ensuredSessionId },
        });
        let providerContext:
          | Awaited<ReturnType<typeof prepareTalkProviderConversationContext>>
          | undefined;
        let contextTransferred = false;
        let session: ReturnType<typeof createTalkRealtimeRelaySession>;
        try {
          assertEnsuredTargetCurrent();
          providerContext = await prepareTalkProviderConversationContext({
            target,
            agentConsultAvailable:
              capabilities?.supportsToolCalls !== false ||
              capabilities?.handlesAgentConsult === true,
            participant: resolveGatewayInputParticipant(client),
            assertCurrent: () => runAuthority.assertCurrent(),
            getRuntimeConfig: context.getRuntimeConfig,
            captureOperatorAuthority: createTalkOperatorRunSource({ client, context }),
          });
          assertEnsuredTargetCurrent();
          runAuthority.accept();
          providerContext.assertCurrent();
          const startupContext = providerContext;
          session = createTalkRealtimeRelaySession({
            startupContext: {
              ...startupContext,
              // Provider connection may settle after the create RPC has released its guards.
              assertCurrent: () => {
                runAuthority.assertCurrent();
                startupContext.assertCurrent();
              },
            },
            participant: resolveGatewayInputParticipant(client),
            preparePrivateAudience: createGatewayVoiceTranscriptAudience({
              target,
              expectedSessionId: ensuredSessionId,
              client,
              context,
            }),
            runAuthority,
            context,
            connId,
            cfg: runtimeConfig,
            consultAuthority: resolveTalkAgentConsultAuthority(client?.connect?.scopes, client),
            provider: resolution.provider,
            providerConfig,
            controlSource,
            capabilities,
            clientCapabilities: params.capabilities?.filter(
              (capability) => capability === "voice-selection",
            ),
            voiceChangeId: params.voiceChangeId,
            initialItems,
            voiceSelectionVoices: voices,
            instructions:
              (controlSource === "delegation"
                ? (providerInstructions ?? "")
                : buildRealtimeInstructions(providerInstructions)) +
              buildTalkRealtimeHistoryInstructions(initialItems) +
              providerContext.instructions,
            tools:
              controlSource === "delegation"
                ? []
                : [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL],
            model: launchOptions.model,
            sessionTarget: target,
            voice: launchOptions.voice,
            language: params.language,
            forceAgentConsultOnFinalTranscript,
          });
          contextTransferred = true;
        } finally {
          if (!contextTransferred) {
            try {
              await providerContext?.release();
            } finally {
              runAuthority.release();
            }
          }
        }
        rememberUnifiedTalkSession(session.relaySessionId, {
          kind: "realtime-relay",
          connId,
          relaySessionId: session.relaySessionId,
          sessionTarget: target,
        });
        try {
          publishTalkRealtimeRelayPresentation({
            sessionId: session.relaySessionId,
            connId,
            client,
            context,
            hasCurrentClientAuthority,
          });
        } catch (error) {
          await stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId });
          throw error;
        }
        const publicSession = projectInternalRealtimeVoicePublicConfig({
          provider: resolution.provider,
          providerConfig,
          config: session,
        });
        return respondOk(respond, {
          ...publicSession,
          sessionId: session.relaySessionId,
          voiceSessionId: session.relaySessionId,
          mode,
          brain,
        });
      }

      if (mode === "transcription") {
        if (transport !== "gateway-relay" || brain !== "none") {
          respondInvalidRequest(
            respond,
            `transcription talk.session.create requires transport="gateway-relay" and brain="none"`,
          );
          return;
        }
        const runtimeConfig = context.getRuntimeConfig();
        const sessionKey = normalizeOptionalString(params.sessionKey);
        const target =
          sessionMutationAuthorization?.talkSessionTarget ??
          (sessionKey && hasGatewayAdminScope(client)
            ? await prepareTalkSessionTarget(runtimeConfig, sessionKey)
            : undefined);
        if (sessionKey) {
          requirePreparedTalkSessionTarget(target);
        }
        const assertCurrent = () => {
          requester.assertCurrent();
          // Retain the admitted session authority, not only its routing facts:
          // provider callbacks can arrive after deletion, replacement, or revocation.
          sessionMutationAuthorization?.assertCurrent();
          if (target) {
            target.assertCurrent(context.getRuntimeConfig());
          }
        };
        const transcriptionConfig = await buildTalkTranscriptionConfig(
          runtimeConfig,
          params.provider,
          params.model,
          target?.agentId,
        );
        if (transcriptionConfig.file && !transcriptionConfig.file.ready) {
          throw new Error(
            "No configured audio transcription provider is available; check tools.media.models",
          );
        }
        const resolution = transcriptionConfig.file
          ? { file: transcriptionConfig.file }
          : await resolveConfiguredRealtimeTranscriptionProvider({
              config: runtimeConfig,
              configuredProviderId: transcriptionConfig.provider,
              providerConfigs: transcriptionConfig.providers,
              requestedModel: normalizeOptionalString(params.model),
              defaultModel: transcriptionConfig.model,
            });
        assertCurrent();
        const releaseAuthority = sessionMutationAuthorization?.retain?.();
        let session: ReturnType<typeof createTalkTranscriptionRelaySession>;
        try {
          session = createTalkTranscriptionRelaySession({
            context,
            connId,
            assertCurrent,
            releaseAuthority,
            ...(target ? { sessionKey: target.canonicalKey } : {}),
            ...resolution,
          });
        } catch (error) {
          releaseAuthority?.();
          throw error;
        }
        rememberUnifiedTalkSession(session.transcriptionSessionId, {
          kind: "transcription-relay",
          connId,
          transcriptionSessionId: session.transcriptionSessionId,
          ...(target ? { sessionTarget: target } : {}),
        });
        respondOk(respond, {
          ...session,
          sessionId: session.transcriptionSessionId,
          brain,
        });
        return;
      }

      respondInvalidRequest(
        respond,
        `stt-tts talk.session.create requires transport="managed-room"`,
      );
    },
    talkSessionError,
  ),
};
