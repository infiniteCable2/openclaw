import type { RealtimeTranscriptionSession } from "../../realtime-transcription/provider-types.js";
import { createSpeechSttAudioConverter, type SpeechInputAudioFormat } from "./audio-format.js";
import type { resolveSpeechTranscriptionProvider } from "./support.js";
import type { SpeechAudioTransport } from "./transport.js";

/** Accepted capture boundaries retain the converter and provider until settlement. */
export function createSpeechTranscriptionInput(params: {
  inputAudioFormat: SpeechInputAudioFormat;
  transcription: Pick<
    ReturnType<typeof resolveSpeechTranscriptionProvider>,
    "provider" | "providerConfig"
  >;
  getSession(): RealtimeTranscriptionSession | null;
  isReady(): boolean;
  assertCurrent(): void;
  acceptAudio(audio: Buffer): boolean;
}) {
  const { provider, providerConfig } = params.transcription;
  const providerAudioFormat =
    provider.resolveInputAudioFormat?.(providerConfig) ?? "g711-ulaw-8khz";
  const createConverter = () =>
    createSpeechSttAudioConverter(params.inputAudioFormat, providerAudioFormat);
  let converter = createConverter();
  let finishing: Promise<void> | undefined;
  return {
    providerAudioFormat,
    get supportsInputEnd() {
      return typeof params.getSession()?.finishInput === "function";
    },
    sendAudio(audio: Buffer) {
      if (finishing) {
        throw new Error("Talk input boundary is still being processed");
      }
      if (params.acceptAudio(audio)) {
        params.getSession()?.sendAudio(converter.process(audio));
      }
    },
    async finishInput() {
      params.assertCurrent();
      if (finishing) {
        return finishing;
      }
      const session = params.getSession();
      if (!params.isReady() || !session?.finishInput) {
        throw new Error("Transcription provider does not support an explicit input boundary");
      }
      const finishProviderInput = session.finishInput.bind(session);
      const finish = Promise.resolve().then(async () => {
        params.assertCurrent();
        const remaining = converter.flush();
        converter = createConverter();
        if (remaining.byteLength > 0) session.sendAudio(remaining);
        await finishProviderInput();
        params.assertCurrent();
      });
      finishing = finish;
      try {
        await finish;
      } finally {
        if (finishing === finish) finishing = undefined;
      }
    },
    async close() {
      const pending = finishing;
      try {
        params.getSession()?.close();
      } finally {
        // The original boundary caller retains its failure; cleanup joins the
        // accepted work after provider cancellation before releasing its lease.
        await pending?.catch(() => {});
      }
    },
  };
}

/** Capture startup remains owned until teardown has joined any pending acquisition. */
export function createSpeechSessionInput(transport: SpeechAudioTransport) {
  let starting: Promise<void> | undefined;
  return {
    async start(
      onAudio: (audio: Buffer) => void,
      assertCurrent: () => void,
      startOtherInput?: () => void | Promise<void>,
    ) {
      assertCurrent();
      const acquisition = Promise.resolve().then(async () => {
        assertCurrent();
        await transport.startInput(onAudio);
        assertCurrent();
        await startOtherInput?.();
      });
      starting = acquisition;
      try {
        await acquisition;
        assertCurrent();
      } finally {
        if (starting === acquisition) {
          starting = undefined;
        }
      }
    },
    async stop() {
      const acquisition = starting;
      // Stop may unblock startup, but a late acquisition must also be stopped
      // before the caller can dispose capture or report the session closed.
      await transport.stop();
      if (acquisition) {
        await acquisition.catch(() => undefined);
        await transport.stop();
      }
    },
  };
}
