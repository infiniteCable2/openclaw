import {
  createMeetingRealtimeEngineBindings,
  createNodeMeetingRealtimeAudioTransport,
  startMeetingRealtimeEngine,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { vi } from "vitest";
import type { GoogleMeetConfig } from "../config.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "../transports/google-meet-platform-adapter.js";

type TestMeetVoiceBridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];

export function createTestMeetTranscriptionProvider(
  options: { createSession?: RealtimeTranscriptionProviderPlugin["createSession"] } = {},
) {
  let request: Parameters<RealtimeTranscriptionProviderPlugin["createSession"]>[0] | undefined;
  const sttSession = {
    connect: vi.fn(async () => {}),
    sendAudio: vi.fn<(audio: Buffer) => void>(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
  };
  const provider: RealtimeTranscriptionProviderPlugin = {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o-transcribe",
    autoSelectOrder: 1,
    resolveConfig: ({ rawConfig }) => rawConfig,
    isConfigured: () => true,
    createSession: (nextRequest) => {
      request = nextRequest;
      return options.createSession ? options.createSession(nextRequest) : sttSession;
    },
  };
  return {
    provider,
    sttSession,
    sendAudio: sttSession.sendAudio,
    requireRequest: () => {
      if (!request) {
        throw new Error("Expected realtime transcription callbacks");
      }
      return request;
    },
  };
}

export function createTestMeetVoiceProvider(
  options: {
    defaultModel?: string;
    handleBargeIn?: RealtimeVoiceBridge["handleBargeIn"];
    sendUserMessage?: RealtimeVoiceBridge["sendUserMessage"];
    triggerGreeting?: RealtimeVoiceBridge["triggerGreeting"];
  } = {},
) {
  let request: TestMeetVoiceBridgeRequest | undefined;
  const bridge = {
    connect: vi.fn(async () => {}),
    sendAudio: vi.fn(),
    ...(options.sendUserMessage ? { sendUserMessage: options.sendUserMessage } : {}),
    setMediaTimestamp: vi.fn(),
    ...(options.handleBargeIn ? { handleBargeIn: options.handleBargeIn } : {}),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    ...(options.triggerGreeting ? { triggerGreeting: options.triggerGreeting } : {}),
    isConnected: vi.fn(() => true),
  };
  const provider: RealtimeVoiceProviderPlugin = {
    id: "openai",
    label: "OpenAI",
    ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
    autoSelectOrder: 1,
    resolveConfig: ({ rawConfig }) => rawConfig,
    isConfigured: () => true,
    createBridge: (nextRequest) => {
      request = nextRequest;
      return bridge;
    },
  };
  return {
    bridge,
    provider,
    sendAudio: bridge.sendAudio,
    requireRequest: () => {
      if (!request) {
        throw new Error("Expected realtime bridge callbacks");
      }
      return request;
    },
  };
}

export function createGoogleMeetTestEngineBindings(params: {
  config: Parameters<typeof createMeetingRealtimeEngineBindings>[0]["config"];
  fullConfig: Parameters<typeof createMeetingRealtimeEngineBindings>[0]["fullConfig"];
  runtime: Parameters<typeof createMeetingRealtimeEngineBindings>[0]["runtime"];
  logger: Parameters<typeof createMeetingRealtimeEngineBindings>[0]["logger"];
}) {
  return createMeetingRealtimeEngineBindings({
    platform: GOOGLE_MEET_PLATFORM_ADAPTER,
    ...params,
  });
}

type TestNodeRealtimeEngineParams = Omit<
  Parameters<typeof startMeetingRealtimeEngine>[0],
  "config" | "consultAgent" | "handleToolCall" | "platform" | "tools" | "transport"
> & {
  config: GoogleMeetConfig;
  nodeId: string;
  bridgeId: string;
};

export async function startTestNodeRealtimeAudioBridge(params: TestNodeRealtimeEngineParams) {
  const { nodeId, bridgeId, ...engineParams } = params;
  const transport = createNodeMeetingRealtimeAudioTransport({
    runtime: params.runtime,
    nodeId,
    bridgeId,
    logger: params.logger,
    commandName: "googlemeet.chrome",
    logScope: "[google-meet]",
    logPrefix: "node",
  });
  Reflect.set(transport, Symbol.for("openclaw.internal.meeting-node-output-generation.v1"), true);
  return await startMeetingRealtimeEngine({
    ...engineParams,
    ...createGoogleMeetTestEngineBindings(engineParams),
    logPrefix: "node",
    talkSessionId: `google-meet:${params.meetingSessionId}:${bridgeId}:node-realtime`,
    talkContext: { nodeId, bridgeId },
    transport,
  });
}
