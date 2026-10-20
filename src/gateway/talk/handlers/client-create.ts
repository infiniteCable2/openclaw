import { randomUUID } from "node:crypto";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkClientCreateParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { resolveAgentConversationMode } from "../../../config/agent-conversation-mode.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../../config/sessions/session-source-authority.js";
import { assertSecretOwnerAvailable } from "../../../secrets/runtime-degraded-state.js";
import type { ConversationPrivateAudience } from "../../../sessions/conversation-private-audience.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../../talk/agent-run-control-shared.js";
import { withClientVoiceSessionSettlement } from "../../../talk/client-voice-session-lifecycle.js";
import {
  captureClientVoiceSessionSource,
  type ClientVoiceSessionSource,
} from "../../../talk/client-voice-session-source.js";
import {
  appendClientVoiceTranscript,
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
  flushClientVoiceSessionWrites,
} from "../../../talk/client-voice-session.js";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL } from "../../../talk/describe-view-tool.js";
import {
  cancelInternalRealtimeVoiceBrowserSession,
  projectInternalRealtimeVoicePublicConfig,
  type InternalRealtimeVoiceBrowserSessionCreateRequest,
} from "../../../talk/provider-internal.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../../talk/provider-resolver.js";
import { resolveSandboxedSessionCreation } from "../../operator-session-run.js";
import type { GatewayRequestHandler } from "../../server-methods/types.js";
import { assertValidParams } from "../../server-methods/validation.js";
import { resolveOperatorSessionCreation } from "../../session-creation-provenance.js";
import { resolveGatewayInputParticipant } from "../../session-input-participant.js";
import { formatForLog } from "../../ws-log.js";
import { createTalkClientAgentConsultRunner } from "../client-agent-consult.js";
import {
  createTalkClientGatewayControlOwner,
  resolveTalkAgentConsultAuthority,
} from "../client-gateway-control.js";
import { prepareTalkProviderConversationContext } from "../conversation-context.js";
import { createTalkOperatorRunSource } from "../operator-run-source.js";
import { talkRequestError } from "../request-error.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  resolveTalkRealtimeProviderInstructions,
} from "../session-config.js";
import { readTalkRealtimeInitialItems } from "../session-history.js";
import { requirePreparedTalkSessionTarget } from "../session-target.js";
import {
  markTalkVoiceSessionReady,
  prepareTalkVoiceReplacement,
  registerTalkVoiceSession,
} from "../voice-selection.js";
import { createGatewayVoiceTranscriptAudience } from "../voice-transcript-audience.js";
import {
  forgetLegacyVoiceBinding,
  rememberLegacyVoiceBinding,
} from "./client-legacy-voice-bindings.js";

const REALTIME_VOICE_CLIENT_SESSION_MIN_TTL_MS = 5_000;

export const createTalkClient: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
  sessionMutationAuthorization,
  sessionMutationCommitGuard,
}) => {
  if (!assertValidParams(params, validateTalkClientCreateParams, "talk.client.create", respond)) {
    return;
  }
  const rejectRequest = (code: Parameters<typeof errorShape>[0], message: string): void =>
    respond(false, undefined, errorShape(code, message));
  let conversationContext:
    | Awaited<ReturnType<typeof prepareTalkProviderConversationContext>>
    | undefined;
  try {
    sessionMutationAuthorization?.assertCurrent();
    if (params.voiceChangeId && params.voiceSessionId) {
      return rejectRequest(
        ErrorCodes.INVALID_REQUEST,
        "A voice replacement requires a fresh voice session id",
      );
    }
    const replacement = prepareTalkVoiceReplacement({
      voiceChangeId: params.voiceChangeId,
      connId: client?.connId,
      sessionKey: params.sessionKey,
    });
    const requested = replacement
      ? {
          ...params,
          provider: replacement.provider,
          model: replacement.model,
          voice: replacement.voice,
        }
      : params;
    const runtimeConfig = context.getRuntimeConfig();
    const inputParticipant = resolveGatewayInputParticipant(client);
    const realtimeConfig = buildTalkRealtimeConfig(
      runtimeConfig,
      requested.provider,
      requested.model,
    );
    const mode = params.mode ?? realtimeConfig.mode ?? "realtime";
    if (mode !== "realtime") {
      return rejectRequest(
        ErrorCodes.INVALID_REQUEST,
        `talk.client.create only supports mode="realtime"; use talk.catalog for ${mode} provider discovery`,
      );
    }
    const brain = params.brain ?? realtimeConfig.brain ?? "agent-consult";
    if (brain !== "agent-consult") {
      return rejectRequest(
        ErrorCodes.INVALID_REQUEST,
        `talk.client.create only supports brain="agent-consult"`,
      );
    }
    const transport = params.transport ?? realtimeConfig.transport;
    const wantsCameraFrames = params.capabilities?.includes("camera-frame") === true;
    const wantsGatewayControl = params.capabilities?.includes("gateway-control-v1") === true;
    const clientControl = wantsGatewayControl ? { owner: "gateway" as const } : undefined;
    if (wantsGatewayControl && wantsCameraFrames) {
      return rejectRequest(
        ErrorCodes.INVALID_REQUEST,
        "gateway-control-v1 supports audio-only WebRTC sessions",
      );
    }
    if (transport === "managed-room") {
      return rejectRequest(
        ErrorCodes.UNAVAILABLE,
        "managed-room realtime Talk sessions are not available in the browser UI yet",
      );
    }
    if (transport === "gateway-relay") {
      return rejectRequest(
        ErrorCodes.INVALID_REQUEST,
        wantsCameraFrames
          ? "gateway-relay does not support browser video frames"
          : `talk.client.create is client-owned; use talk.session.create for gateway-relay`,
      );
    }
    const launchOptions = buildRealtimeVoiceLaunchOptions({
      requested,
      defaults: realtimeConfig,
    });
    const target = requirePreparedTalkSessionTarget(
      sessionMutationAuthorization?.talkSessionTarget,
    );
    replacement?.assertCurrent(target);
    const { agentId, sessionKey } = target;
    const assertTargetCurrent = composeSessionSourceAssertion(
      [sessionMutationAuthorization?.assertCurrent],
      (assertSources) => {
        assertSources();
        replacement?.assertCurrent(target);
      },
    );
    const sessionTarget = { agentId, sessionKey: target.canonicalKey, storePath: target.storePath };
    assertSecretOwnerAvailable("capability", "talk:realtime");
    const resolution = resolveConfiguredRealtimeVoiceProvider({
      configuredProviderId: realtimeConfig.provider,
      providerConfigs: realtimeConfig.providers,
      ...(launchOptions.model ? { providerConfigOverrides: { model: launchOptions.model } } : {}),
      cfg: runtimeConfig,
      agentId,
      defaultModel: realtimeConfig.model,
      surface: "browser-session",
      requiredCapabilities: { supportsVideoFrames: wantsCameraFrames },
      clientControl,
    });
    const providerCapabilities = resolution.capabilities;
    if (wantsGatewayControl && providerCapabilities?.supportsGatewayControl !== true) {
      return rejectRequest(
        ErrorCodes.UNAVAILABLE,
        `Realtime provider "${resolution.provider.id}" does not support gateway-control-v1 with its configured authentication`,
      );
    }
    if (wantsCameraFrames && providerCapabilities?.supportsVideoFrames !== true) {
      return rejectRequest(
        ErrorCodes.INVALID_REQUEST,
        `Realtime provider ${resolution.provider.id} does not support browser video frames`,
      );
    }
    const providerInstructions =
      (await resolveTalkRealtimeProviderInstructions({
        config: runtimeConfig,
        agentId,
        configuredInstructions: realtimeConfig.instructions,
        sessionKey: target.canonicalKey,
        warn: (message) => context.logGateway.warn(`talk realtime context: ${message}`),
      })) ?? "";
    assertTargetCurrent();
    if (resolution.provider.createBrowserSession) {
      const ownerConnId = normalizeOptionalString(client?.connId);
      const ownsProvider =
        wantsGatewayControl || providerCapabilities?.handlesAgentConsult === true;
      if (ownsProvider && !ownerConnId) {
        return rejectRequest(
          ErrorCodes.UNAVAILABLE,
          "Gateway-owned realtime sessions require a connected client",
        );
      }
      let startupEnsuredSessionId: string | undefined;
      conversationContext = await prepareTalkProviderConversationContext({
        target,
        assertCurrent: assertTargetCurrent,
        getRuntimeConfig: context.getRuntimeConfig,
        captureOperatorAuthority: createTalkOperatorRunSource({ client, context }),
        participant: inputParticipant,
        agentConsultAvailable:
          providerCapabilities?.supportsToolCalls !== false ||
          providerCapabilities?.handlesAgentConsult === true,
        ...(resolveAgentConversationMode(runtimeConfig, agentId) === "branches"
          ? {
              prepareTarget: async (
                assertSourceCurrent: SessionSourceAssertion,
                privateAudience: ConversationPrivateAudience | undefined,
              ) => {
                // A branch is an explicitly begun conversation attempt. Its native
                // row must exist before the authorized Knowledge snapshot; retain
                // that attempt even when provider startup subsequently fails.
                startupEnsuredSessionId = await ensureClientVoiceAgentSessionEntry({
                  chatType: "direct",
                  privateAudience,
                  ...sessionTarget,
                  cfg: runtimeConfig,
                  creation:
                    resolveSandboxedSessionCreation(client, runtimeConfig) ??
                    resolveOperatorSessionCreation(client),
                  assertCommitAllowed: composeSessionSourceAssertion([
                    sessionMutationCommitGuard,
                    assertSourceCurrent,
                  ]),
                  onCreatedSessionCommitted: sessionMutationAuthorization?.recordCreatedSession,
                });
                sessionMutationAuthorization?.assertTargetCurrent({
                  ...sessionTarget,
                  ensuredSessionId: startupEnsuredSessionId,
                });
              },
            }
          : {}),
      });
      const contextualProviderInstructions =
        providerInstructions + conversationContext.instructions;
      const initialItems = await readTalkRealtimeInitialItems(target, assertTargetCurrent);
      assertTargetCurrent();
      const controlSource =
        providerCapabilities?.handlesAgentConsult === true ? "delegation" : "transcript";
      const tools =
        providerCapabilities?.supportsToolCalls === false
          ? []
          : [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL];
      if (wantsCameraFrames && tools.length > 0) {
        tools.push(REALTIME_VOICE_DESCRIBE_VIEW_TOOL);
      }
      const instructions =
        controlSource === "delegation"
          ? normalizeOptionalString(contextualProviderInstructions)
          : buildRealtimeInstructions(contextualProviderInstructions);
      const requestedVoiceSessionId = normalizeOptionalString(params.voiceSessionId);
      let activeVoiceSessionId = ownsProvider
        ? (requestedVoiceSessionId ?? randomUUID())
        : undefined;
      let logicalSessionCreated = false;
      let unregisterVoiceSession: (() => void) | undefined;
      let providerReady = !ownsProvider;
      let closingSource: ClientVoiceSessionSource | undefined;
      let closingFailure: { error: unknown } | undefined;
      const closeLogicalSession = async () => {
        unregisterVoiceSession?.();
        if (closingFailure) {
          throw closingFailure.error;
        }
        if (!logicalSessionCreated) {
          return;
        }
        await closeClientVoiceSession(
          {
            agentId,
            sessionKey,
            voiceSessionId: activeVoiceSessionId!,
            config: runtimeConfig,
          },
          closingSource,
        );
        if (ownerConnId) {
          forgetLegacyVoiceBinding(
            ownerConnId,
            params.sessionKey?.trim() || sessionKey,
            activeVoiceSessionId!,
          );
        }
      };
      const consultRunner = createTalkClientAgentConsultRunner({
        config: runtimeConfig,
        context,
        sessionTarget: target,
        ...(ownerConnId ? { ownerConnId } : {}),
        authority: resolveTalkAgentConsultAuthority(client?.connect?.scopes, client),
        captureOperatorAuthority: createTalkOperatorRunSource({ client, context }),
        participant: inputParticipant,
        getVoiceSessionId: () => activeVoiceSessionId,
        initialItems,
      });
      // Native mode materializes only after a usable provider session exists.
      // Bind once below that ensure, never keep an absent-row or successor binding.
      let preparePrivateAudience:
        | ReturnType<typeof createGatewayVoiceTranscriptAudience>
        | undefined;
      const gatewayControlOwner = ownsProvider
        ? createTalkClientGatewayControlOwner({
            voiceSessionId: activeVoiceSessionId!,
            providerId: resolution.provider.id,
            controlSource,
            supportsToolCalls: providerCapabilities?.supportsToolCalls,
            sessionTarget: target,
            connId: ownerConnId!,
            context,
            assertConnectionOpen: () => {
              const currentConnections = context.getClientConnIds?.(
                (candidate) => candidate === client,
              );
              if (!currentConnections?.has(ownerConnId!)) {
                throw new Error("Realtime voice client disconnected");
              }
            },
            runToolAgentConsult: consultRunner.runArgs,
            runAgentConsult: consultRunner.runOwnedArgs,
            getToolAuthorityOverlay: (source) =>
              consultRunner.getToolAuthorityOverlay(undefined, source),
            appendTranscript: ({ entryId, role, text, confirmation }) =>
              closingFailure
                ? Promise.reject(
                    toErrorObject(closingFailure.error, "Voice session close admission failed"),
                  )
                : appendClientVoiceTranscript(
                    {
                      agentId,
                      sessionKey,
                      sessionTarget,
                      voiceSessionId: activeVoiceSessionId!,
                      entryId,
                      role,
                      text,
                      participant: role === "user" ? inputParticipant : undefined,
                      preparePrivateAudience,
                      confirmation,
                      config: runtimeConfig,
                    },
                    closingSource,
                  ),
            flushTranscript: () =>
              flushClientVoiceSessionWrites({
                agentId,
                voiceSessionId: activeVoiceSessionId!,
              }),
            closeLogicalSession,
            withCloseSettlement: (run) => {
              const close = async (admissionFailure?: { error: unknown }) => {
                closingFailure = admissionFailure;
                if (!closingFailure) {
                  try {
                    closingSource = captureClientVoiceSessionSource(agentId);
                  } catch (error) {
                    closingFailure = { error };
                  }
                }
                try {
                  await run();
                  if (closingFailure) {
                    throw closingFailure.error;
                  }
                } catch (error) {
                  if (closingFailure && error !== closingFailure.error) {
                    throw new AggregateError(
                      [closingFailure.error, error],
                      "Voice session close failed",
                      { cause: error },
                    );
                  }
                  throw error;
                } finally {
                  closingSource = undefined;
                  closingFailure = undefined;
                }
              };
              return withClientVoiceSessionSettlement(close, (error) => close({ error }));
            },
          })
        : undefined;
      const gatewayControl = gatewayControlOwner
        ? {
            ...gatewayControlOwner.control,
            onReady: () => {
              try {
                gatewayControlOwner.assertOpen();
              } catch {
                return;
              }
              providerReady = true;
              gatewayControlOwner.control.onReady?.();
              if (activeVoiceSessionId && ownerConnId) {
                markTalkVoiceSessionReady(activeVoiceSessionId, ownerConnId, agentId);
              }
            },
          }
        : undefined;
      // Native delegation can use lifecycle callbacks without negotiated control.
      // Keep the ownership claim and its required binding in one request variant.
      const controlRequest = gatewayControl
        ? clientControl
          ? { clientControl, gatewayControl }
          : { gatewayControl }
        : {};
      const browserSessionRequest: InternalRealtimeVoiceBrowserSessionCreateRequest = {
        cfg: runtimeConfig,
        agentId,
        ...(ownerConnId ? { ownerConnId } : {}),
        workspaceDir: resolveAgentWorkspaceDir(runtimeConfig, agentId),
        providerConfig: resolution.providerConfig,
        instructions,
        initialItems,
        runAgentConsult: gatewayControlOwner?.runAgentConsult ?? consultRunner.runPrompt,
        ...controlRequest,
        ...(tools.length > 0 ? { tools } : {}),
        ...launchOptions,
      };
      const assertCommitAllowed = composeSessionSourceAssertion(
        [sessionMutationCommitGuard, assertTargetCurrent],
        (assertSources) => {
          assertSources();
          gatewayControlOwner?.assertOpen();
        },
      );
      let session: Awaited<ReturnType<typeof resolution.provider.createBrowserSession>> | undefined;
      let delivered = false;
      try {
        assertCommitAllowed();
        conversationContext.assertCurrent();
        session = await resolution.provider.createBrowserSession(browserSessionRequest);
        const createdSession = session;
        await gatewayControlOwner?.adoptProvider(() =>
          cancelInternalRealtimeVoiceBrowserSession({
            provider: resolution.provider,
            request: browserSessionRequest,
            session: createdSession,
          }),
        );
        assertCommitAllowed();
        conversationContext.assertCurrent();
        // Client-owned voice records are minted only for client-owned transports;
        // relay sessions are created via talk.session.create and keyed by relaySessionId.
        // Widening this guard would hand relay calls a mismatched voiceSessionId.
        // Google WebRTC is not supported by this client-owned flow.
        if (
          (session.transport === "webrtc" || session.transport === "provider-websocket") &&
          !(
            session.transport === "webrtc" &&
            normalizeLowercaseStringOrEmpty(session.provider) === "google"
          ) &&
          (!transport || session.transport === transport)
        ) {
          const sessionEntryDeadlineAt =
            session.expiresAt === undefined
              ? undefined
              : session.expiresAt - REALTIME_VOICE_CLIENT_SESSION_MIN_TTL_MS;
          if (sessionEntryDeadlineAt !== undefined && Date.now() >= sessionEntryDeadlineAt) {
            throw new Error("Realtime browser session expired during startup; try again");
          }
          // Native mode still defers creation until a usable transport exists.
          // Branch mode already admitted its actual attempt before the snapshot;
          // never delete/recreate it on provider failure or discard its history.
          const ensuredSessionId =
            startupEnsuredSessionId ??
            (await ensureClientVoiceAgentSessionEntry({
              chatType: "direct",
              ...sessionTarget,
              cfg: runtimeConfig,
              creation:
                resolveSandboxedSessionCreation(client, runtimeConfig) ??
                resolveOperatorSessionCreation(client),
              deadlineAt: sessionEntryDeadlineAt,
              assertCommitAllowed,
              onCreatedSessionCommitted: sessionMutationAuthorization?.recordCreatedSession,
            }));
          sessionMutationCommitGuard?.();
          sessionMutationAuthorization?.assertTargetCurrent({ ...sessionTarget, ensuredSessionId });
          replacement?.assertCurrent(target);
          gatewayControlOwner?.assertOpen();
          conversationContext.assertCurrent();
          if (ownsProvider) {
            preparePrivateAudience = createGatewayVoiceTranscriptAudience({
              target,
              expectedSessionId: ensuredSessionId,
              client,
              context,
            });
          }
          // Recovering 6h-abandoned calls (and retrying their digests) is not on the
          // start path; running it inline would delay use of time-sensitive provider
          // credentials behind slow channel sends. Fire it off the response path.
          void closeStaleClientVoiceSessions({
            agentId,
            config: runtimeConfig,
            excludeVoiceSessionId: requestedVoiceSessionId,
            warn: (message) => context.logGateway.warn(`talk voice session recovery: ${message}`),
          }).catch((error: unknown) =>
            context.logGateway.warn(`talk voice session recovery failed: ${formatForLog(error)}`),
          );
          const voiceSessionId = createOrResumeClientVoiceSession({
            agentId,
            sessionKey,
            provider: resolution.provider.id,
            origin: "client",
            // Deployed clients sent sessionKey before transcripts existed, so capability
            // must be negotiated explicitly; declaring it turns the confirmation gate on.
            transcriptCapable:
              wantsGatewayControl || params.capabilities?.includes("voice-transcript") === true,
            voiceSessionId: activeVoiceSessionId ?? requestedVoiceSessionId,
          });
          activeVoiceSessionId = voiceSessionId;
          logicalSessionCreated = true;
          const connId = ownerConnId;
          if (connId) {
            rememberLegacyVoiceBinding({
              connId,
              sessionKey: params.sessionKey?.trim() || sessionKey,
              voiceSessionId,
            });
          }
          gatewayControlOwner?.activate();
          const model =
            normalizeOptionalString(session.model) ??
            normalizeOptionalString(resolution.providerConfig.model) ??
            resolution.provider.defaultModel;
          const voice =
            normalizeOptionalString(session.voice) ??
            normalizeOptionalString(resolution.providerConfig.voice);
          const publicSession = projectInternalRealtimeVoicePublicConfig({
            provider: resolution.provider,
            providerConfig: resolution.providerConfig,
            config: { ...session, model, voice },
          });
          if (connId) {
            const voices = [
              ...(providerCapabilities?.voices ??
                (model ? providerCapabilities?.voicesByModel?.[model] : undefined) ??
                resolution.provider.voices ??
                []),
            ];
            unregisterVoiceSession = registerTalkVoiceSession({
              voiceSessionId,
              connId,
              sessionTarget: target,
              selection: {
                provider: session.provider,
                model: publicSession.model,
                voice: publicSession.voice,
                voices,
                canChange:
                  params.capabilities?.includes("voice-selection") === true && voices.length > 0,
              },
              launch: { provider: session.provider, model },
              voiceChangeId: params.voiceChangeId,
              providerReady,
            });
            if (gatewayControlOwner) {
              gatewayControlOwner.signal.addEventListener("abort", unregisterVoiceSession, {
                once: true,
              });
              if (gatewayControlOwner.signal.aborted) {
                unregisterVoiceSession();
              }
            }
          }
          respond(
            true,
            {
              ...publicSession,
              voiceSessionId,
              ...(clientControl ? { clientControl } : {}),
            },
            undefined,
          );
          delivered = true;
          return;
        }
        if (transport) {
          return rejectRequest(
            ErrorCodes.UNAVAILABLE,
            `Realtime provider "${resolution.provider.id}" does not support requested browser transport "${transport}"`,
          );
        }
      } finally {
        if (!delivered) {
          unregisterVoiceSession?.();
          try {
            if (gatewayControlOwner) {
              await gatewayControlOwner.close();
            } else if (session) {
              try {
                await cancelInternalRealtimeVoiceBrowserSession({
                  provider: resolution.provider,
                  request: browserSessionRequest,
                  session,
                });
              } finally {
                await closeLogicalSession();
              }
            }
          } catch (error) {
            context.logGateway.warn(`talk browser session cleanup failed: ${formatForLog(error)}`);
          }
        }
      }
    }
    rejectRequest(
      ErrorCodes.UNAVAILABLE,
      `Realtime provider "${resolution.provider.id}" does not support client-owned realtime sessions`,
    );
  } catch (err) {
    respond(false, undefined, talkRequestError(err));
  } finally {
    try {
      await conversationContext?.release();
    } catch (error) {
      context.logGateway.warn(`talk context snapshot cleanup failed: ${formatForLog(error)}`);
    }
  }
};
