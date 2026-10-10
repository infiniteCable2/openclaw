/** Supported audio-format names for existing meeting adapters. */
export {
  resolveSpeechAudioFormat as resolveMeetingRealtimeAudioFormat,
  convertSpeechInputForStt as convertMeetingBridgeAudioForStt,
  createSpeechSttAudioConverter as createMeetingSttAudioConverter,
  convertSpeechTtsAudio as convertMeetingTtsAudioForBridge,
  createSpeechTtsAudioStreamConverter as createMeetingTtsAudioStreamConverter,
  type SpeechAudioFormat as MeetingRealtimeAudioFormat,
} from "../talk/speech/audio-format.js";
