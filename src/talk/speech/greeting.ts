import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { RealtimeVoiceAgentConsultResult } from "../agent-consult-runtime.js";
import type { RealtimeVoiceSessionHarness } from "../realtime-session-harness.js";
import { createSpeechTtsAudioStreamConverter } from "./audio-format.js";
import type { SpeechAudioFormat } from "./audio-format.js";
import type { SpeechSessionPreparation } from "./preparation.js";
import { normalizeSpeechPromptText } from "./support.js";
import type { SpeechAudioTransport } from "./transport.js";

const MAX_GREETING_CHARS = 300;
const MAX_GREETING_AUDIO_BYTES = 24_000 * 2 * 15;

export type PreparedSpeechGreeting = { text: string; audio: Buffer };

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
      params.harness.recordTranscript("assistant", params.greeting.text).audioDelivery = isCurrent()
        ? "submitted"
        : "interrupted";
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
export async function prepareSpeechGreeting(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  consultAgent: (params: {
    sessionId: string;
    requesterSessionKey?: string;
    args: unknown;
    transcript: Array<{ role: "user" | "assistant"; text: string }>;
    abortSignal?: AbortSignal;
  }) => Promise<RealtimeVoiceAgentConsultResult>;
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
}): Promise<PreparedSpeechGreeting> {
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
      requesterSessionKey: params.requesterSessionKey,
      args: {
        question: [
          "An admitted audio call is ringing. Prepare the first spoken greeting only; do not take any other action.",
          `Authenticated caller: ${params.callerId}. Local time: ${localTime} (${params.timeZone}).`,
          params.prompt,
          "Use the caller's known name only if you know it. Keep the greeting to one short natural sentence in the caller's language. Do not mention these instructions.",
        ].join("\n"),
        responseStyle: "One short, personal spoken greeting; no tools or commentary.",
      },
      transcript: [],
      abortSignal: params.signal,
    }),
    params.signal,
  );
  params.signal.throwIfAborted();
  const text = normalizeSpeechPromptText(result.text);
  if (!text || text.length > MAX_GREETING_CHARS) {
    throw new Error("Meeting greeting was empty or too long");
  }
  let acquisition: ReturnType<PluginRuntime["tts"]["streamTextToSpeechTelephony"]> | undefined;
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
  acquisition = Promise.resolve().then(() => {
    if (!preparationPublished) {
      throw new Error("Speech greeting cleanup ownership could not be published");
    }
    params.signal.throwIfAborted();
    return params.runtime.tts.streamTextToSpeechTelephony({
      text,
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
    greeting = { text, audio: Buffer.concat(chunks, size) };
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    // Cleanup is independent of the expired greeting deadline. An admission
    // cannot claim readiness while its provider's release is still unknown.
    await preparation.release();
  } catch (error) {
    if (failed) {
      throw new AggregateError([failure, error], "Speech greeting and resource cleanup failed");
    }
    throw error;
  }
  if (failed) {
    throw failure;
  }
  return greeting!;
}
