// Only hardware leaves are synthetic. Public Talk RPCs, the model HTTP transport,
// native turns, transcript workers and background knowledge owners remain real.
// Temporary diagnostic: keep the native formatter and report code locations only.
const formatStack = Error.prepareStackTrace;
if (formatStack) {
  Error.prepareStackTrace = (error, frames) => {
    if (error.name === "SessionMutationFactsUnavailableError") {
      process.stderr.write(
        `${JSON.stringify({
          sessionFactsCallers: frames.map(
            (frame) =>
              `${frame.getFileName()?.split(/[\\/]/u).at(-1)}:${frame.getLineNumber()}:${frame.getColumnNumber()}`,
          ),
        })}\n`,
      );
    }
    return formatStack(error, frames);
  };
}
export default {
  id: "qa-conversation-speech",
  register(api) {
    const id = "qa-conversation-speech";
    api.registerRealtimeTranscriptionProvider({
      id,
      label: "Offline conversation speech fixture",
      transcriptGranularity: "utterance",
      isConfigured: () => true,
      resolveInputAudioFormat: () => "pcm16-16khz",
      createSession(request) {
        let connected = false;
        let chunks = [];
        let utterance = 0;
        return {
          async connect() {
            connected = true;
          },
          isConnected: () => connected,
          sendAudio(audio) {
            chunks.push(Buffer.from(audio));
          },
          finishInput() {
            const text = Buffer.concat(chunks).toString("utf8");
            chunks = [];
            if (!text.trim()) {
              return { activity: "none" };
            }
            const utteranceId = `offline-utterance-${++utterance}`;
            request.onSpeechActivity?.({ utteranceId, state: "candidate" });
            request.onTranscript?.(text, { utteranceId });
            return { activity: "observed" };
          },
          close() {
            connected = false;
            chunks = [];
          },
        };
      },
    });
    api.registerSpeechProvider({
      id,
      label: "Offline PCM fixture",
      defaultModel: "offline-pcm",
      isConfigured: () => true,
      resolveConfig: () => ({ model: "offline-pcm", voice: "fixture" }),
      resolveTalkConfig: () => ({ model: "offline-pcm", voice: "fixture" }),
      async synthesize() {
        return {
          audioBuffer: Buffer.alloc(960),
          outputFormat: "pcm",
          fileExtension: ".pcm",
          voiceCompatible: false,
        };
      },
      async synthesizeTelephony() {
        return { audioBuffer: Buffer.alloc(960), outputFormat: "pcm", sampleRate: 24000 };
      },
    });
  },
};
