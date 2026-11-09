import { randomUUID } from "node:crypto";
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
import { resolveAgentLanguage } from "../../../agents/identity.js";
import {
  composeSessionSourceAssertion,
  releaseSessionSourceAuthorities,
  type SessionSourceWriteGrant,
} from "../../../config/sessions/session-source-authority.js";
import { toErrorObject } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { assertSecretOwnerAvailable } from "../../../secrets/runtime-degraded-state.js";
import { withClientVoiceSessionSettlement } from "../../../talk/client-voice-session-lifecycle.js";
import {
  captureClientVoiceSessionSource,
  type ClientVoiceSessionSource,
} from "../../../talk/client-voice-session-source.js";
import {
  ensureClientVoiceAgentSessionEntry,
  captureClientVoiceSessionWriter,
  type ClientVoiceSessionWriter,
} from "../../../talk/client-voice-session-write.js";
import {
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  flushClientVoiceSessionWrites,
} from "../../../talk/client-voice-session.js";
import {
  cancelInternalRealtimeVoiceBrowserSession,
  type InternalRealtimeVoiceBrowserSessionCreateRequest,
} from "../../../talk/provider-internal.js";
import { resolveConfiguredRealtimeVoiceProviderAsync } from "../../../talk/provider-resolver.js";
import { resolveSandboxedSessionCreation } from "../../operator-session-run.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type { GatewayRequestHandler } from "../../server-methods/types.js";
import { assertValidParams } from "../../server-methods/validation.js";
import { resolveOperatorSessionCreation } from "../../session-creation-provenance.js";
import {
  captureGatewayPrivateConversationAudience,
  resolveGatewayInputParticipant,
} from "../../session-input-participant.js";
import { formatForLog } from "../../ws-log.js";
import { createTalkClientAgentConsultRunner } from "../client-agent-consult.js";
import { createTalkClientGatewayControlOwner } from "../client-gateway-control.js";
import {
  retainTalkClientRunAuthority,
  type TalkClientRunAuthority,
} from "../client-run-authority.js";
import { resolveTalkAgentConsultAuthority } from "../client-tool-authority.js";
import { appendTalkClientTranscript } from "../client-transcript.js";
import { prepareTalkProviderConversationContext } from "../conversation-context.js";
import { talkRequestError } from "../request-error.js";
import {
  assertTalkClientSessionEntryDeadline,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  resolveTalkRealtimeProviderInstructions,
  resolveTalkClientLaunchError,
} from "../session-config.js";
import { restoreTalkSessionTarget } from "../session-start.js";
import { requirePreparedTalkSessionTarget } from "../session-target.js";
import { markTalkVoiceSessionReady, prepareTalkVoiceReplacement } from "../voice-selection.js";
import { createGatewayVoiceTranscriptAudience } from "../voice-transcript-audience.js";
import { prepareTalkClientContext } from "./client-context.js";
import {
  forgetLegacyVoiceBinding,
  rememberLegacyVoiceBinding,
} from "./client-legacy-voice-bindings.js";
import { registerTalkClientPresentation } from "./client-presentation.js";

const REALTIME_VOICE_CLIENT_SESSION_MIN_TTL_MS = 5_000;

export const createTalkClient: GatewayRequestHandler = async (request) => {
  const {
    params,
    respond,
    context,
    client,
    hasCurrentClientAuthority,
    sessionMutationAuthorization,
    sessionMutationCommitGuard,
  } = request;
  const requester = readGatewayRequestMutationAuthority(request);
  if (!assertValidParams(params, validateTalkClientCreateParams, "talk.client.create", respond)) {
    return;
  }
  const rejectRequest = (code: Parameters<typeof errorShape>[0], message: string): void =>
    respond(false, undefined, errorShape(code, message));
  let conversationContext:
    | Awaited<ReturnType<typeof prepareTalkProviderConversationContext>>
    | undefined;
  let language: string | undefined;
  let runAuthority: TalkClientRunAuthority | undefined;
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
    const requested = replacement ? { ...params, ...replacement.launch } : params;
    const runtimeConfig = context.getRuntimeConfig();
    const inputParticipant = resolveGatewayInputParticipant(client);
    const realtimeConfig = await buildTalkRealtimeConfig(
      runtimeConfig,
      requested.provider,
      requested.model,
    );
    const mode = params.mode ?? realtimeConfig.mode ?? "realtime";
    const brain = params.brain ?? realtimeConfig.brain ?? "agent-consult";
    const transport = params.transport ?? realtimeConfig.transport;
    const wantsCameraFrames = params.capabilities?.includes("camera-frame") === true;
    const wantsGatewayControl = params.capabilities?.includes("gateway-control-v1") === true;
    const clientControl = wantsGatewayControl ? { owner: "gateway" as const } : undefined;
    const transportError = resolveTalkClientLaunchError({
      mode,
      brain,
      transport,
      wantsGatewayControl,
      wantsCameraFrames,
    });
    if (transportError) {
      return rejectRequest(transportError.code, transportError.message);
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
    language = resolveAgentLanguage(runtimeConfig, agentId);
    const assertTargetCurrent = composeSessionSourceAssertion(
      [sessionMutationAuthorization?.assertCurrent],
      (assertSources) => {
        assertSources();
        replacement?.assertCurrent(target);
      },
    );
    const sessionTarget = { agentId, sessionKey: target.canonicalKey, storePath: target.storePath };
    assertSecretOwnerAvailable("capability", "talk:realtime");
    const resolution = await resolveConfiguredRealtimeVoiceProviderAsync({
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
      await restoreTalkSessionTarget(request, target, replacement?.source(target).assertCurrent);
      const preparedContext = await prepareTalkClientContext(request, {
        target,
        runtimeConfig,
        inputParticipant,
        assertTargetCurrent,
        providerCapabilities,
        providerInstructions,
        wantsCameraFrames,
      });
      conversationContext = preparedContext.conversationContext;
      const { startupEnsuredSessionId, initialItems, controlSource, tools, instructions } =
        preparedContext;
      const requestedVoiceSessionId = normalizeOptionalString(params.voiceSessionId);
      const ownsProvider =
        wantsGatewayControl || providerCapabilities?.handlesAgentConsult === true;
      const activeVoiceSessionId = requestedVoiceSessionId ?? randomUUID();
      let logicalSessionCreated = false;
      let unregisterVoiceSession: (() => void) | undefined;
      let providerReady = !ownsProvider;
      const ownerConnId = normalizeOptionalString(client?.connId);
      if (!ownerConnId) {
        return rejectRequest(
          ErrorCodes.UNAVAILABLE,
          "Realtime consultation callbacks require a connected client",
        );
      }
      runAuthority = await retainTalkClientRunAuthority({
        client,
        context,
        hasCurrentClientAuthority,
      });
      assertTargetCurrent();
      let voiceSessionSource: ClientVoiceSessionSource | undefined;
      let voiceCreation: Promise<string> | undefined;
      let closing = false;
      let closingWriter: ClientVoiceSessionWriter | undefined;
      let closingFailure: { error: unknown } | undefined;
      const awaitVoiceCreation = async () => {
        try {
          await voiceCreation;
        } catch (error) {
          // Acknowledged creation retains close custody even if later cleanup failed.
          if (!logicalSessionCreated) {
            throw error;
          }
        }
      };
      const requireVoiceSource = () => {
        if (!voiceSessionSource) {
          throw new Error("Realtime browser voice session is not ready for persistence");
        }
        return voiceSessionSource;
      };
      const withVoiceWriter = async <T>(
        operation: (writer: ClientVoiceSessionWriter) => Promise<T>,
      ): Promise<T> => {
        const source = requireVoiceSource();
        return withClientVoiceSessionSettlement(
          async () => {
            await awaitVoiceCreation();
            if (closingFailure) {
              throw closingFailure.error;
            }
            const writer =
              closingWriter ??
              captureClientVoiceSessionWriter({ agentId, physicalSource: requireVoiceSource() });
            const retained = closing;
            if (retained) {
              closingWriter = writer;
            }
            const errors: unknown[] = [];
            try {
              return await operation(writer);
            } catch (error) {
              errors.push(error);
              throw error;
            } finally {
              if (!retained) {
                await releaseSessionSourceAuthorities([writer], errors);
              }
            }
          },
          undefined,
          source.settlementContext,
        );
      };
      const closeLogicalSession = async () => {
        unregisterVoiceSession?.();
        await awaitVoiceCreation();
        if (closingFailure) {
          throw closingFailure.error;
        }
        if (!logicalSessionCreated) {
          return;
        }
        await withVoiceWriter((writer) =>
          closeClientVoiceSession(
            {
              agentId,
              sessionKey,
              voiceSessionId: activeVoiceSessionId,
              config: runtimeConfig,
            },
            writer,
          ),
        );
        forgetLegacyVoiceBinding(
          ownerConnId,
          params.sessionKey?.trim() || sessionKey,
          activeVoiceSessionId,
        );
      };
      const consultRunner = createTalkClientAgentConsultRunner({
        config: runtimeConfig,
        context,
        sessionTarget: target,
        ownerConnId,
        authority: resolveTalkAgentConsultAuthority(client?.connect?.scopes, client),
        runAuthority,
        participant: inputParticipant,
        getVoiceSessionId: () => activeVoiceSessionId,
        getVoiceSessionSource: () => (logicalSessionCreated ? voiceSessionSource : undefined),
        initialItems,
      });
      let preparePrivateAudience:
        | ReturnType<typeof createGatewayVoiceTranscriptAudience>
        | undefined;
      const gatewayControlOwner = createTalkClientGatewayControlOwner({
        language,
        voiceSessionId: activeVoiceSessionId,
        providerId: resolution.provider.id,
        controlSource,
        supportsToolCalls: providerCapabilities?.supportsToolCalls,
        sessionTarget: target,
        connId: ownerConnId,
        context,
        assertConnectionOpen: () => {
          const currentConnections = context.getClientConnIds?.(
            (candidate) => candidate === client,
          );
          if (!currentConnections?.has(ownerConnId)) {
            throw new Error("Realtime voice client disconnected");
          }
        },
        runToolAgentConsult: consultRunner.runArgs,
        runAgentConsult: consultRunner.runOwnedArgs,
        getToolAuthorityOverlay: (source) =>
          consultRunner.getToolAuthorityOverlay(undefined, source),
        appendTranscript: ({ entryId, role, text }) =>
          closingFailure
            ? Promise.reject(toErrorObject(closingFailure.error, "Voice session close failed"))
            : withVoiceWriter((writer) =>
                appendTalkClientTranscript(
                  {
                    agentId,
                    sessionKey,
                    sessionTarget,
                    voiceSessionId: activeVoiceSessionId,
                    entryId,
                    role,
                    text,
                    participant: role === "user" ? inputParticipant : undefined,
                    preparePrivateAudience,
                    providerOwned: controlSource === "delegation",
                    config: runtimeConfig,
                  },
                  context,
                  writer,
                ),
              ),
        flushTranscript: async () => {
          const voiceTarget = { agentId, voiceSessionId: activeVoiceSessionId };
          if (!voiceSessionSource) {
            return flushClientVoiceSessionWrites(voiceTarget, null);
          }
          try {
            return await withVoiceWriter((writer) =>
              flushClientVoiceSessionWrites(voiceTarget, writer),
            );
          } catch (error) {
            if (!closing) {
              throw error;
            }
            closingFailure ??= { error };
            await flushClientVoiceSessionWrites(voiceTarget, null);
          }
        },
        closeLogicalSession,
        withCloseSettlement: (run) => {
          closing = true;
          const close = async (admissionFailure?: { error: unknown }) => {
            closingFailure = admissionFailure;
            const errors: unknown[] = [];
            try {
              await run();
              if (closingFailure) {
                throw closingFailure.error;
              }
            } catch (error) {
              const failure =
                closingFailure && error !== closingFailure.error
                  ? new AggregateError(
                      [closingFailure.error, error],
                      "Voice session close failed",
                      { cause: error },
                    )
                  : error;
              errors.push(failure);
              throw failure;
            } finally {
              runAuthority?.release();
              const writer = closingWriter;
              closingWriter = undefined;
              closingFailure = undefined;
              await releaseSessionSourceAuthorities(writer ? [writer] : [], errors);
            }
          };
          return withClientVoiceSessionSettlement(
            close,
            (error) => close({ error }),
            voiceSessionSource?.settlementContext,
          );
        },
      });
      const gatewayControl = ownsProvider
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
              markTalkVoiceSessionReady(activeVoiceSessionId, ownerConnId, agentId);
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
        ownerConnId,
        workspaceDir: resolveAgentWorkspaceDir(runtimeConfig, agentId),
        providerConfig: resolution.providerConfig,
        instructions,
        initialItems,
        runAgentConsult: gatewayControlOwner.runAgentConsult,
        ...controlRequest,
        ...(tools.length > 0 ? { tools } : {}),
        ...launchOptions,
      };
      const assertCommitAllowed = composeSessionSourceAssertion(
        [sessionMutationCommitGuard, assertTargetCurrent],
        (assertSources) => {
          assertSources();
          gatewayControlOwner.assertOpen();
        },
      );
      let session: Awaited<ReturnType<typeof resolution.provider.createBrowserSession>> | undefined;
      let delivered = false;
      let mutationGrant: SessionSourceWriteGrant | undefined;
      try {
        assertCommitAllowed();
        conversationContext.assertCurrent();
        session = await resolution.provider.createBrowserSession(browserSessionRequest);
        const createdSession = session;
        await gatewayControlOwner.adoptProvider(() =>
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
          assertTalkClientSessionEntryDeadline(sessionEntryDeadlineAt);
          // Existing rows use the admitted identity; the live guards below and
          // voice transaction still revalidate it. Missing rows are initialized
          // only after the provider returns a usable client transport.
          const admittedTarget = sessionMutationAuthorization?.admittedTarget;
          const ensuredSessionId =
            startupEnsuredSessionId ??
            (admittedTarget?.agentId === sessionTarget.agentId &&
            admittedTarget.sessionKey === sessionTarget.sessionKey &&
            admittedTarget.sessionId
              ? admittedTarget.sessionId
              : await ensureClientVoiceAgentSessionEntry({
                  cfg: runtimeConfig,
                  getRuntimeConfig: context.getRuntimeConfig,
                  chatType: "direct",
                  ...sessionTarget,
                  privateAudience: captureGatewayPrivateConversationAudience({
                    agentId,
                    sessionKey: sessionTarget.sessionKey,
                    participant: inputParticipant,
                    operatorAuthority: runAuthority?.operatorAuthority,
                    assertCurrent: assertTargetCurrent,
                  }),
                  creation:
                    resolveSandboxedSessionCreation(client, runtimeConfig) ??
                    resolveOperatorSessionCreation(client),
                  deadlineAt: sessionEntryDeadlineAt,
                  requester: composeSessionSourceAssertion([
                    requester.assertCurrent,
                    replacement?.source(target).assertCurrent,
                  ]),
                  source: sessionMutationAuthorization?.assertCurrent,
                  prepareWorkerGrant: sessionMutationAuthorization?.prepareWorkerGrant,
                  followRegistration: (change) =>
                    sessionMutationAuthorization?.followRegistration?.(sessionTarget, change),
                  assertCurrent: () => {
                    requester.assertPreparationCurrent();
                    gatewayControlOwner.assertOpen();
                  },
                  onCommittedSource: (readSource, entry) =>
                    sessionMutationAuthorization?.recordCreatedSession?.({
                      ...sessionTarget,
                      sessionId: entry.sessionId,
                      entry,
                      lifecycleRevision: entry.lifecycleRevision,
                      readSource,
                    }),
                }));
          sessionMutationCommitGuard?.();
          sessionMutationAuthorization?.assertTargetCurrent({ ...sessionTarget, ensuredSessionId });
          replacement?.assertCurrent(target);
          gatewayControlOwner.assertOpen();
          conversationContext.assertCurrent();
          preparePrivateAudience = createGatewayVoiceTranscriptAudience({
            target,
            expectedSessionId: ensuredSessionId,
            client,
            context,
          });
          const initialVoiceSource = captureClientVoiceSessionSource(agentId);
          voiceSessionSource = initialVoiceSource;
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
          voiceCreation = withClientVoiceSessionSettlement(
            () =>
              Promise.resolve().then(async () => {
                const writer = captureClientVoiceSessionWriter({
                  agentId,
                  physicalSource: initialVoiceSource,
                });
                const errors: unknown[] = [];
                try {
                  const voiceSessionId = await createOrResumeClientVoiceSession(
                    {
                      agentId,
                      sessionKey,
                      provider: resolution.provider.id,
                      origin: "client",
                      // Deployed clients sent sessionKey before transcripts existed, so capability
                      // must be negotiated explicitly to describe transcript support truthfully.
                      transcriptCapable:
                        wantsGatewayControl ||
                        params.capabilities?.includes("voice-transcript") === true,
                      voiceSessionId: activeVoiceSessionId,
                      requester: requester.assertCurrent,
                      source: {
                        storePath: target.storePath,
                        prepareWorkerGrant: !replacement
                          ? sessionMutationAuthorization?.prepareWorkerGrant
                          : undefined,
                        retainWorkerGrant: (grant) => {
                          mutationGrant = grant;
                        },
                        assertCurrent: composeSessionSourceAssertion([
                          sessionMutationAuthorization?.assertCurrent,
                          replacement?.source(target).assertCurrent,
                        ]),
                      },
                      assertCurrent: () => {
                        requester.assertPreparationCurrent();
                        gatewayControlOwner.assertOpen();
                        assertTalkClientSessionEntryDeadline(sessionEntryDeadlineAt);
                      },
                    },
                    writer,
                  );
                  logicalSessionCreated = true;
                  voiceSessionSource = writer.source;
                  return voiceSessionId;
                } catch (error) {
                  errors.push(error);
                  if (!hasSqliteWorkerOutcomeUnknown(error)) {
                    try {
                      voiceSessionSource = writer.source;
                    } catch {
                      // Keep the original fence if the creator cannot certify its admitted file.
                    }
                  }
                  throw error;
                } finally {
                  await releaseSessionSourceAuthorities([writer], errors);
                }
              }),
            undefined,
            initialVoiceSource.settlementContext,
          );
          const voiceSessionId = await voiceCreation;
          sessionMutationCommitGuard?.();
          if (mutationGrant) {
            mutationGrant.assertCurrent();
          } else {
            sessionMutationAuthorization?.assertTargetCurrent({
              ...sessionTarget,
              ensuredSessionId,
            });
          }
          replacement?.assertCurrent(target);
          gatewayControlOwner.assertOpen();
          rememberLegacyVoiceBinding({
            connId: ownerConnId,
            sessionKey: params.sessionKey?.trim() || sessionKey,
            voiceSessionId,
          });
          assertCommitAllowed();
          runAuthority?.accept();
          gatewayControlOwner.activate();
          const presentation = registerTalkClientPresentation({
            session,
            resolution,
            voiceSessionId,
            connId: ownerConnId,
            sessionTarget: target,
            canChangeVoice: params.capabilities?.includes("voice-selection") === true,
            voiceChangeId: params.voiceChangeId,
            providerReady,
            signal: gatewayControlOwner.signal,
          });
          unregisterVoiceSession = presentation.unregister;
          const { publicSession } = presentation;
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
          runAuthority?.release();
          unregisterVoiceSession?.();
          try {
            await gatewayControlOwner.close();
          } catch (error) {
            context.logGateway.warn(`talk browser session cleanup failed: ${formatForLog(error)}`);
          }
        }
        if (mutationGrant) {
          try {
            await mutationGrant.release();
          } catch (error) {
            context.logGateway.warn(`talk voice source cleanup failed: ${formatForLog(error)}`);
          }
        }
      }
    }
    rejectRequest(
      ErrorCodes.UNAVAILABLE,
      `Realtime provider "${resolution.provider.id}" does not support client-owned realtime sessions`,
    );
  } catch (err) {
    runAuthority?.release();
    respond(false, undefined, talkRequestError(err, "client", language));
  } finally {
    try {
      await conversationContext?.release();
    } catch (error) {
      context.logGateway.warn(`talk context snapshot cleanup failed: ${formatForLog(error)}`);
    }
  }
};
