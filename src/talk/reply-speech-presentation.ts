import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import type {
  ReplySpeechPresentationSource,
  ReplySpeechRunBinding,
} from "../auto-reply/reply/reply-speech-presentation.js";
import type { SpeechSegmentationProfile } from "../tts/provider-types.js";
import type { RealtimeVoiceAgentConsultResult } from "./agent-consult-runtime.js";
import {
  createRealtimeVoiceConsultSpeechDelivery,
  resolveRealtimeVoiceYieldAcknowledgment,
} from "./agent-consult-speech-delivery.js";

/** Adapt the existing Speech delivery owner to the native reply turn; never initialize a session. */
export function createReplySpeechPresentation(
  params: Omit<
    Parameters<typeof createRealtimeVoiceConsultSpeechDelivery>[0],
    "runId" | "sessionId" | "abortSignal" | "assertExpressionCurrent" | "assertNotInterrupted"
  > & {
    /** One stable host object per output connection, shared across its admitted inputs. */
    outputOwner?: object;
    assertOutputCurrent(): void;
    guidance?: string;
    modelRequestProfile?: RunEmbeddedAgentParams["modelRequestProfile"];
    waitForPendingInput?: RunEmbeddedAgentParams["waitForPendingInput"];
    speechSegmentationProfile?: SpeechSegmentationProfile;
    /** Buffer ordinary text; explicit current-source speech retains its native contract. */
    bufferReply?: boolean;
    onRunBound?: (binding: ReplySpeechRunBinding) => void;
    onResult(result: RealtimeVoiceAgentConsultResult): void | Promise<void>;
    onError(error: unknown): void;
  },
): ReplySpeechPresentationSource {
  return Object.freeze({
    outputOwner: params.outputOwner ?? Object.freeze({}),
    guidance: [params.guidance, params.speechExpressionContext?.guidance]
      .filter(Boolean)
      .join("\n\n"),
    modelRequestProfile: params.modelRequestProfile,
    waitForPendingInput: params.waitForPendingInput,
    speakCommentary: params.speakCommentary === true && Boolean(params.onSpeakableText),
    blockReplyChunking: {
      minChars: params.speechSegmentationProfile?.minChars ?? 48,
      maxChars: params.speechSegmentationProfile?.maxChars ?? 320,
      breakPreference: "sentence" as const,
      ...(params.speechSegmentationProfile ? { speech: params.speechSegmentationProfile } : {}),
    },
    onError: (error) => params.onError(error),
    openRun(binding) {
      let open = true;
      let accepting = true;
      const assertRunCurrent = () => {
        binding.abortSignal.throwIfAborted();
        binding.assertCurrent();
        if (!open) {
          throw new Error("Current-source speech target is no longer active");
        }
      };
      const assertOutputCurrent = () => {
        assertRunCurrent();
        params.assertOutputCurrent();
        params.speechExpressionContext?.assertCurrent();
      };
      const assertAccepting = () => {
        assertRunCurrent();
        if (!accepting) throw new Error("Current-source speech presentation is settling");
      };
      assertAccepting();
      try {
        params.onRunBound?.(binding);
      } catch (error) {
        try {
          params.onError(error);
        } catch {
          // An observer cannot make an accepted native turn eligible for replay.
        }
      }
      const delivery = createRealtimeVoiceConsultSpeechDelivery({
        ...params,
        ...binding,
        assertExpressionCurrent: assertOutputCurrent,
        assertInputCurrent: assertAccepting,
        assertNotInterrupted: assertRunCurrent,
        onSpeakableText: params.onSpeakableText
          ? (event) => {
              // Abort releases the output even after the connection has closed.
              if (event.type !== "abort") assertOutputCurrent();
              return params.onSpeakableText!(event);
            }
          : undefined,
      });
      const onAbort = () => void delivery.abortSpeechDelivery();
      binding.abortSignal.addEventListener("abort", onAbort, { once: true });
      const target = delivery.currentSourceReplyTarget;
      return {
        currentSourceReplyTarget: target
          ? {
              ...target,
              assertCurrent: assertAccepting,
              beginInput(input) {
                assertAccepting();
                target.beginInput?.(input);
              },
              async deliver(payload, context) {
                assertAccepting();
                assertOutputCurrent();
                await target.deliver(payload, context);
              },
            }
          : undefined,
        ...(params.speechExpressionContext
          ? { nativeSpeechPresentation: { assertCurrent: assertAccepting } }
          : {}),
        onBlockReply(payload) {
          assertAccepting();
          if (!params.bufferReply) delivery.onBlockReply(payload);
        },
        async finish(result) {
          accepting = false;
          assertOutputCurrent();
          const presentation = await delivery.finish({
            yielded: result.meta?.yielded === true,
            acknowledgment: resolveRealtimeVoiceYieldAcknowledgment(result.meta),
            payloads: result.payloads ?? [],
          });
          assertOutputCurrent();
          await params.onResult(presentation);
        },
        abort() {
          accepting = false;
          return delivery.abortSpeechDelivery();
        },
        async close() {
          accepting = false;
          open = false;
          binding.abortSignal.removeEventListener("abort", onAbort);
          await delivery.abortCompletion;
        },
      };
    },
  } satisfies ReplySpeechPresentationSource);
}
