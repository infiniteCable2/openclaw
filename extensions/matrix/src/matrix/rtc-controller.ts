import { randomUUID } from "node:crypto";
import {
  MatrixRTCSessionEvent,
  type MatrixRTCSession,
} from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import { RTC_SLOT_ENCRYPTION_PER_MEMBER } from "matrix-js-sdk/lib/matrixrtc/types.js";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createMeetingRealtimeEngineBindings,
  startMeetingAgentRealtimeEngine,
  type MeetingRealtimeAudioEngineHandle,
  type MeetingRealtimeAudioTransport,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { CoreConfig, MatrixConfig } from "../types.js";
import { resolveMatrixInboundRoute } from "./monitor/route.js";
import { assertMatrixRtcCallAdmission, assertMatrixRtcPinnedTransports } from "./rtc-admission.js";
import { requestMatrixRtcCredentials, type MatrixRtcMembershipIdentity } from "./rtc-auth.js";
import { findMatrixRtcAdmission, type ResolvedMatrixRtcConfig } from "./rtc-config.js";
import { createMatrixRtcMediaTransport, type MatrixRtcMediaKey } from "./rtc-media-transport.js";
import type { MatrixClient } from "./sdk.js";

const KEY_WAIT_TIMEOUT_MS = 15_000;
const LEAVE_TIMEOUT_MS = 5_000;
const SLOT_ID = "m.call#ROOM";

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
  transport?: MeetingRealtimeAudioTransport;
  session: MatrixRTCSession;
  joined: boolean;
  disposeListeners: () => void;
};

function mediaKeyId(key: MatrixRtcMediaKey): string {
  return `${key.participantIdentity}\0${key.index}`;
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
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return [...params.keys.values()];
}

async function stopCall(call: ActiveCall): Promise<void> {
  call.abort.abort();
  call.disposeListeners();
  try {
    if (call.engine) {
      await call.engine.stop();
    } else if (call.transport) {
      await call.transport.stop();
      await call.transport.dispose();
    }
  } finally {
    if (call.joined) {
      await call.session.leaveRoomSession(LEAVE_TIMEOUT_MS).catch(() => false);
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
  const observedSessions = new Map<string, { session: MatrixRTCSession; dispose: () => void }>();
  let stopped = false;

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
    calls.delete(roomId);
    await stopCallSafely(call);
  };

  const beginCall = (roomId: string, session: MatrixRTCSession) => {
    if (stopped || calls.has(roomId)) {
      return;
    }
    const admission = findMatrixRtcAdmission(params.config, roomId);
    if (!admission) {
      return;
    }
    const abort = new AbortController();
    const disposeCallbacks: Array<() => void> = [];
    const call: ActiveCall = {
      abort,
      session,
      joined: false,
      disposeListeners: () => {
        for (const dispose of disposeCallbacks.splice(0)) {
          dispose();
        }
      },
    };
    calls.set(roomId, call);

    void (async () => {
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
        await session.initialMembershipCalculated;
        const remote = assertMatrixRtcCallAdmission({
          isDirectRoom: params.client.dms.isDm(roomId),
          joinedUserIds: params.client.matrixRtc.getJoinedUserIds(roomId),
          memberships: session.memberships,
          selfUserId: self.userId,
          allowedUserId: admission.userId,
          routedAgentId: route.agentId,
          allowedAgentId: admission.agentId,
        });
        if (session.slotId !== SLOT_ID) {
          throw new Error("MatrixRTC call uses an unsupported slot");
        }
        if (session.getRtcSlot()?.encryption?.type !== RTC_SLOT_ENCRYPTION_PER_MEMBER) {
          throw new Error(
            "MatrixRTC call does not advertise supported per-member media encryption",
          );
        }

        const preferredTransport = await params.client.matrixRtc.getPreferredLivekitTransport();
        const remoteTransport = remote.getTransport(session.getOldestMembership() ?? remote);
        assertMatrixRtcPinnedTransports({
          pinnedAuthServiceUrl: params.config.authServiceUrl,
          homeserverLivekitServiceUrl: preferredTransport.livekit_service_url,
          remoteTransportType: remoteTransport?.type,
          remoteLivekitServiceUrl: remoteTransport?.livekit_service_url,
        });

        const ownMembership: MatrixRtcMembershipIdentity = {
          ...self,
          memberId: randomUUID(),
        };
        const credentials = await requestMatrixRtcCredentials({
          authServiceUrl: params.config.authServiceUrl,
          roomId,
          slotId: SLOT_ID,
          membership: ownMembership,
          openIdToken: await params.client.matrixRtc.getOpenIdToken(),
          signal: abort.signal,
        });

        const keys = new Map<string, MatrixRtcMediaKey>();
        const ownIdentities = new Set<string>();
        const mediaTransportRef: {
          current?: Awaited<ReturnType<typeof createMatrixRtcMediaTransport>>;
        } = {};
        const onKey = (
          key: Uint8Array<ArrayBuffer>,
          index: number,
          membership: MatrixRtcMembershipIdentity,
          rtcBackendIdentity: string,
        ) => {
          const isOwn = membership.memberId === ownMembership.memberId;
          const isRemote =
            membership.userId === admission.userId &&
            membership.deviceId === remote.deviceId &&
            membership.memberId === remote.memberId &&
            rtcBackendIdentity === remote.rtcBackendIdentity;
          if (!isOwn && !isRemote) {
            return;
          }
          if (isOwn) {
            ownIdentities.add(rtcBackendIdentity);
          }
          const mediaKey = {
            participantIdentity: rtcBackendIdentity,
            index,
            key: Uint8Array.from(key),
          };
          keys.set(mediaKeyId(mediaKey), mediaKey);
          if (mediaTransportRef.current) {
            try {
              mediaTransportRef.current.sendKey(mediaKey);
            } catch {
              abort.abort();
            }
          }
        };
        session.on(MatrixRTCSessionEvent.EncryptionKeyChanged, onKey);
        disposeCallbacks.push(() => session.off(MatrixRTCSessionEvent.EncryptionKeyChanged, onKey));
        const onMembershipsChanged = () => {
          try {
            assertMatrixRtcCallAdmission({
              isDirectRoom: params.client.dms.isDm(roomId),
              joinedUserIds: params.client.matrixRtc.getJoinedUserIds(roomId),
              memberships: session.memberships,
              selfUserId: self.userId,
              allowedUserId: admission.userId,
              routedAgentId: route.agentId,
              allowedAgentId: admission.agentId,
            });
          } catch {
            void endCall(roomId);
          }
        };
        session.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);
        disposeCallbacks.push(() =>
          session.off(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged),
        );

        session.joinRTCSession(ownMembership, [preferredTransport], preferredTransport, {
          callIntent: "audio",
          manageMediaKeys: true,
          unstableSendStickyEvents: true,
        });
        call.joined = true;
        session.reemitEncryptionKeys();
        const initialKeys = await waitForInitialMediaKeys({
          keys,
          remoteIdentity: remote.rtcBackendIdentity,
          ownIdentities,
          signal: abort.signal,
        });
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
        if (abort.signal.aborted) {
          throw new Error("MatrixRTC call start was cancelled");
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
              providers: params.config.providers,
            },
          },
          fullConfig: params.cfg,
          runtime: params.runtime,
          platform: bindings.platform,
          meetingSessionId: randomUUID(),
          requesterSessionKey: route.sessionKey,
          transport: mediaTransport,
          logger: params.logger,
          consultAgent: bindings.consultAgent,
        });
        call.transport = undefined;
        params.logger.info("matrix rtc: admitted encrypted direct audio call");
      } catch (error) {
        params.logger.warn(`matrix rtc: call start failed: ${formatErrorMessage(error)}`);
        await endCall(roomId);
      }
    })();
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
        beginCall(roomId, session);
      } else {
        void endCall(roomId);
      }
    };
    session.on(MatrixRTCSessionEvent.MembershipsChanged, reconcile);
    const dispose = () => session.off(MatrixRTCSessionEvent.MembershipsChanged, reconcile);
    observedSessions.set(roomId, { session, dispose });
    void session.initialMembershipCalculated.then(reconcile, (error: unknown) => {
      params.logger.warn(
        `matrix rtc: initial membership calculation failed: ${formatErrorMessage(error)}`,
      );
    });
  };

  const disposeStarted = params.client.matrixRtc.onSessionStarted((roomId, session) => {
    observeSession(roomId, session);
    beginCall(roomId, session);
  });
  const disposeEnded = params.client.matrixRtc.onSessionEnded((roomId) => {
    void endCall(roomId);
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
    for (const observed of observedSessions.values()) {
      observed.dispose();
    }
    observedSessions.clear();
    params.abortSignal?.removeEventListener("abort", abortListener);
    const active = [...calls.entries()];
    calls.clear();
    await Promise.all(active.map(([, call]) => stopCallSafely(call)));
  };

  return {
    startExisting() {
      for (const admission of params.config.admissions) {
        // Pin and observe the canonical room session. matrix-js-sdk can update a
        // sticky RTC membership before its manager emits SessionStarted, so the
        // per-session membership signal is the reliable lifecycle boundary.
        const session = params.client.matrixRtc.getRoomSession(admission.roomId);
        if (session) {
          observeSession(admission.roomId, session);
        }
      }
    },
    stop,
  };
}
