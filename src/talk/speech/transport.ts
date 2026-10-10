type SpeechOutputLoopbackHealth = {
  lastOutputLoopbackAt?: string;
  lastOutputLoopbackCorrelation?: number;
  lastOutputLoopbackPeak?: number;
  lastOutputLoopbackRms?: number;
  outputLoopbackSignalBytes: number;
  outputGeneration: number;
  verifiedOutputGeneration?: number;
};
export type SpeechAudioTransportHealth = Partial<SpeechOutputLoopbackHealth> & {
  consecutiveInputErrors?: number;
  lastInputError?: string;
};
export type SpeechOutputGate = "normal" | "duck" | "paused";

/** Media boundary only; admission and agent task ownership belong to the native runtime. */
export interface SpeechAudioTransport {
  readonly supportsFullDuplexInput?: boolean;
  inputAudioIsolated?: boolean;
  onFatal(handler: () => void): void;
  startInput(onAudio: (audio: Buffer) => void): void | Promise<void>;
  /** Actual remote playback readiness, not merely local publication or received microphone data. */
  waitForRemoteAudioReady?(): Promise<void>;
  beginOutput?(): void;
  stop(): Promise<void>;
  writeOutput(audio: Buffer): Promise<void>;
  clearOutput(): Promise<void>;
  setOutputGate?(gate: SpeechOutputGate): Promise<void>;
  dispose(): Promise<void>;
  getHealth?(): SpeechAudioTransportHealth;
  startBargeInMonitor?(onBargeIn: (audio: Buffer) => boolean): void;
}
