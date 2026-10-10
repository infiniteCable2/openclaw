import {
  convertPcmToMulaw8k,
  createStreamingPcmResampler,
  mulawToPcm,
  pcmToMulaw,
  resamplePcm,
} from "../audio-codec.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
} from "../provider-types.js";

export type SpeechAudioFormat = "pcm16-24khz" | "g711-ulaw-8khz";
export type SpeechInputAudioFormat = SpeechAudioFormat | "pcm16-16khz";

export function resolveSpeechAudioFormat(audioFormat: SpeechAudioFormat) {
  return audioFormat === "g711-ulaw-8khz"
    ? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ
    : REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ;
}

function convertSpeechInputForStt(audio: Buffer, audioFormat: SpeechInputAudioFormat): Buffer {
  if (audioFormat === "g711-ulaw-8khz") {
    return audio;
  }
  return convertPcmToMulaw8k(audio, audioFormat === "pcm16-16khz" ? 16_000 : 24_000);
}

/** Keep sample-phase continuity when a realtime provider accepts linear 16 kHz input. */
export function createSpeechSttAudioConverter(
  audioFormat: SpeechInputAudioFormat,
  inputFormat: "g711-ulaw-8khz" | "pcm16-16khz",
): { process(audio: Buffer): Buffer; flush(): Buffer } {
  if (inputFormat === "g711-ulaw-8khz") {
    return {
      process: (audio) => convertSpeechInputForStt(audio, audioFormat),
      flush: () => Buffer.alloc(0),
    };
  }
  if (audioFormat === "g711-ulaw-8khz") {
    const resampler = createStreamingPcmResampler(8_000, 16_000);
    return {
      process: (audio) => resampler.process(mulawToPcm(audio)),
      flush: () => resampler.flush(),
    };
  }
  if (audioFormat === "pcm16-16khz") {
    return { process: (audio) => audio, flush: () => Buffer.alloc(0) };
  }
  const resampler = createStreamingPcmResampler(24_000, 16_000);
  return { process: (audio) => resampler.process(audio), flush: () => resampler.flush() };
}

export function convertSpeechTtsAudio(
  audio: Buffer,
  sampleRate: number,
  audioFormat: SpeechAudioFormat,
  outputFormat?: string,
  platformName = "meeting platform",
): Buffer {
  const sourceFormat = sourceTelephonyTtsFormat(outputFormat, platformName);
  if (audioFormat === "g711-ulaw-8khz" && sourceFormat === "mulaw" && sampleRate === 8_000) {
    return audio;
  }
  const pcm = decodeMeetingTelephonyTtsAudio(audio, sourceFormat);
  return audioFormat === "g711-ulaw-8khz"
    ? convertPcmToMulaw8k(pcm, sampleRate)
    : resamplePcm(pcm, sampleRate, 24_000);
}

/** Keep sample alignment and resampling state for one provider byte stream. */
export function createSpeechTtsAudioStreamConverter(
  sampleRate: number,
  audioFormat: SpeechAudioFormat,
  outputFormat?: string,
  platformName = "meeting platform",
): { process(audio: Buffer): Buffer; flush(): Buffer } {
  const sourceFormat = sourceTelephonyTtsFormat(outputFormat, platformName);
  if (audioFormat === "g711-ulaw-8khz" && sourceFormat === "mulaw" && sampleRate === 8_000) {
    return { process: (audio) => audio, flush: () => Buffer.alloc(0) };
  }
  const resampler = createStreamingPcmResampler(
    sampleRate,
    audioFormat === "g711-ulaw-8khz" ? 8_000 : 24_000,
  );
  let trailingByte = Buffer.alloc(0);
  const encode = (pcm: Buffer) => (audioFormat === "g711-ulaw-8khz" ? pcmToMulaw(pcm) : pcm);
  return {
    process(audio) {
      const pcm = decodeMeetingTelephonyTtsAudio(audio, sourceFormat);
      const combined = trailingByte.length > 0 ? Buffer.concat([trailingByte, pcm]) : pcm;
      const completeBytes = combined.length - (combined.length % 2);
      // The native equal-rate resampler passes bytes through, so the adapter
      // also retains incomplete samples when no rate conversion is necessary.
      trailingByte = Buffer.from(combined.subarray(completeBytes));
      return encode(resampler.process(combined.subarray(0, completeBytes)));
    },
    flush() {
      trailingByte = Buffer.alloc(0);
      return encode(resampler.flush());
    },
  };
}

type MeetingTelephonyTtsFormat = "pcm" | "mulaw" | "alaw";

function sourceTelephonyTtsFormat(
  outputFormat: string | undefined,
  platformName: string,
): MeetingTelephonyTtsFormat {
  const normalized = outputFormat?.trim().toLowerCase().replaceAll("_", "-") ?? "";
  if (
    !normalized ||
    normalized === "pcm" ||
    normalized.startsWith("pcm-") ||
    normalized.includes("pcm16") ||
    normalized.includes("16bit-mono-pcm")
  ) {
    return "pcm";
  }
  if (
    normalized.includes("mu-law") ||
    normalized.includes("mulaw") ||
    normalized.includes("ulaw")
  ) {
    return "mulaw";
  }
  if (normalized.includes("a-law") || normalized.includes("alaw")) {
    return "alaw";
  }
  throw new Error(`Unsupported telephony TTS output format for ${platformName}: ${outputFormat}`);
}

function decodeMeetingTelephonyTtsAudio(
  audio: Buffer,
  sourceFormat: MeetingTelephonyTtsFormat,
): Buffer {
  switch (sourceFormat) {
    case "pcm":
      return audio;
    case "mulaw":
      return mulawToPcm(audio);
    case "alaw":
      return alawToPcm(audio);
  }
  sourceFormat satisfies never;
  throw new Error("Unsupported telephony TTS output format for meeting platform");
}

function alawToPcm(alaw: Buffer): Buffer {
  const pcm = Buffer.alloc(alaw.length * 2);
  for (let index = 0; index < alaw.length; index += 1) {
    pcm.writeInt16LE(alawByteToLinear(alaw[index] ?? 0), index * 2);
  }
  return pcm;
}

function alawByteToLinear(value: number): number {
  const aLaw = value ^ 0x55;
  const sign = aLaw & 0x80;
  const exponent = (aLaw & 0x70) >> 4;
  const mantissa = aLaw & 0x0f;
  const sample = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
  return sign ? sample : -sample;
}
