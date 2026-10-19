import {
  ErrorCodes,
  errorShape,
  validateTalkSessionCloseParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { forgetUnifiedTalkSession, getUnifiedTalkSession } from "../../../talk/session-registry.js";
import type { GatewayRequestHandlers } from "../../server-methods/types.js";
import { defineValidatedGatewayHandler } from "../../server-methods/validation.js";
import { getTalkHandoff, revokeTalkHandoff } from "../handoff.js";
import { stopTalkRealtimeRelaySession } from "../relay/operations.js";
import { talkRequestError } from "../request-error.js";
import { requireUnifiedTalkSessionConn } from "../session-registry.js";
import { stopTalkTranscriptionRelaySession } from "../transcription-relay.js";

/** Closing tears down only the native connection owner, never another session's accepted work. */
export const talkSessionLifecycleHandlers: GatewayRequestHandlers = {
  "talk.session.close": defineValidatedGatewayHandler(
    "talk.session.close",
    validateTalkSessionCloseParams,
    async ({ params, respond, client }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        await stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId });
      } else if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        stopTalkTranscriptionRelaySession({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
        });
      } else if (session.kind === "speech-relay") {
        requireUnifiedTalkSessionConn(session, client?.connId);
        await session.close();
      } else if (session.kind === "managed-room") {
        getTalkHandoff(session.handoffId);
        revokeTalkHandoff(session.handoffId);
      } else {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "External speech connections retain their native owner",
          ),
        );
        return;
      }
      forgetUnifiedTalkSession(params.sessionId);
      respond(true, { ok: true }, undefined);
    },
    (error) => talkRequestError(error, "session"),
  ),
};
