import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkSessionAppendAudioParams,
  validateTalkSessionSteerParams,
  validateTalkSessionSubmitToolResultParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { operatorScopeSatisfied } from "../../../shared/operator-scope-compat.js";
import { captureGatewayOperatorRunAuthority } from "../../operator-run-authority.js";
import type { GatewayRequestHandlers, RespondFn } from "../../server-methods/types.js";
import { defineValidatedGatewayHandler } from "../../server-methods/validation.js";
import { resolveTalkAgentConsultAuthority } from "../client-tool-authority.js";
import { getTalkHandoff } from "../handoff.js";
import {
  sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun,
  submitTalkRealtimeRelayToolResult,
} from "../relay/operations.js";
import { talkRequestError } from "../request-error.js";
import { getUnifiedTalkSession, requireUnifiedTalkSessionConn } from "../session-registry.js";
import { sendTalkTranscriptionRelayAudio } from "../transcription-relay.js";

function respondInvalidRequest(respond: RespondFn, message: string) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

const talkSessionError = (error: unknown) => talkRequestError(error, "session");

function respondOk(respond: RespondFn, payload: unknown = { ok: true }) {
  respond(true, payload, undefined);
}

/** Input and steering retain the exact already-admitted connection target. */
export const talkSessionInputHandlers: GatewayRequestHandlers = {
  "talk.session.appendAudio": defineValidatedGatewayHandler(
    "talk.session.appendAudio",
    validateTalkSessionAppendAudioParams,
    async ({ params, respond, client }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (
        !operatorScopeSatisfied("operator.talk", client?.connect.scopes ?? []) &&
        (session.kind !== "transcription-relay" || !session.sessionTarget)
      ) {
        respondInvalidRequest(respond, "Session dictation cannot control a Talk session");
        return;
      }
      if (params.endOfInput && session.kind !== "speech-relay") {
        throw new Error("endOfInput requires an STT/TTS speech relay session");
      }
      if (params.captureId !== undefined && session.kind !== "speech-relay") {
        throw new Error("captureId requires an STT/TTS speech relay session");
      }
      if (session.kind === "speech-relay") {
        requireUnifiedTalkSessionConn(session, client?.connId);
        await session.appendAudio(params.audioBase64, params.endOfInput, params.captureId);
      } else if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        await sendTalkRealtimeRelayAudio({
          relaySessionId: session.relaySessionId,
          connId,
          audioBase64: params.audioBase64,
          timestamp: params.timestamp,
        });
      } else if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        sendTalkTranscriptionRelayAudio({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
          audioBase64: params.audioBase64,
        });
      } else {
        respondInvalidRequest(
          respond,
          "talk.session.appendAudio is not supported for managed-room sessions",
        );
        return;
      }
      respondOk(respond);
    },
    talkSessionError,
  ),
  "talk.session.submitToolResult": defineValidatedGatewayHandler(
    "talk.session.submitToolResult",
    validateTalkSessionSubmitToolResultParams,
    async ({ params, respond, client }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "realtime-relay") {
        respondInvalidRequest(
          respond,
          "talk.session.submitToolResult is only supported for realtime relay sessions",
        );
        return;
      }
      const connId = requireUnifiedTalkSessionConn(session, client?.connId);
      await submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId,
        callId: params.callId,
        result: params.result,
        options: params.options,
      });
      respondOk(respond);
    },
    talkSessionError,
  ),
  "talk.session.steer": defineValidatedGatewayHandler(
    "talk.session.steer",
    validateTalkSessionSteerParams,
    async ({
      params,
      respond,
      client,
      context,
      hasCurrentClientAuthority,
      sessionMutationAuthorization,
    }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "speech-relay") {
        requireUnifiedTalkSessionConn(session, client?.connId);
        const assertCurrent = () => {
          sessionMutationAuthorization?.assertCurrent();
          if (
            getUnifiedTalkSession(params.sessionId) !== session ||
            (sessionMutationAuthorization?.talkSessionTarget &&
              sessionMutationAuthorization.talkSessionTarget !== session.sessionTarget) ||
            (params.sessionKey &&
              params.sessionKey !== session.sessionTarget.sessionKey &&
              params.sessionKey !== session.sessionTarget.canonicalKey)
          ) {
            throw new Error("Talk speech session changed while steering the agent run");
          }
        };
        assertCurrent();
        respondOk(
          respond,
          await session.steer({ text: params.text, mode: params.mode, assertCurrent }),
        );
        return;
      }
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        const assertCurrent = () => {
          sessionMutationAuthorization?.assertCurrent();
          if (
            getUnifiedTalkSession(params.sessionId) !== session ||
            (sessionMutationAuthorization?.talkSessionTarget &&
              sessionMutationAuthorization.talkSessionTarget !== session.sessionTarget)
          ) {
            throw new Error("Talk session changed while steering the agent run");
          }
        };
        assertCurrent();
        const captured = await captureGatewayOperatorRunAuthority({
          client: client ?? null,
          context,
          hasCurrentClientAuthority,
        });
        try {
          const result = await steerTalkRealtimeRelayAgentRun({
            relaySessionId: session.relaySessionId,
            connId,
            authority: {
              ...resolveTalkAgentConsultAuthority(client?.connect?.scopes, client),
              operatorAuthority: captured?.authority,
            },
            sessionKey: normalizeOptionalString(params.sessionKey),
            text: params.text,
            mode: params.mode,
            assertCurrent,
          });
          respondOk(respond, result);
        } finally {
          captured?.release();
        }
        return;
      }
      if (session.kind === "transcription-relay") {
        respondInvalidRequest(respond, "talk.session.steer requires an agent-backed Talk session");
        return;
      }
      // Managed rooms have no client admission route; creating a handoff grants no run authority.
      if (session.kind === "managed-room" && client?.connId) {
        getTalkHandoff(session.handoffId);
      }
      respondInvalidRequest(
        respond,
        "talk.session.steer requires the active managed-room connection",
      );
    },
    talkSessionError,
  ),
};
