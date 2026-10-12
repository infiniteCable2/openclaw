import crypto from "node:crypto";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, onTestFinished, vi } from "vitest";
import { VoiceCallConfigSchema, resolveVoiceCallConfig, type VoiceCallConfig } from "./config.js";
import type { CallManager } from "./manager.js";
import { AsteriskProvider } from "./providers/asterisk.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { PlivoProvider } from "./providers/plivo.js";
import type { TwilioProvider } from "./providers/twilio.js";
import type { CallRecord } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import type { RealtimeCallHandler } from "./webhook/realtime-handler.js";

export const provider: VoiceCallProvider = {
  name: "mock",
  verifyWebhook: () => ({ ok: true, verifiedRequestKey: "mock:req:base" }),
  parseWebhookEvent: () => ({ events: [] }),
  initiateCall: async () => ({ providerCallId: "provider-call", status: "initiated" }),
  hangupCall: async () => {},
  playTts: async () => {},
  startListening: async () => {},
  stopListening: async () => {},
  getCallStatus: async () => ({ status: "in-progress", isTerminal: false }),
};

export function createRealtimeHandler(
  buildTwiMLPayload: RealtimeCallHandler["buildTwiMLPayload"],
): RealtimeCallHandler {
  return {
    buildTwiMLPayload,
    close: async () => {},
    getStreamPathPattern: () => "/voice/stream/realtime",
    handleWebSocketUpgrade: () => {},
    registerToolHandler: () => {},
    setPublicUrl: () => {},
  } as unknown as RealtimeCallHandler;
}

export type TwilioProviderTestDouble = VoiceCallProvider &
  Pick<
    TwilioProvider,
    | "isValidStreamToken"
    | "registerCallStream"
    | "unregisterCallStream"
    | "hasRegisteredStream"
    | "clearTtsQueue"
  >;

type VoiceCallConfigInput = Parameters<typeof resolveVoiceCallConfig>[0];

export const createConfig = (overrides: VoiceCallConfigInput = {}): VoiceCallConfig => {
  const config = VoiceCallConfigSchema.parse({
    ...overrides,
    serve: { ...overrides.serve, port: overrides.serve?.port || 1 },
  });
  config.serve.port = overrides.serve?.port ?? 0;
  return config;
};

export const createCall = (startedAt: number): CallRecord => ({
  callId: "call-1",
  agentId: "main",
  providerCallId: "provider-call-1",
  provider: "mock",
  direction: "outbound",
  state: "initiated",
  from: "+15550001234",
  to: "+15550005678",
  startedAt,
  transcript: [],
  processedEventIds: [],
});

export const automaticReplyManagerStub = {
  updateCallMetadata: async (
    call: CallRecord,
    update: (metadata: CallRecord["metadata"]) => CallRecord["metadata"],
  ) => {
    call.metadata = update(call.metadata);
  },
  createAutoResponseGuard: () => ({ isCurrent: () => true, release: () => {} }),
  invalidateAutoResponse: () => {},
};

export const createManager = (calls: CallRecord[]) => {
  const endCall = vi.fn(async () => ({ success: true }));
  const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
  const manager = {
    ...automaticReplyManagerStub,
    getActiveCalls: () => calls,
    endCall,
    processEvent,
  } as unknown as CallManager;

  return { manager, endCall, processEvent };
};

export type WebhookServerArgs =
  ConstructorParameters<typeof VoiceCallWebhookServer> extends [unknown, ...infer Args]
    ? Args
    : never;

export function createServer(...args: WebhookServerArgs) {
  const server = new VoiceCallWebhookServer(createTestPluginServiceScheduler(), ...args);
  onTestFinished(() => server.stop());
  return server;
}

export async function postSignedTwilioWebhook(params: {
  baseUrl: string;
  authToken: string;
  body: string;
}): Promise<Response> {
  const url = new URL(params.baseUrl);
  let signedMaterial = url.toString();
  for (const [key, value] of [...new URLSearchParams(params.body)].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    signedMaterial += key + value;
  }
  const signature = crypto
    .createHmac("sha1", params.authToken)
    .update(signedMaterial)
    .digest("base64");
  return await postWebhookForm(url, params.body, {
    "x-twilio-signature": signature,
  });
}

export function createTwilioVerificationProvider(
  overrides: Partial<TwilioProviderTestDouble> = {},
): VoiceCallProvider {
  return {
    ...provider,
    name: "twilio",
    verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:test" }),
    ...overrides,
  };
}

export function createTwilioStreamingProvider(
  overrides: Partial<TwilioProviderTestDouble> = {},
): TwilioProviderTestDouble {
  return {
    ...createTwilioVerificationProvider(),
    isValidStreamToken: () => true,
    registerCallStream: () => {},
    unregisterCallStream: () => {},
    hasRegisteredStream: () => true,
    clearTtsQueue: () => {},
    ...overrides,
  };
}

export function createAsteriskRegistrationFixture() {
  const base = createConfig();
  const config = createConfig({
    provider: "asterisk",
    inboundPolicy: "allowlist",
    allowFrom: ["+15550001111"],
    streaming: { ...base.streaming, enabled: true },
    asterisk: {
      ...base.asterisk,
      registrationToken: "registration-secret",
      audioSocket: { ...base.asterisk.audioSocket, port: 0 },
    },
  });
  const asteriskProvider = new AsteriskProvider({
    config: config.asterisk,
    registrationToken: "registration-secret",
    coreConfig: {},
    transcriptionProvider: {
      id: "test-stt",
      label: "Synthetic transcription",
      isConfigured: () => true,
      createSession: () => ({
        connect: async () => {},
        sendAudio: () => {},
        close: () => {},
        isConnected: () => true,
      }),
    },
    transcriptionProviderConfig: {},
  });
  const { manager } = createManager([]);
  const server = createServer(config, manager, asteriskProvider);
  return { config, provider: asteriskProvider, server };
}

export async function postWebhookForm(
  baseUrl: string | URL,
  body: string,
  headers: Record<string, string> = {},
) {
  return await fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  });
}

export function expectNoTwilioStreamState(providerLocal: TwilioProvider) {
  const state = providerLocal as unknown as {
    callStreamMap: Map<string, string>;
    streamAuthTokens: Map<string, string>;
  };
  expect(state.callStreamMap.size).toBe(0);
  expect(state.streamAuthTokens.size).toBe(0);
}

export function expectPlivoCallStateReleased(
  providerLocal: PlivoProvider,
  params: { callId: string; requestUuid: string; callUuid: string },
) {
  const state = providerLocal as unknown as {
    requestUuidToCallUuid: Map<string, string>;
    callIdToWebhookUrl: Map<string, string>;
    callUuidToWebhookUrl: Map<string, string>;
    pendingSpeakByCallId: Map<string, unknown>;
    pendingListenByCallId: Map<string, unknown>;
  };
  expect(state.requestUuidToCallUuid.has(params.requestUuid)).toBe(false);
  expect(state.callIdToWebhookUrl.has(params.callId)).toBe(false);
  expect(state.callUuidToWebhookUrl.has(params.callUuid)).toBe(false);
  expect(state.pendingSpeakByCallId.has(params.callId)).toBe(false);
  expect(state.pendingListenByCallId.has(params.callId)).toBe(false);
}
