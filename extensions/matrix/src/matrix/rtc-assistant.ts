import type { CallMembership } from "matrix-js-sdk/lib/matrixrtc/CallMembership.js";
import {
  MatrixRTCSessionEvent,
  type MatrixRTCSession,
} from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixRtcClientFacade } from "./sdk/matrix-rtc.js";

export const MATRIX_RTC_CONVERSATION_KEY = "io.openclaw.conversation";
const ASSISTANT_PURPOSE = "assistant-voice";

function offersCaptions(membership: Pick<CallMembership, "applicationData">) {
  const value = membership.applicationData[MATRIX_RTC_CONVERSATION_KEY];
  return isRecord(value) && value.captions === true;
}

/** Presentation only: the controller must first admit the native Matrix membership. */
export function readMatrixRtcConversationRequest(applicationData: Record<string, unknown>) {
  const value = applicationData[MATRIX_RTC_CONVERSATION_KEY];
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.purpose !== ASSISTANT_PURPOSE && value.purpose !== "call") ||
    typeof value.request_id !== "string" ||
    value.request_id.length < 1 ||
    value.request_id.length > 128 ||
    /[^A-Za-z0-9_-]/.test(value.request_id)
  ) {
    throw new Error("MatrixRTC assistant conversation request is invalid");
  }
  return { requestId: value.request_id, purpose: value.purpose };
}

/** Project real speech readiness onto our existing membership, without owning the call. */
export function createMatrixRtcConversationPresentation(params: {
  session: MatrixRTCSession;
  sessionId: string;
  request: ReturnType<typeof readMatrixRtcConversationRequest>;
  caller: Pick<CallMembership, "userId" | "deviceId" | "memberId" | "applicationData">;
  self: { userId: string; deviceId: string };
  assertCurrent(): CallMembership;
  onEnd(): unknown;
  dispose(close: () => void): void;
  roomId: string;
  client: Pick<MatrixRtcClientFacade, "sendEncryptedToDevice">;
  logger: { warn(message: string): void };
}) {
  if (!params.request) {
    return undefined;
  }
  const { requestId, purpose } = params.request;
  const failReadiness = () => {
    params.logger.warn("matrix rtc: assistant readiness publication failed");
    void params.onEnd();
  };
  const preparing = {
    version: 1,
    purpose,
    request_id: requestId,
    caller: {
      user_id: params.caller.userId,
      device_id: params.caller.deviceId,
      member_id: params.caller.memberId,
    },
    state: "preparing",
  };
  let speechReady = false;
  let started = false;
  let closed = false;
  let publishing = false;
  let acknowledgedCaptions: boolean | undefined;
  let captionSequence = 0;
  let captionQueue = Promise.resolve();
  const publish = () => {
    if (!speechReady || !started || closed || publishing) {
      return;
    }
    try {
      const currentCaller = params.assertCurrent();
      const captions = offersCaptions(currentCaller);
      if (acknowledgedCaptions === captions) {
        return;
      }
      // SDK updateApplicationData requires our own membership to have returned via sync.
      // The request also distinguishes previous legacy calls with the same user/device.
      const own = params.session.memberships.find((membership) => {
        const value = membership.applicationData[MATRIX_RTC_CONVERSATION_KEY];
        return (
          membership.userId === params.self.userId &&
          membership.deviceId === params.self.deviceId &&
          isRecord(value) &&
          value.version === 1 &&
          value.purpose === purpose &&
          value.request_id === requestId &&
          isRecord(value.caller) &&
          value.caller.user_id === params.caller.userId &&
          value.caller.device_id === params.caller.deviceId &&
          value.caller.member_id === params.caller.memberId
        );
      });
      if (!own) {
        return;
      }
      publishing = true;
      void params.session
        .updateApplicationData({
          ...own.applicationData,
          [MATRIX_RTC_CONVERSATION_KEY]: {
            ...preparing,
            state: "ready",
            captions,
          },
        })
        .then(() => {
          publishing = false;
          if (!closed) {
            acknowledgedCaptions = captions;
            publish();
          }
        })
        .catch(() => {
          publishing = false;
          if (!closed) {
            if (acknowledgedCaptions === undefined) {
              failReadiness();
            } else {
              params.logger.warn("matrix rtc: caption capability publication failed");
            }
          }
        });
    } catch {
      failReadiness();
    }
  };
  // The SDK emits this event before updating its own membership manager. Publish
  // after that update, rechecking the current caller and lifecycle in publish().
  const onMembershipsChanged = () => queueMicrotask(publish);
  params.session.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);
  const close = () => {
    closed = true;
    params.session.off(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);
  };
  params.dispose(close);
  const speechCallbacks = {
    onSpeechCaption(caption: { role: "user" | "assistant"; text: string }) {
      if (closed || publishing || acknowledgedCaptions !== true || !caption.text.trim()) {
        return;
      }
      // Serialize encryption/queue admission, never audio. The SDK owns network
      // retries; a client must reject delayed captions from an older request.
      captionQueue = captionQueue
        .then(async () => {
          if (closed || publishing || acknowledgedCaptions !== true) {
            return;
          }
          if (!offersCaptions(params.assertCurrent())) {
            return;
          }
          await params.client.sendEncryptedToDevice(
            { userId: params.caller.userId, deviceId: params.caller.deviceId },
            "io.openclaw.conversation.caption",
            {
              version: 1,
              room_id: params.roomId,
              request_id: requestId,
              seq: ++captionSequence,
              role: caption.role,
              text: caption.text,
            },
          );
        })
        .catch(() => {
          if (!closed) {
            params.logger.warn("matrix rtc: assistant caption queue admission failed");
          }
        });
    },
    onTalkEvent(event: { type: string; sessionId: string }) {
      if (closed || event.sessionId !== params.sessionId) {
        return;
      }
      if (event.type === "session.ready") {
        speechReady = true;
        publish();
      } else if (event.type === "session.closed") {
        close();
        void params.onEnd();
      }
      // A session.error can describe one failed input in an otherwise usable call.
    },
  };
  return {
    applicationData: { [MATRIX_RTC_CONVERSATION_KEY]: preparing },
    speechCallbacks,
    started() {
      started = true;
      publish();
    },
  };
}
