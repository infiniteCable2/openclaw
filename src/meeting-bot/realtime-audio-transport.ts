export type MeetingRealtimeAudioTransportHealth = {
  consecutiveInputErrors?: number;
  lastInputError?: string;
  lastOutputLoopbackAt?: string;
  lastOutputLoopbackCorrelation?: number;
  lastOutputLoopbackPeak?: number;
  lastOutputLoopbackRms?: number;
  outputLoopbackSignalBytes?: number;
  outputGeneration?: number;
  verifiedOutputGeneration?: number;
};

/** Reversible playout states for acoustic barge-in, before a caller turn is confirmed. */
export type MeetingOutputGate = "normal" | "duck" | "paused";

export interface MeetingRealtimeAudioTransport {
  /**
   * True only when input remains usable while output is playing, because capture is
   * transport-isolated from local playback or protected by active acoustic echo cancellation.
   */
  readonly supportsFullDuplexInput?: boolean;
  /** Input contains browser playback only, excluding native microphone injection. */
  inputAudioIsolated?: boolean;
  /** Delivers a prior failure immediately so provider setup cannot outrun transport teardown. */
  onFatal(handler: () => void): void;
  startInput(onAudio: (audio: Buffer) => void): void;
  /** Starts one assistant-output generation so loopback proof cannot reuse older audio. */
  beginOutput?(): void;
  stop(): Promise<void>;
  writeOutput(audio: Buffer): Promise<void>;
  clearOutput(): Promise<void>;
  /** Applies to audio already queued by the transport as well as future writes. */
  setOutputGate?(gate: MeetingOutputGate): Promise<void>;
  dispose(): Promise<void>;
  getHealth?(): MeetingRealtimeAudioTransportHealth;
  startBargeInMonitor?(onBargeIn: (audio: Buffer) => boolean): void;
}
