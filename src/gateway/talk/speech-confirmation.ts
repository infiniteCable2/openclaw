import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  authorizeObservedClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  captureClientVoiceConfirmationUtterance,
  noteClientVoiceConfirmationUtterance,
  observeClientVoiceConfirmationRun,
  prepareClientVoiceConfirmationTranscript,
  readClientVoiceConfirmationReadiness,
  recordClientVoiceConfirmationTranscriptAppend,
} from "../../talk/client-voice-confirmation.js";
import { registerClientVoiceConsultRun } from "../../talk/client-voice-session.js";
import type { ConversationReplyResult } from "../../talk/conversation-reply.js";
import type { SpeechNativeInputParams } from "../../talk/speech/types.js";

/** Reuse the native voice misfire gate around a genuine admitted getReply input. */
export function createNativeSpeechConfirmation(params: {
  agentId: string;
  sessionKey: string;
  canonicalSessionKey: string;
  voiceSessionId: string;
  config: OpenClawConfig;
  dispatch(input: SpeechNativeInputParams): Promise<ConversationReplyResult>;
  onOutputFailure(error: unknown): void;
}) {
  return async (input: SpeechNativeInputParams): Promise<ConversationReplyResult> => {
    const pending = readClientVoiceConfirmationReadiness(params.agentId, params.voiceSessionId);
    const utterance = captureClientVoiceConfirmationUtterance(params);
    let observation: ReturnType<typeof observeClientVoiceConfirmationRun> | undefined;
    let commitFailure: { error: unknown } | undefined;
    let runRegistrationFailure: { error: unknown } | undefined;
    let originalCommitted = false;
    let actualRunId: string | undefined;
    let challengePresented = false;
    let outputFailed = false;
    let yielded = false;
    const bindCommittedGrant = () => {
      // Native CLI and embedded paths may publish these two facts in either
      // order. Neither a commit nor a run announcement alone grants a tool.
      if (!originalCommitted || !actualRunId) {
        return;
      }
      const grant = authorizeObservedClientVoiceConfirmation(params);
      if (grant) {
        bindAuthorizedClientVoiceConfirmation({ grant, runId: actualRunId });
      }
    };
    try {
      const result = await params.dispatch({
        ...input,
        // Any answer to a pending challenge first needs its own committed input
        // and actual run. A steer receipt is too late to grant a live backend.
        ...(pending ? { queueMode: "followup" as const } : {}),
        assertWorkCurrent() {
          input.assertWorkCurrent?.();
          if (commitFailure) {
            throw commitFailure.error;
          }
          if (runRegistrationFailure) {
            throw runRegistrationFailure.error;
          }
        },
        onOriginalInputCommitted(commit) {
          try {
            if (
              commit.anchor.agentId !== params.agentId ||
              commit.anchor.sessionKey !== params.canonicalSessionKey
            ) {
              throw new Error("Native voice input committed to a different conversation");
            }
            const confirmation = prepareClientVoiceConfirmationTranscript({
              ...params,
              confirmation: utterance,
              entryId: commit.anchor.entryId,
            });
            if (!confirmation) {
              throw new Error("Native voice confirmation observation changed");
            }
            // This callback is issued only by the existing native recorder after
            // a fresh original append. Never infer it from a caption or text match.
            const text =
              typeof commit.message.content === "string"
                ? commit.message.content
                : commit.message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n");
            recordClientVoiceConfirmationTranscriptAppend({
              confirmation,
              entryId: commit.anchor.entryId,
              text,
              appended: true,
            });
            noteClientVoiceConfirmationUtterance({
              ...params,
              timestamp: Date.now(),
              confirmation,
            });
            originalCommitted = true;
            bindCommittedGrant();
          } catch (error) {
            // Recorder notifications are diagnostic. Keep their failure visible
            // to the actual run-start guard before any user tool can execute.
            commitFailure = { error };
            throw error;
          }
          input.onOriginalInputCommitted?.(commit);
        },
        onRunStarted(...args) {
          if (commitFailure) {
            throw commitFailure.error;
          }
          const [runId] = args;
          try {
            registerClientVoiceConsultRun({
              agentId: params.agentId,
              sessionKey: params.sessionKey,
              voiceSessionId: params.voiceSessionId,
              runId,
              config: params.config,
            });
            observation?.release();
            observation = observeClientVoiceConfirmationRun({ ...params, runId });
            actualRunId = runId;
            bindCommittedGrant();
          } catch (error) {
            runRegistrationFailure = { error };
            throw error;
          }
          return input.onRunStarted?.(...args);
        },
        onSpeakableText: input.onSpeakableText
          ? async (event) => {
              // Keep permissible early commentary, but a blocked action's
              // authoritative challenge replaces later model narration and done.
              const challenge = event.type !== "abort" ? observation?.readReply() : undefined;
              if (challenge) {
                if (event.type === "done" && !challengePresented) {
                  // This is still inside the actual live presentation owner.
                  // Done alone cannot append audio after early commentary.
                  try {
                    await input.onSpeakableText!({ type: "chunk", text: challenge });
                    const receipt = await input.onSpeakableText!({ type: "done", text: challenge });
                    challengePresented = true;
                    // The native output owner must release its reserved settlement,
                    // even when the challenge replaces the model's narration.
                    return receipt;
                  } catch (error) {
                    outputFailed = true;
                    try {
                      params.onOutputFailure(error);
                    } catch {
                      /* Diagnostic only. */
                    }
                    throw error;
                  }
                }
                return;
              }
              return input.onSpeakableText!(event);
            }
          : undefined,
      });
      if (result.kind === "steered") {
        return result;
      }
      yielded = result.reply.yielded === true;
      const challenge = observation?.readReply();
      if (!challenge) {
        return result;
      }
      // A missing live completion means output failed or was closed. Do not
      // manufacture done after native presentation release or retry its work.
      if (outputFailed || (input.onSpeakableText && !challengePresented)) {
        return { kind: "reply", reply: { text: "" } };
      }
      return {
        kind: "reply",
        reply: {
          ...result.reply,
          text: challenge,
          utterances: undefined,
          delivered: challengePresented,
        },
      };
    } finally {
      // The existing trusted native run completion releases yielded observers.
      if (!yielded) {
        observation?.release();
      }
    }
  };
}
