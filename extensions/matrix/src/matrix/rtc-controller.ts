import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CallMembership } from "matrix-js-sdk/lib/matrixrtc/CallMembership.js";
import {
  MatrixRTCSessionEvent,
  type MatrixRTCSession,
} from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createMeetingRealtimeEngineBindings,
  prepareMeetingAgentRealtimeEngine,
  startMeetingAgentRealtimeEngine,
  type MeetingAgentRealtimePreparation,
  type MeetingRealtimeAudioEngineHandle,
  type MeetingRealtimeAudioTransport,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { CoreConfig, MatrixConfig } from "../types.js";
import { resolveMatrixInboundRoute } from "./monitor/route.js";
import {
  assertMatrixRtcCallAdmission,
  assertMatrixRtcEncryptionCompatibility,
  assertMatrixRtcPinnedTransports,
} from "./rtc-admission.js";
import { requestMatrixRtcCredentials, type MatrixRtcMembershipIdentity } from "./rtc-auth.js";
import { findMatrixRtcAdmission, type ResolvedMatrixRtcConfig } from "./rtc-config.js";
import { createMatrixRtcMediaTransport, type MatrixRtcMediaKey } from "./rtc-media-transport.js";
import { resolveMatrixRtcMode } from "./rtc-mode.js";
import type { MatrixClient } from "./sdk.js";
import type { MatrixRtcIncomingMediaKey } from "./sdk/matrix-rtc.js";

const KEY_WAIT_TIMEOUT_MS = 15_000;
const LEAVE_TIMEOUT_MS = 5_000;
const SLOT_ID = "m.call#ROOM";
const INCOMING_KEY_BUFFER_TTL_MS = 60_000;
const INCOMING_KEY_CLOCK_SKEW_MS = 5_000;

const MATRIX_RTC_PLATFORM = {
  id: "matrix-rtc",
  displayName: "MatrixRTC",
  logScope: "matrix rtc",
  agentConsult: {
    surface: "matrix-rtc",
    userLabel: "caller",
    assistantLabel: "assistant",
    questionSourceLabel: "live Matrix audio call",
    workingResponseLabel: "caller",
    extraSystemPrompt:
      "You are speaking in a live Matrix audio call. Match the caller's language and keep spoken replies concise and natural.",
  },
  session: {
    idPrefix: "matrix-rtc",
    participantIdentity: (transport: string) => transport,
  },
} as const;

type ActiveCall = {
  abort: AbortController;
  engine?: MeetingRealtimeAudioEngineHandle;
  preparation?: MeetingAgentRealtimePreparation;
  transport?: MeetingRealtimeAudioTransport;
  session: MatrixRTCSession;
  joined: boolean;
  stopping: boolean;
  startup?: Promise<void>;
  stopPromise?: Promise<void>;
  disposeListeners: () => void;
};

function mediaKeyId(key: MatrixRtcMediaKey): string {
  return `${key.participantIdentity}\0${key.index}`;
}

function membershipIncarnation(
  membership: Pick<CallMembership, "userId" | "deviceId" | "memberId" | "createdTs">,
): string {
  return `${membership.userId}\0${membership.deviceId}\0${membership.memberId}\0${membership.createdTs()}`;
}

async function waitForInitialMediaKeys(params: {
  keys: Map<string, MatrixRtcMediaKey>;
  remoteIdentity: string;
  ownIdentities: Set<string>;
  signal: AbortSignal;
}): Promise<MatrixRtcMediaKey[]> {
  const hasRequiredKeys = () => {
    const values = [...params.keys.values()];
    return (
      values.some((key) => key.participantIdentity === params.remoteIdentity) &&
      values.some((key) => params.ownIdentities.has(key.participantIdentity))
    );
  };
  const deadline = Date.now() + KEY_WAIT_TIMEOUT_MS;
  while (!hasRequiredKeys()) {
    if (params.signal.aborted) {
      throw new Error("MatrixRTC call start was cancelled");
    }
    if (Date.now() >= deadline) {
      throw new Error("MatrixRTC media keys did not become ready in time");
    }
    await delay(25, undefined, { signal: params.signal });
  }
  return [...params.keys.values()];
}

async function stopCall(call: ActiveCall): Promise<void> {
  call.abort.abort();
  // Startup owns every handle until it settles, even after cancellation. Only
  // then can cleanup dispose a late transport or the engine that adopted it.
  await call.startup;
  call.disposeListeners();
  try {
    if (call.engine) {
      await call.engine.stop();
    } else if (call.transport) {
      try {
        await call.transport.stop();
      } finally {
        await call.transport.dispose();
      }
    }
  } finally {
    try {
      if (call.joined) {
        await call.session.leaveRoomSession(LEAVE_TIMEOUT_MS).catch(() => false);
      }
    } finally {
      await call.preparation?.release();
    }
  }
}

export function registerMatrixRtcController(params: {
  client: MatrixClient;
  cfg: CoreConfig;
  accountConfig: MatrixConfig;
  accountId: string;
  config: ResolvedMatrixRtcConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  abortSignal?: AbortSignal;
}): { startExisting(): void; stop(): Promise<void> } {
  const calls = new Map<string, ActiveCall>();
  const failedRemoteMemberships = new Map<string, string>();
  const incomingKeys = new Map<string, MatrixRtcIncomingMediaKey[]>();
  const incomingKeyConsumers = new Map<string, (key: MatrixRtcIncomingMediaKey) => void>();
  const observedSessions = new Map<string, { session: MatrixRTCSession; dispose: () => void }>();
  let stopped = false;
  // Keep these bounded, identifier-free lifecycle markers visible while the
  // experimental inbound-call path is being proven in production. Matrix SDK
  // diagnostics contain room/device metadata and must not be enabled broadly.
  params.logger.warn("matrix rtc: controller registered");

  const disposeIncomingMediaKey = params.client.matrixRtc.onIncomingMediaKey((key) => {
    const admission = findMatrixRtcAdmission(params.config, key.roomId);
    if (!admission || key.userId !== admission.userId) {
      return;
    }
    const cutoff = Date.now() - INCOMING_KEY_BUFFER_TTL_MS;
    const buffered = (incomingKeys.get(key.roomId) ?? []).filter(
      (candidate) => candidate.receivedAt >= cutoff,
    );
    buffered.push(key);
    incomingKeys.set(key.roomId, buffered.slice(-16));
    incomingKeyConsumers.get(key.roomId)?.(key);
  });

  const stopCallSafely = async (call: ActiveCall) => {
    try {
      await stopCall(call);
    } catch (error) {
      params.logger.warn(`matrix rtc: call cleanup failed: ${formatErrorMessage(error)}`);
    }
  };

  const endCall = async (roomId: string) => {
    const call = calls.get(roomId);
    if (!call) {
      return;
    }
    if (call.stopping) {
      await call.stopPromise;
      return;
    }
    // Keep ownership in the map until leaveRoomSession finishes. The SDK emits
    // membership changes while leaving; dropping ownership first lets those
    // self-generated events re-enter beginCall and fan one failure into retries.
    call.stopping = true;
    const stopPromise = stopCallSafely(call).finally(() => {
      if (calls.get(roomId) === call) {
        calls.delete(roomId);
      }
    });
    call.stopPromise = stopPromise;
    await stopPromise;
  };

  const beginCall = (roomId: string, session: MatrixRTCSession) => {
    if (stopped || calls.has(roomId)) {
      return;
    }
    const admission = findMatrixRtcAdmission(params.config, roomId);
    if (!admission) {
      return;
    }
    const remoteIncarnations = session.memberships
      .filter((membership) => membership.userId === admission.userId)
      .map(membershipIncarnation);
    if (remoteIncarnations.length !== 1) {
      return;
    }
    const failedRemoteMembership = failedRemoteMemberships.get(roomId);
    if (failedRemoteMembership) {
      if (remoteIncarnations.includes(failedRemoteMembership)) {
        return;
      }
      failedRemoteMemberships.delete(roomId);
    }
    const abort = new AbortController();
    const disposeCallbacks: Array<() => void> = [];
    const call: ActiveCall = {
      abort,
      session,
      joined: false,
      stopping: false,
      disposeListeners: () => {
        for (const dispose of disposeCallbacks.splice(0)) {
          dispose();
        }
      },
    };
    calls.set(roomId, call);
    params.logger.warn("matrix rtc: admitted call start requested");

    call.startup = Promise.resolve().then(async () => {
      let remoteIncarnation: string | undefined;
      try {
        const self = params.client.matrixRtc.getSelfIdentity();
        const route = resolveMatrixInboundRoute({
          cfg: params.cfg,
          accountId: params.accountId,
          roomId,
          senderId: admission.userId,
          isDirectMessage: true,
          dmSessionScope: params.accountConfig.dm?.sessionScope,
          resolveAgentRoute: params.runtime.channel.routing.resolveAgentRoute,
        }).route;
        // Every beginCall edge is already membership-ready: either the initial
        // calculation resolved, or the SDK emitted MembershipsChanged / SessionStarted
        // after a fresh calculation. Re-awaiting the constructor-time promise can
        // deadlock sticky-event calls even though session.memberships is current.
        const remote = assertMatrixRtcCallAdmission({
          isDirectRoom: params.client.dms.isDm(roomId),
          joinedUserIds: params.client.matrixRtc.getJoinedUserIds(roomId),
          memberships: session.memberships,
          selfUserId: self.userId,
          allowedUserId: admission.userId,
          routedAgentId: route.agentId,
          allowedAgentId: admission.agentId,
        });
        remoteIncarnation = membershipIncarnation(remote);
        params.logger.info("matrix rtc: admission verified");
        if (session.slotId !== SLOT_ID) {
          throw new Error("MatrixRTC call uses an unsupported slot");
        }
        assertMatrixRtcEncryptionCompatibility(session.getRtcSlot()?.encryption?.type);

        const preferredTransport = await params.client.matrixRtc.getPreferredLivekitTransport();
        abort.signal.throwIfAborted();
        const remoteTransport = remote.getTransport(session.getOldestMembership() ?? remote);
        const rtcMode = resolveMatrixRtcMode(remote);
        assertMatrixRtcPinnedTransports({
          pinnedAuthServiceUrl: params.config.authServiceUrl,
          homeserverLivekitServiceUrl: preferredTransport.livekit_service_url,
          remoteTransportType: remoteTransport?.type,
          remoteLivekitServiceUrl: remoteTransport?.livekit_service_url,
        });
        if (
          rtcMode === "compatibility" &&
          (!remoteTransport ||
            !("livekit_alias" in remoteTransport) ||
            typeof remoteTransport.livekit_alias !== "string" ||
            !remoteTransport.livekit_alias)
        ) {
          throw new Error("MatrixRTC compatibility transport is missing its LiveKit alias");
        }
        params.logger.info("matrix rtc: transport verified");

        call.preparation = await prepareMeetingAgentRealtimeEngine({
          config: {
            chrome: { audioFormat: "pcm16-24khz" },
            realtime: {
              strategy: "agent",
              agentId: admission.agentId,
              transcriptionProvider: params.config.transcriptionProvider,
              responseStreaming: params.config.responseStreaming,
              waitingAudio: params.config.waitingAudio,
              providers: params.config.providers,
            },
          },
          fullConfig: params.cfg,
          runtime: params.runtime,
          ttsContext: {
            agentId: admission.agentId,
            channelId: "matrix",
            accountId: params.accountId,
          },
          signal: abort.signal,
        });
        abort.signal.throwIfAborted();
        params.logger.info("matrix rtc: speech providers ready");

        const ownMembership: MatrixRtcMembershipIdentity = {
          ...self,
          memberId: randomUUID(),
        };
        const openIdToken = await params.client.matrixRtc.getOpenIdToken();
        abort.signal.throwIfAborted();
        const credentials = await requestMatrixRtcCredentials({
          mode: rtcMode,
          authServiceUrl: params.config.authServiceUrl,
          roomId,
          slotId: SLOT_ID,
          membership: ownMembership,
          openIdToken,
          signal: abort.signal,
        });
        abort.signal.throwIfAborted();
        params.logger.info("matrix rtc: credentials authorized");

        const keys = new Map<string, MatrixRtcMediaKey>();
        const ownIdentities = new Set<string>();
        const mediaTransportRef: {
          current?: Awaited<ReturnType<typeof createMatrixRtcMediaTransport>>;
        } = {};
        const acceptMediaKey = (mediaKey: MatrixRtcMediaKey) => {
          if (abort.signal.aborted) {
            return;
          }
          keys.set(mediaKeyId(mediaKey), mediaKey);
          try {
            mediaTransportRef.current?.sendKey(mediaKey);
          } catch {
            void endCall(roomId);
          }
        };
        const onKey = (
          key: Uint8Array<ArrayBuffer>,
          index: number,
          membership: MatrixRtcMembershipIdentity,
          rtcBackendIdentity: string,
        ) => {
          // Remote to-device keys are accepted only through the facade's
          // ReceivedToDeviceMessage path, where encrypted sender/device
          // metadata is still available for validation. This SDK callback is
          // also fed by its deprecated compatibility event, which cannot
          // reliably prove that a remote key was encrypted.
          const isOwn =
            membership.userId === self.userId &&
            membership.deviceId === self.deviceId &&
            membership.memberId === ownMembership.memberId;
          if (!isOwn) {
            return;
          }
          ownIdentities.add(rtcBackendIdentity);
          const mediaKey = {
            participantIdentity: rtcBackendIdentity,
            index,
            key: Uint8Array.from(key),
          };
          acceptMediaKey(mediaKey);
        };
        const acceptIncomingKey = (incoming: MatrixRtcIncomingMediaKey) => {
          const membershipCreatedAt = remote.createdTs();
          if (
            incoming.userId !== remote.userId ||
            incoming.deviceId !== remote.deviceId ||
            (rtcMode === "matrix_2_0" && incoming.memberId !== remote.memberId) ||
            incoming.receivedAt < membershipCreatedAt - INCOMING_KEY_CLOCK_SKEW_MS ||
            (incoming.sentAt !== undefined &&
              incoming.sentAt < membershipCreatedAt - INCOMING_KEY_CLOCK_SKEW_MS)
          ) {
            return;
          }
          const mediaKey = {
            participantIdentity: remote.rtcBackendIdentity,
            index: incoming.index,
            key: Uint8Array.from(incoming.key),
          };
          acceptMediaKey(mediaKey);
          params.logger.info("matrix rtc: encrypted remote media key accepted");
        };
        incomingKeyConsumers.set(roomId, acceptIncomingKey);
        disposeCallbacks.push(() => {
          if (incomingKeyConsumers.get(roomId) === acceptIncomingKey) {
            incomingKeyConsumers.delete(roomId);
          }
        });
        for (const incoming of incomingKeys.get(roomId) ?? []) {
          acceptIncomingKey(incoming);
        }
        session.on(MatrixRTCSessionEvent.EncryptionKeyChanged, onKey);
        disposeCallbacks.push(() => session.off(MatrixRTCSessionEvent.EncryptionKeyChanged, onKey));
        const onMembershipsChanged = () => {
          try {
            const currentRemote = assertMatrixRtcCallAdmission({
              isDirectRoom: params.client.dms.isDm(roomId),
              joinedUserIds: params.client.matrixRtc.getJoinedUserIds(roomId),
              memberships: session.memberships,
              selfUserId: self.userId,
              allowedUserId: admission.userId,
              routedAgentId: route.agentId,
              allowedAgentId: admission.agentId,
            });
            if (resolveMatrixRtcMode(currentRemote) !== rtcMode) {
              throw new Error("MatrixRTC membership mode changed during the call");
            }
          } catch {
            void endCall(roomId);
          }
        };
        session.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);
        disposeCallbacks.push(() =>
          session.off(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged),
        );

        const ownTransport = rtcMode === "compatibility" ? remoteTransport! : preferredTransport;
        session.joinRTCSession(
          ownMembership,
          [ownTransport],
          rtcMode === "compatibility" ? undefined : ownTransport,
          {
            callIntent: "audio",
            manageMediaKeys: true,
            unstableSendStickyEvents: rtcMode === "matrix_2_0",
          },
        );
        call.joined = true;
        params.logger.info("matrix rtc: local membership joined");
        session.reemitEncryptionKeys();
        const initialKeys = await waitForInitialMediaKeys({
          keys,
          remoteIdentity: remote.rtcBackendIdentity,
          ownIdentities,
          signal: abort.signal,
        });
        params.logger.info("matrix rtc: initial media keys ready");
        if (abort.signal.aborted) {
          throw new Error("MatrixRTC call start was cancelled");
        }
        const mediaTransport = await createMatrixRtcMediaTransport({
          command: params.config.mediaBridgeCommand,
          url: credentials.url,
          token: credentials.token,
          allowedRemoteIdentity: remote.rtcBackendIdentity,
          initialKeys,
        });
        mediaTransportRef.current = mediaTransport;
        call.transport = mediaTransport;
        params.logger.info("matrix rtc: media transport connected");
        if (abort.signal.aborted) {
          throw new Error("MatrixRTC call start was cancelled");
        }
        // Key events continue during bridge startup. Reconcile the latest map
        // before starting audio; subsequent accepted rotations go straight through.
        for (const key of keys.values()) {
          if (!initialKeys.includes(key)) {
            mediaTransport.sendKey(key);
          }
        }
        const bindings = createMeetingRealtimeEngineBindings({
          platform: MATRIX_RTC_PLATFORM,
          config: {
            realtime: {
              agentId: admission.agentId,
              toolPolicy: params.config.toolPolicy,
            },
          },
          fullConfig: params.cfg,
          runtime: params.runtime,
          logger: params.logger,
        });
        call.engine = await startMeetingAgentRealtimeEngine({
          config: {
            chrome: { audioFormat: "pcm16-24khz" },
            realtime: {
              strategy: "agent",
              agentId: admission.agentId,
              transcriptionProvider: params.config.transcriptionProvider,
              responseStreaming: params.config.responseStreaming,
              waitingAudio: params.config.waitingAudio,
              providers: params.config.providers,
            },
          },
          fullConfig: params.cfg,
          runtime: params.runtime,
          platform: bindings.platform,
          meetingSessionId: randomUUID(),
          requesterSessionKey: route.sessionKey,
          ttsContext: {
            agentId: admission.agentId,
            channelId: "matrix",
            accountId: params.accountId,
          },
          transport: mediaTransport,
          logger: params.logger,
          consultAgent: bindings.consultAgent,
        });
        call.transport = undefined;
        abort.signal.throwIfAborted();
        params.logger.info("matrix rtc: admitted encrypted direct audio call");
      } catch (error) {
        if (remoteIncarnation) {
          failedRemoteMemberships.set(roomId, remoteIncarnation);
        }
        params.logger.warn(`matrix rtc: call start failed: ${formatErrorMessage(error)}`);
        // Cleanup waits for startup; awaiting it here would wait on ourselves.
        void endCall(roomId);
      }
    });
  };

  const observeSession = (roomId: string, session: MatrixRTCSession) => {
    const existing = observedSessions.get(roomId);
    if (existing?.session === session) {
      return;
    }
    existing?.dispose();

    const reconcile = () => {
      if (stopped) {
        return;
      }
      if (session.memberships.length > 0) {
        params.logger.warn("matrix rtc: admitted room membership active");
        beginCall(roomId, session);
      } else {
        failedRemoteMemberships.delete(roomId);
        params.logger.warn("matrix rtc: admitted room membership empty");
        void endCall(roomId);
      }
    };
    session.on(MatrixRTCSessionEvent.MembershipsChanged, reconcile);
    const dispose = () => session.off(MatrixRTCSessionEvent.MembershipsChanged, reconcile);
    observedSessions.set(roomId, { session, dispose });
    params.logger.warn("matrix rtc: admitted room session observed");
    void session.initialMembershipCalculated.then(reconcile, (error: unknown) => {
      params.logger.warn(
        `matrix rtc: initial membership calculation failed: ${formatErrorMessage(error)}`,
      );
    });
  };

  const attachAdmittedSession = (
    roomId: string,
    source: "startup" | "room-available" | "membership-event",
  ) => {
    if (!findMatrixRtcAdmission(params.config, roomId)) {
      return;
    }
    if (source === "membership-event") {
      params.logger.warn("matrix rtc: admitted membership event observed");
    }
    const session = params.client.matrixRtc.getRoomSession(roomId);
    if (!session) {
      params.logger.warn(
        source === "startup"
          ? "matrix rtc: admitted room pending initial sync"
          : "matrix rtc: admitted room session unavailable",
      );
      return;
    }
    observeSession(roomId, session);
    params.logger.warn(`matrix rtc: admitted session attached from ${source}`);
    if (session.memberships.length > 0) {
      beginCall(roomId, session);
    }
  };

  const disposeStarted = params.client.matrixRtc.onSessionStarted((roomId, session) => {
    if (!findMatrixRtcAdmission(params.config, roomId)) {
      return;
    }
    observeSession(roomId, session);
    beginCall(roomId, session);
  });
  const disposeEnded = params.client.matrixRtc.onSessionEnded((roomId) => {
    void endCall(roomId);
  });
  const disposeRoomAvailable = params.client.matrixRtc.onRoomAvailable((roomId) => {
    attachAdmittedSession(roomId, "room-available");
  });
  const disposeRtcMembershipEvent = params.client.matrixRtc.onRtcMembershipEvent((roomId) => {
    attachAdmittedSession(roomId, "membership-event");
  });
  const abortListener = () => {
    void stop();
  };
  params.abortSignal?.addEventListener("abort", abortListener, { once: true });

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    disposeStarted();
    disposeEnded();
    disposeRoomAvailable();
    disposeRtcMembershipEvent();
    for (const observed of observedSessions.values()) {
      observed.dispose();
    }
    observedSessions.clear();
    failedRemoteMemberships.clear();
    incomingKeys.clear();
    incomingKeyConsumers.clear();
    disposeIncomingMediaKey();
    params.abortSignal?.removeEventListener("abort", abortListener);
    await Promise.all([...calls.keys()].map((roomId) => endCall(roomId)));
  };

  return {
    startExisting() {
      for (const admission of params.config.admissions) {
        // Pin and observe the canonical room session. matrix-js-sdk can update a
        // sticky RTC membership before its manager emits SessionStarted, so the
        // per-session membership signal is the reliable lifecycle boundary.
        attachAdmittedSession(admission.roomId, "startup");
      }
    },
    stop,
  };
}
