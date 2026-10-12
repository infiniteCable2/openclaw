import { vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

export function createPluginTtsRuntimeMock(): PluginRuntime["tts"] {
  return {
    prepareTtsRequest: vi.fn<PluginRuntime["tts"]["prepareTtsRequest"]>(),
    prepareTextToSpeechTelephony: vi.fn<PluginRuntime["tts"]["prepareTextToSpeechTelephony"]>(),
    streamTextToSpeechTelephony: vi.fn<PluginRuntime["tts"]["streamTextToSpeechTelephony"]>(),
    textToSpeech: vi.fn<PluginRuntime["tts"]["textToSpeech"]>(),
    textToSpeechStream: vi.fn<PluginRuntime["tts"]["textToSpeechStream"]>(),
    textToSpeechTelephony: vi.fn<PluginRuntime["tts"]["textToSpeechTelephony"]>(),
    listVoices: vi.fn<PluginRuntime["tts"]["listVoices"]>(),
  };
}
