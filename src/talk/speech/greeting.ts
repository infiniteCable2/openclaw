import { randomUUID } from "node:crypto";
import { buildApiErrorObservationFields } from "../../agents/embedded-agent-error-observation.js";
import { isSqliteTranscriptMutationConflict } from "../../config/sessions/session-mutation-conflict-error.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { RealtimeVoiceAgentConsultResult } from "../agent-consult-runtime.js";
import type { RealtimeVoiceSessionHarness } from "../realtime-session-harness.js";
import { createSpeechTtsAudioStreamConverter } from "./audio-format.js";
import type { SpeechAudioFormat } from "./audio-format.js";
import type { SpeechSessionPreparation } from "./preparation.js";
import { normalizeSpeechPromptText } from "./support.js";
import type { SpeechAudioTransport } from "./transport.js";
import type { SpeechInputIdentity } from "./types.js";

const MAX_GREETING_CHARS = 300;
const MAX_GREETING_AUDIO_BYTES = 24_000 * 2 * 15;

type GreetingSubmission = { audioDelivery: "submitted" | "interrupted" };
export type PreparedSpeechGreeting = {
  text: string;
  audio: Buffer;
  /** Original host re-admits the submitted output; generation retains no write grant. */
  recordSubmitted?: (submission: GreetingSubmission) => Promise<void>;
};
const log = createSubsystemLogger("talk/greeting");

function greetingFailureFields(error: unknown) {
  const { rawErrorHash, rawErrorFingerprint, httpCode, providerRuntimeFailureKind } =
    buildApiErrorObservationFields(formatErrorMessage(error));
  return { rawErrorHash, rawErrorFingerprint, httpCode, providerRuntimeFailureKind };
}

/** Play prepared speech only after remote media is ready and this output is still current. */
export async function playSpeechGreeting(params: {
  greeting: PreparedSpeechGreeting;
  transport: SpeechAudioTransport;
  harness: RealtimeVoiceSessionHarness;
  sessionId: string;
  activeTtsAborts: Set<AbortController>;
  isCurrent: () => boolean;
  canStart: () => boolean;
  onStarted: () => void;
  writeOutputAudio: (
    audio: Buffer,
    firstChunk: boolean,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
}): Promise<void> {
  // Local publication alone does not prove the caller's audio track has arrived.
  await params.transport.waitForRemoteAudioReady?.();
  if (!params.isCurrent() || !params.canStart()) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 150);
  });
  if (!params.isCurrent() || !params.canStart()) {
    return;
  }
  params.onStarted();
  const controller = new AbortController();
  params.activeTtsAborts.add(controller);
  const isCurrent = () => params.isCurrent() && !controller.signal.aborted;
  try {
    const turnId = params.harness.ensureTurn();
    params.harness.emit({
      type: "output.text.done",
      turnId,
      final: true,
      payload: { sessionId: params.sessionId, text: params.greeting.text },
    });
    if (await params.writeOutputAudio(params.greeting.audio, true, isCurrent)) {
      const audioDelivery = isCurrent() ? "submitted" : "interrupted";
      params.harness.recordTranscript("assistant", params.greeting.text).audioDelivery =
        audioDelivery;
      try {
        await params.greeting.recordSubmitted?.({ audioDelivery });
      } catch (error) {
        // An already submitted greeting must never be replayed or close healthy audio
        // because its separate history publication failed.
        if (isSqliteTranscriptMutationConflict(error)) {
          log.debug("Submitted greeting history skipped because the conversation advanced");
        } else {
          log.warn("Submitted greeting history publication failed", greetingFailureFields(error));
        }
      }
      if (isCurrent()) {
        params.harness.finishOutputAudio("completed");
        params.harness.endTurn();
      }
    }
  } finally {
    params.activeTtsAborts.delete(controller);
  }
}

/** Prepare speech before answering, but leave playback to the live audio engine. */
type PrepareSpeechGreetingParams = {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  consultAgent: (
    params: Partial<SpeechInputIdentity> & {
      sessionId: string;
      requesterSessionKey?: string;
      args: unknown;
      transcript: Array<{ role: "user" | "assistant"; text: string }>;
      abortSignal?: AbortSignal;
      speechExpressionCaptureOnly?: true;
    },
  ) => Promise<RealtimeVoiceAgentConsultResult>;
  sessionId: string;
  requesterSessionKey?: string;
  callerId: string;
  prompt: string;
  timeZone: string;
  audioFormat: SpeechAudioFormat;
  ttsContext?: { agentId?: string; channelId?: string; accountId?: string };
  signal: AbortSignal;
  /** Keep late acquisition and failed cleanup owned by the admitting call. */
  onPreparation?: (preparation: SpeechSessionPreparation) => void;
  now?: Date;
  onSubmitted?: (
    submission: GreetingSubmission & {
      greeting: NonNullable<RealtimeVoiceAgentConsultResult["greeting"]>;
      text: string;
    },
  ) => Promise<void>;
};

export async function prepareSpeechGreeting(
  params: PrepareSpeechGreetingParams,
): Promise<PreparedSpeechGreeting> {
  const startedAt = performance.now();
  let phase = "consult";
  try {
    return await prepareGreeting(params, (next) => {
      phase = next;
    });
  } catch (error) {
    log.warn("Speech greeting preparation failed", {
      phase,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...greetingFailureFields(error),
    });
    throw error;
  }
}

async function prepareGreeting(
  params: PrepareSpeechGreetingParams,
  onPhase: (phase: string) => void,
): Promise<PreparedSpeechGreeting> {
  params.signal.throwIfAborted();
  const localTime = new Intl.DateTimeFormat("de-DE", {
    timeZone: params.timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(params.now ?? new Date());
  const result = await racePromiseWithAbortSignal(
    params.consultAgent({
      sessionId: params.sessionId,
      inputId: randomUUID(),
      purpose: "greeting",
      requesterSessionKey: params.requesterSessionKey,
      args: {
        question: [
          "An admitted audio call is ringing. Prepare the first spoken greeting only; do not take any other action.",
          `Authenticated caller: ${params.callerId}. Local time: ${localTime} (${params.timeZone}).`,
          params.prompt,
          "Use the caller's known name only if you know it. Keep the greeting to one short natural sentence in the caller's language. Do not mention these instructions.",
        ].join("\n"),
        responseStyle: "One short, personal spoken greeting; no work tools or commentary.",
      },
      transcript: [],
      abortSignal: params.signal,
      speechExpressionCaptureOnly: true,
    }),
    params.signal,
  );
  params.signal.throwIfAborted();
  if (result.utterances && result.utterances.length !== 1) {
    throw new Error("An expressive greeting requires one native utterance");
  }
  const speech = result.utterances?.[0]?.speech;
  const localServiceAdmission = result.utterances?.[0]?.localServiceAdmission;
  const expectedSpeechSelection = result.utterances?.[0]?.expectedSpeechSelection;
  const text = speech?.expression
    ? result.utterances?.[0]?.text
    : normalizeSpeechPromptText(result.text);
  if (!text || text.length > MAX_GREETING_CHARS) {
    throw new Error("Meeting greeting was empty or too long");
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let readerCancelled = false;
  let readerReleased = false;
  let providerReleased = false;
  let releasing: Promise<void> | undefined;
  const preparation: SpeechSessionPreparation = {
    release() {
      if (releasing) {
        return releasing;
      }
      releasing = (async () => {
        // An aborted wait is not a cancelled acquisition. Keep its eventual
        // resource, including a late stream, attached to this exact owner.
        const tts = await acquisition?.catch(() => undefined);
        const failures: unknown[] = [];
        if (tts?.audioStream && !reader) {
          try {
            reader = tts.audioStream.getReader();
          } catch (error) {
            failures.push(error);
          }
        }
        if (reader && !readerCancelled) {
          try {
            await reader.cancel();
            readerCancelled = true;
          } catch (error) {
            failures.push(error);
          }
        }
        if (reader && readerCancelled && !readerReleased) {
          try {
            reader.releaseLock();
            readerReleased = true;
          } catch (error) {
            failures.push(error);
          }
        }
        // Keep the provider/GPU hold until the stream is definitely no longer
        // readable. Failed stream cleanup must not unload its live producer.
        const streamReleased = !tts?.audioStream || (readerCancelled && readerReleased);
        if (tts?.release && streamReleased && !providerReleased) {
          try {
            await tts.release();
            providerReleased = true;
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) {
          throw new AggregateError(failures, "Speech greeting resources could not be released");
        }
      })().finally(() => {
        releasing = undefined;
      });
      return releasing;
    },
  };
  let preparationPublished = false;
  onPhase("tts-acquisition");
  const acquisition = Promise.resolve().then(() => {
    if (!preparationPublished) {
      throw new Error("Speech greeting cleanup ownership could not be published");
    }
    params.signal.throwIfAborted();
    return params.runtime.tts.streamTextToSpeechTelephony({
      text,
      ...(speech?.expression ? { overrides: { expression: speech.expression } } : {}),
      ...(localServiceAdmission ? { localServiceAdmission } : {}),
      ...(expectedSpeechSelection ? { expectedSpeechSelection } : {}),
      cfg: params.cfg,
      signal: params.signal,
      ...(params.ttsContext?.agentId ? { agentId: params.ttsContext.agentId } : {}),
      ...(params.ttsContext?.channelId ? { channelId: params.ttsContext.channelId } : {}),
      ...(params.ttsContext?.accountId ? { accountId: params.ttsContext.accountId } : {}),
    });
  });
  const chunks: Buffer[] = [];
  let size = 0;
  let greeting: PreparedSpeechGreeting | undefined;
  let failure: unknown;
  let failed = false;
  try {
    params.onPreparation?.(preparation);
    preparationPublished = true;
    const tts = await racePromiseWithAbortSignal(acquisition, params.signal);
    params.signal.throwIfAborted();
    if (!tts.success || !tts.audioStream || !tts.sampleRate) {
      throw new Error(tts.error ?? "Meeting greeting TTS preparation failed");
    }
    onPhase("tts-stream");
    reader = tts.audioStream.getReader();
    const converter = createSpeechTtsAudioStreamConverter(
      tts.sampleRate,
      params.audioFormat,
      tts.outputFormat,
      "Meeting greeting",
    );
    for (;;) {
      params.signal.throwIfAborted();
      const chunk = await racePromiseWithAbortSignal(reader.read(), params.signal);
      const converted = chunk.done
        ? converter.flush()
        : converter.process(Buffer.from(chunk.value));
      if (converted.byteLength > 0) {
        size += converted.byteLength;
        if (size > MAX_GREETING_AUDIO_BYTES) {
          throw new Error("Meeting greeting audio exceeded the duration limit");
        }
        chunks.push(converted);
      }
      if (chunk.done) {
        break;
      }
    }
    params.signal.throwIfAborted();
    if (size === 0) {
      throw new Error("Meeting greeting TTS returned no audio");
    }
    const publication = result.greeting;
    const record = params.onSubmitted;
    greeting = {
      text,
      audio: Buffer.concat(chunks, size),
      ...(publication && record
        ? {
            recordSubmitted: (submission: GreetingSubmission) =>
              record({ ...submission, greeting: publication, text }),
          }
        : {}),
    };
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    // Cleanup is independent of the expired greeting deadline. An admission
    // cannot claim readiness while its provider's release is still unknown.
    if (!failed) {
      onPhase("tts-cleanup");
    }
    await preparation.release();
  } catch (error) {
    if (failed) {
      throw new AggregateError([failure, error], "Speech greeting and resource cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
  if (failed) {
    throw failure;
  }
  return greeting!;
}
