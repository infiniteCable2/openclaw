import { randomUUID } from "node:crypto";
import type { RealtimeTranscriptionSession } from "../../realtime-transcription/provider-types.js";
import { createSpeechSttAudioConverter, type SpeechInputAudioFormat } from "./audio-format.js";
import type { resolveSpeechTranscriptionProvider } from "./support.js";
import type { SpeechAudioTransport } from "./transport.js";

/** Accepted capture boundaries retain the converter and provider until settlement. */
export function createSpeechTranscriptionInput(params: {
  inputAudioFormat: SpeechInputAudioFormat;
  inputEndMode?: "server" | "client";
  transcription: Pick<
    ReturnType<typeof resolveSpeechTranscriptionProvider>,
    "provider" | "providerConfig"
  >;
  getSession(): RealtimeTranscriptionSession | null;
  isReady(): boolean;
  assertCurrent(): void;
  acceptAudio(audio: Buffer): boolean;
  onCaptureStarted?(captureId: string): void;
  onAudio?(captureId: string): void;
  onCaptureEnded?(
    captureId: string,
    evidence?: { activity: "none" | "observed" },
    failed?: boolean,
  ): void;
}) {
  const { provider, providerConfig } = params.transcription;
  const providerAudioFormat =
    provider.resolveInputAudioFormat?.(providerConfig) ?? "g711-ulaw-8khz";
  const createConverter = () =>
    createSpeechSttAudioConverter(params.inputAudioFormat, providerAudioFormat);
  let converter = createConverter();
  let finishing: Promise<void> | undefined;
  let captureId: string | undefined;
  const completed = new Map<string, Promise<void>>();
  const requireCaptureId = (id?: string) => {
    if (params.inputEndMode === "client" && !id?.trim()) {
      throw new Error("Client-ended Talk input requires a captureId on audio and endOfInput");
    }
  };
  const capture = (requested?: string) => {
    if (captureId && requested && captureId !== requested) {
      throw new Error("Talk input does not match the active capture");
    }
    if (!captureId) {
      captureId = requested ?? randomUUID();
      params.onCaptureStarted?.(captureId);
    }
    return captureId;
  };
  return {
    providerAudioFormat,
    get supportsInputEnd() {
      return typeof params.getSession()?.finishInput === "function";
    },
    sendAudio(audio: Buffer, metadata?: { captureId: string }) {
      requireCaptureId(metadata?.captureId);
      if (finishing) {
        throw new Error("Talk input boundary is still being processed");
      }
      if (metadata?.captureId && completed.has(metadata.captureId)) {
        throw new Error("Talk input capture has already ended");
      }
      const id = capture(metadata?.captureId);
      if (params.acceptAudio(audio)) {
        params.onAudio?.(id);
        params.getSession()?.sendAudio(converter.process(audio));
      }
    },
    async finishInput(options?: { captureId?: string }) {
      params.assertCurrent();
      requireCaptureId(options?.captureId);
      const duplicate = options?.captureId ? completed.get(options.captureId) : undefined;
      if (duplicate) {
        return duplicate;
      }
      if (finishing) {
        if (options?.captureId && options.captureId !== captureId) {
          throw new Error("Talk input does not match the closing capture");
        }
        return finishing;
      }
      const session = params.getSession();
      if (!params.isReady() || !session?.finishInput) {
        throw new Error("Transcription provider does not support an explicit input boundary");
      }
      const id = capture(options?.captureId);
      const finishProviderInput = session.finishInput.bind(session);
      const finish = Promise.resolve().then(async () => {
        try {
          params.assertCurrent();
          const remaining = converter.flush();
          converter = createConverter();
          if (remaining.byteLength > 0) {
            session.sendAudio(remaining);
          }
          const evidence = await finishProviderInput({ captureId: id });
          params.assertCurrent();
          params.onCaptureEnded?.(id, evidence || undefined);
        } catch (error) {
          params.onCaptureEnded?.(id, undefined, true);
          throw error;
        }
      });
      finishing = finish;
      try {
        await finish;
      } finally {
        if (finishing === finish) {
          finishing = undefined;
          captureId = undefined;
          completed.set(id, finish);
          if (completed.size > 64) {
            completed.delete(completed.keys().next().value!);
          }
        }
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
      onAudio: Parameters<SpeechAudioTransport["startInput"]>[0],
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
