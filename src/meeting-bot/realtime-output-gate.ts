import type { RealtimeTranscriptionSessionCallbacks } from "../realtime-transcription/provider-types.js";
import type {
  MeetingRealtimeAudioTransport,
  MeetingOutputGate,
} from "./realtime-audio-transport.js";

export function createMeetingBargeInGate(params: {
  transport: MeetingRealtimeAudioTransport;
  isStopped: () => boolean;
  hasActiveOutput: () => boolean;
  onFailure: (error: unknown) => void;
}) {
  let owner: string | undefined;

  const setGate = (mode: MeetingOutputGate) => {
    if (!params.transport.setOutputGate || params.isStopped()) {
      return;
    }
    void params.transport.setOutputGate(mode).catch(params.onFailure);
  };

  const release = (utteranceId?: string) => {
    if (!utteranceId || utteranceId !== owner) {
      return;
    }
    owner = undefined;
    setGate("normal");
  };

  const onSpeechActivity: NonNullable<RealtimeTranscriptionSessionCallbacks["onSpeechActivity"]> = (
    event,
  ) => {
    if (params.isStopped()) {
      return;
    }
    if (event.state === "candidate") {
      if (params.hasActiveOutput()) {
        owner = event.utteranceId;
        setGate("duck");
      }
    } else if (event.state === "sustained") {
      if (owner === event.utteranceId) {
        setGate("paused");
      }
    } else {
      release(event.utteranceId);
    }
  };

  const clearOutput = async () => {
    const currentOwner = owner;
    try {
      await params.transport.clearOutput();
    } finally {
      release(currentOwner);
    }
  };

  const onProcessing: NonNullable<RealtimeTranscriptionSessionCallbacks["onProcessing"]> = (
    event,
  ) => {
    if (event.state === "empty" || event.state === "failed" || event.state === "cancelled") {
      release(event.utteranceId);
    }
  };

  return { onSpeechActivity, onProcessing, release, clearOutput };
}
