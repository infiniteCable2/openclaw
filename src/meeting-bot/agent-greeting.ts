import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { RealtimeVoiceAgentConsultResult } from "../talk/agent-consult-runtime.js";
import type { RealtimeVoiceSessionHarness } from "../talk/realtime-session-harness.js";
import { createMeetingTtsAudioStreamConverter } from "./realtime-audio-format.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import { normalizeMeetingTtsPromptText } from "./realtime-engine-support.js";

const MAX_GREETING_CHARS = 300;
const MAX_GREETING_AUDIO_BYTES = 24_000 * 2 * 15;

export type PreparedMeetingAgentGreeting = { text: string; audio: Buffer };

/** Play prepared speech only after remote media is ready and this output is still current. */
export async function playMeetingAgentGreeting(params: {
  greeting: PreparedMeetingAgentGreeting;
  transport: MeetingRealtimeAudioTransport;
  harness: RealtimeVoiceSessionHarness;
  meetingSessionId: string;
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
      payload: { meetingSessionId: params.meetingSessionId, text: params.greeting.text },
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
export async function prepareMeetingAgentGreeting(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  consultAgent: (params: {
    meetingSessionId: string;
    requesterSessionKey?: string;
    args: unknown;
    transcript: Array<{ role: "user" | "assistant"; text: string }>;
    abortSignal?: AbortSignal;
  }) => Promise<RealtimeVoiceAgentConsultResult>;
  meetingSessionId: string;
  requesterSessionKey?: string;
  callerId: string;
  prompt: string;
  timeZone: string;
  audioFormat: MeetingRealtimeAudioFormat;
  ttsContext?: { agentId?: string; channelId?: string; accountId?: string };
  signal: AbortSignal;
  now?: Date;
}): Promise<PreparedMeetingAgentGreeting> {
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
      meetingSessionId: params.meetingSessionId,
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
  const text = normalizeMeetingTtsPromptText(result.text);
  if (!text || text.length > MAX_GREETING_CHARS) {
    throw new Error("Meeting greeting was empty or too long");
  }
  const tts = await racePromiseWithAbortSignal(
    params.runtime.tts.streamTextToSpeechTelephony({
      text,
      cfg: params.cfg,
      signal: params.signal,
      ...(params.ttsContext?.agentId ? { agentId: params.ttsContext.agentId } : {}),
      ...(params.ttsContext?.channelId ? { channelId: params.ttsContext.channelId } : {}),
      ...(params.ttsContext?.accountId ? { accountId: params.ttsContext.accountId } : {}),
    }),
    params.signal,
  );
  if (!tts.success || !tts.audioStream || !tts.sampleRate) {
    await tts.release?.();
    throw new Error(tts.error ?? "Meeting greeting TTS preparation failed");
  }
  const reader = tts.audioStream.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    const converter = createMeetingTtsAudioStreamConverter(
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
    return { text, audio: Buffer.concat(chunks, size) };
  } finally {
    await racePromiseWithAbortSignal(
      reader.cancel().catch(() => undefined),
      params.signal,
    ).catch(() => undefined);
    reader.releaseLock();
    if (tts.release) {
      await racePromiseWithAbortSignal(tts.release(), params.signal);
    }
  }
}
