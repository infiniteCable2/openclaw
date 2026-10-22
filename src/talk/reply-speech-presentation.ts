import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import {
  getReplyPayloadMetadata,
  type ReplySpeechOutputReceipt,
} from "../auto-reply/reply-payload.js";
import type {
  ReplySpeechPresentationSource,
  ReplySpeechRunBinding,
} from "../auto-reply/reply/reply-speech-presentation.js";
import { recordReplySpeechDelivery } from "../auto-reply/reply/reply-speech-presentation.js";
import type { SpeechSegmentationProfile } from "../tts/provider-types.js";
import type {
  RealtimeVoiceAgentConsultResult,
  RealtimeVoiceAgentConsultSpeechEvent,
} from "./agent-consult-runtime.js";
import {
  createRealtimeVoiceConsultSpeechDelivery,
  resolveRealtimeVoiceYieldAcknowledgment,
} from "./agent-consult-speech-delivery.js";
import { collectRealtimeVoiceAgentConsultVisibleText } from "./agent-consult-tool.js";

/** Adapt the existing Speech delivery owner to the native reply turn; never initialize a session. */
export function createReplySpeechPresentation(
  params: Omit<
    Parameters<typeof createRealtimeVoiceConsultSpeechDelivery>[0],
    | "runId"
    | "sessionId"
    | "abortSignal"
    | "assertExpressionCurrent"
    | "assertNotInterrupted"
    | "onSpeakableText"
  > & {
    onSpeakableText?: (
      event: RealtimeVoiceAgentConsultSpeechEvent,
    ) => void | ReplySpeechOutputReceipt | Promise<void | ReplySpeechOutputReceipt>;
    onOutputReceipt?: (receipt: ReplySpeechOutputReceipt) => void;
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
      let outputReceipt: ReplySpeechOutputReceipt | undefined;
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
        if (!accepting) {
          throw new Error("Current-source speech presentation is settling");
        }
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
          ? async (event) => {
              // Abort releases the output even after the connection has closed.
              if (event.type !== "abort") {
                assertOutputCurrent();
              }
              const receipt = await params.onSpeakableText!(event);
              if (event.type === "done") {
                outputReceipt = receipt || undefined;
                if (receipt) {
                  let retained = false;
                  try {
                    params.onOutputReceipt?.(receipt);
                    retained = Boolean(params.onOutputReceipt);
                  } finally {
                    if (!retained) {
                      receipt.releaseSettlement();
                    }
                  }
                }
              }
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
          if (!params.bufferReply) {
            delivery.onBlockReply(payload);
          }
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
          const payloads = (result.payloads ?? []).filter(
            (payload) => getReplyPayloadMetadata(payload)?.precedingInputAnswer !== true,
          );
          // A fallback/yield acknowledgment is not proof that the model's final payloads
          // were spoken. Retain receipts only for the exact accepted source text.
          if (
            outputReceipt &&
            presentation.delivered === true &&
            presentation.text.replaceAll(/\s+/g, " ").trim() ===
              collectRealtimeVoiceAgentConsultVisibleText(payloads)?.replaceAll(/\s+/g, " ").trim()
          ) {
            const output = outputReceipt;
            const expected = payloads
              .filter((payload) => Boolean(collectRealtimeVoiceAgentConsultVisibleText([payload])))
              .map((payload) => getReplyPayloadMetadata(payload)?.tts?.text ?? payload.text ?? "")
              .join(" ")
              .replaceAll(/\s+/g, " ")
              .trim();
            const accepted = output.completion.then(
              (segments) => {
                const submitted = segments?.join(" ").replaceAll(/\s+/g, " ").trim();
                // Commentary may precede the final answer; never use done.text as proof
                // that the actual synthesized chunks contained that final answer.
                return Boolean(
                  expected &&
                  submitted &&
                  (submitted === expected || submitted.endsWith(` ${expected}`)),
                );
              },
              () => false,
            );
            payloads.forEach((payload) =>
              recordReplySpeechDelivery(payload, binding, output, accepted),
            );
          }
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
