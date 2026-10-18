import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkSessionAcknowledgeMarkParams,
  validateTalkSessionCancelOutputParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { getUnifiedTalkSession } from "../../../talk/session-registry.js";
import type { GatewayRequestHandlers, RespondFn } from "../../server-methods/types.js";
import { defineValidatedGatewayHandler } from "../../server-methods/validation.js";
import {
  acknowledgeTalkRealtimeRelayMark,
  cancelTalkRealtimeRelayTurn,
} from "../relay/operations.js";
import { talkRequestError } from "../request-error.js";
import { requireUnifiedTalkSessionConn } from "../session-registry.js";

function invalid(respond: RespondFn, message: string) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

/** Output-only controls remain bound to the original live connection, not its task lane. */
export const talkSessionOutputHandlers: GatewayRequestHandlers = {
  "talk.session.cancelOutput": defineValidatedGatewayHandler(
    "talk.session.cancelOutput",
    validateTalkSessionCancelOutputParams,
    async ({ params, respond, client }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "speech-relay") {
        requireUnifiedTalkSessionConn(session, client?.connId);
        const result = session.cancelOutput({
          turnId: normalizeOptionalString(params.turnId),
          reason: normalizeOptionalString(params.reason) ?? "output-cancelled",
        });
        respond(true, { ok: true, ...result }, undefined);
        return;
      }
      if (session.kind !== "realtime-relay") {
        invalid(respond, "talk.session.cancelOutput requires realtime relay");
        return;
      }
      const connId = requireUnifiedTalkSessionConn(session, client?.connId);
      const result = await cancelTalkRealtimeRelayTurn({
        relaySessionId: session.relaySessionId,
        connId,
        reason: normalizeOptionalString(params.reason) ?? "output-cancelled",
        turnId: normalizeOptionalString(params.turnId),
      });
      respond(true, { ok: true, ...result }, undefined);
    },
    (error) => talkRequestError(error, "session"),
  ),
  "talk.session.acknowledgeMark": defineValidatedGatewayHandler(
    "talk.session.acknowledgeMark",
    validateTalkSessionAcknowledgeMarkParams,
    ({ params, respond, client }) => {
      try {
        const session = getUnifiedTalkSession(params.sessionId);
        if (session.kind === "speech-relay") {
          requireUnifiedTalkSessionConn(session, client?.connId);
          session.acknowledgeMark(params.markName);
          respond(true, { ok: true }, undefined);
          return;
        }
        if (session.kind !== "realtime-relay") {
          invalid(respond, "talk.session.acknowledgeMark requires realtime relay");
          return;
        }
        acknowledgeTalkRealtimeRelayMark({
          relaySessionId: session.relaySessionId,
          connId: requireUnifiedTalkSessionConn(session, client?.connId),
          markName: params.markName,
        });
        respond(true, { ok: true }, undefined);
      } catch (error) {
        respond(false, undefined, talkRequestError(error, "legacy-relay"));
      }
    },
  ),
};
