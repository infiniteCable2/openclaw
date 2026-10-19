import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  captureClientVoiceSessionSettlement,
  withClientVoiceSessionSettlement,
} from "../../../talk/client-voice-session-lifecycle.js";
import {
  captureClientVoiceSessionSource,
  type ClientVoiceSessionSource,
} from "../../../talk/client-voice-session-source.js";
import {
  appendRelayVoiceTranscript,
  closeRelayVoiceSessionRecord,
  createOrResumeClientVoiceSession,
} from "../../../talk/client-voice-session.js";
import type { PreparedVoiceTranscriptAudience } from "../../../talk/voice-transcript-audience.types.js";
import {
  normalizeVoiceTranscriptText,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "../../../talk/voice-transcript.js";
import { sleep } from "../../../utils/sleep.js";
import type { RelaySession } from "./state.js";

// Both provider-native and server STT/TTS relays use the same durable voice
// record, confirmation barrier and transcript queue. Media orchestration is not
// part of that custody contract.
export type RelayVoiceSessionOwner = Pick<
  RelaySession,
  | "id"
  | "sessionTarget"
  | "provider"
  | "voiceConfig"
  | "participant"
  | "preparePrivateAudience"
  | "context"
  | "voiceSessionCreated"
  | "voiceTranscriptSeq"
  | "voiceTranscriptQueue"
  | "confirmationReadiness"
  | "voiceSessionClose"
  | "failSession"
> & { closing?: unknown };

const RELAY_TRANSCRIPT_RETRY_DELAYS_MS = [0, 500, 2_000] as const;

function logRelayVoiceFailure(
  session: RelayVoiceSessionOwner,
  message: string,
  error: unknown,
): void {
  session.context.logGateway?.warn(`${message}: ${formatErrorMessage(error)}`);
}

function createRequiredRelayVoiceSession(
  session: RelayVoiceSessionOwner,
  source?: ClientVoiceSessionSource,
): void {
  if (session.voiceSessionCreated) {
    return;
  }
  const { agentId, sessionKey } = session.sessionTarget;
  createOrResumeClientVoiceSession(
    {
      agentId,
      sessionKey,
      provider: session.provider,
      origin: "relay",
      voiceSessionId: session.id,
    },
    source,
  );
  session.voiceSessionCreated = true;
}

export function ensureRelayVoiceSession(
  session: RelayVoiceSessionOwner,
  source?: ClientVoiceSessionSource,
): boolean {
  try {
    createRequiredRelayVoiceSession(session, source);
    return true;
  } catch (error) {
    logRelayVoiceFailure(session, "realtime relay voice session create failed", error);
    return false;
  }
}

export function enqueueRelayVoiceTranscript(
  session: RelayVoiceSessionOwner,
  role: "user" | "assistant",
  text: string,
  retainedSource?: ClientVoiceSessionSource,
): boolean {
  const observed =
    role === "user" && !session.closing
      ? session.confirmationReadiness.observeUserTranscript(text, true)
      : undefined;
  const normalizedText = normalizeVoiceTranscriptText(text);
  if (!normalizedText) {
    return true;
  }
  if (!ensureRelayVoiceSession(session, retainedSource)) {
    session.confirmationReadiness.fail(new Error("Realtime voice session could not be recorded"));
    return true;
  }
  const transcriptSeq = session.voiceTranscriptSeq + 1;
  const entryId = String(transcriptSeq);
  const { agentId, sessionKey, canonicalKey, storePath } = session.sessionTarget;
  const source = retainedSource ?? captureClientVoiceSessionSource(agentId);
  const settlement = captureClientVoiceSessionSettlement(source.settlementContext);
  const audienceGate = session.preparePrivateAudience
    ? createDeferredCore<PreparedVoiceTranscriptAudience | undefined>()
    : undefined;
  const audiencePreparation = audienceGate?.promise;
  const releaseCustody = () => {
    if (!audiencePreparation) {
      settlement.release();
      return;
    }
    return audiencePreparation
      .then((prepared) => prepared?.release())
      .catch((error: unknown) => {
        logRelayVoiceFailure(session, "voice transcript recipient release failed", error);
      })
      .finally(() => settlement.release());
  };
  let admission: ReturnType<typeof session.voiceTranscriptQueue.enqueue<void>>;
  try {
    admission = settlement.run(() =>
      session.voiceTranscriptQueue.enqueue(
        async () => {
          const audience = audiencePreparation ? await audiencePreparation : undefined;
          let lastError: unknown;
          for (const delayMs of RELAY_TRANSCRIPT_RETRY_DELAYS_MS) {
            if (delayMs > 0) {
              await sleep(delayMs);
            }
            try {
              await appendRelayVoiceTranscript(
                {
                  agentId,
                  sessionKey,
                  sessionTarget: { sessionKey: canonicalKey, storePath },
                  voiceSessionId: session.id,
                  entryId,
                  role,
                  text: normalizedText,
                  participant: role === "user" ? session.participant : undefined,
                  ...(audience ? { destinationAudience: audience.audience } : {}),
                  confirmation: observed?.confirmation ?? null,
                  ...(session.voiceConfig ? { config: session.voiceConfig } : {}),
                },
                source,
              );
              return;
            } catch (error) {
              if (hasSqliteWorkerOutcomeUnknown(error)) {
                throw error;
              }
              lastError = error;
            }
          }
          throw lastError;
        },
        { weight: normalizedText.length },
      ),
    );
  } catch (error) {
    audienceGate?.resolve(undefined);
    void releaseCustody();
    throw error;
  }
  if (!admission.accepted) {
    audienceGate?.resolve(undefined);
    void releaseCustody();
    session.confirmationReadiness.fail(
      new Error("Realtime voice transcript queue is closed or full"),
    );
    if (admission.reason === "overflow") {
      session.failSession(VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage);
    }
    return false;
  }
  if (audienceGate) {
    // Start in the same synchronous admission frame, but only after native queue
    // acceptance. Rejected/overflow traffic must not acquire unbounded sources.
    try {
      void settlement.run(async () => {
        try {
          audienceGate.resolve(await session.preparePrivateAudience?.());
        } catch (error) {
          logRelayVoiceFailure(
            session,
            "voice transcript retained without private recipient receipt",
            error,
          );
          audienceGate.resolve(undefined);
        }
      });
    } catch (error) {
      logRelayVoiceFailure(session, "voice transcript recipient preparation refused", error);
      audienceGate.resolve(undefined);
    }
  }
  session.voiceTranscriptSeq = transcriptSeq;
  void admission.completion.finally(releaseCustody).catch(() => {});
  void admission.completion.then(observed?.persisted, (error: unknown) => {
    session.confirmationReadiness.fail(error);
    logRelayVoiceFailure(session, "realtime relay transcript append failed", error);
  });
  return true;
}

export function closeRelayVoiceSession(
  session: RelayVoiceSessionOwner,
  retainedSource?: ClientVoiceSessionSource,
): Promise<void> {
  if (session.voiceSessionClose) {
    return session.voiceSessionClose;
  }
  session.voiceTranscriptQueue.seal();
  const { agentId, sessionKey } = session.sessionTarget;
  const source = retainedSource ?? captureClientVoiceSessionSource(agentId);
  const closing = withClientVoiceSessionSettlement(
    async () => {
      // Creation belongs to the same admitted close owner. A failed or unknown
      // record creation cannot manufacture a successful close receipt.
      createRequiredRelayVoiceSession(session, source);
      await session.voiceTranscriptQueue.flush({ requireSuccess: true });
      const config = session.voiceConfig ?? session.context.getRuntimeConfig();
      await closeRelayVoiceSessionRecord(
        {
          agentId,
          sessionKey,
          voiceSessionId: session.id,
          config,
        },
        source,
      );
    },
    async (error) => {
      try {
        await session.voiceTranscriptQueue.flush({ requireSuccess: true });
      } catch (prefixError) {
        throw new AggregateError(
          [error, prefixError],
          "Relay voice close lost transcript custody",
          {
            cause: prefixError,
          },
        );
      }
      throw error;
    },
    source.settlementContext,
  ).catch((error: unknown) => {
    // A definite refusal can be retried against the same sealed transcript
    // prefix. An unknown write outcome retains custody and must not be replayed.
    if (session.voiceSessionClose === closing && !hasSqliteWorkerOutcomeUnknown(error)) {
      session.voiceSessionClose = undefined;
    }
    logRelayVoiceFailure(session, "realtime relay voice session close failed", error);
    throw error;
  });
  session.voiceSessionClose = closing;
  // Relay transport owners retain draining sessions; this shared record writer
  // cannot take ownership of a provider-specific bridge or drop its capacity hold.
  void closing.catch(() => {});
  return closing;
}
