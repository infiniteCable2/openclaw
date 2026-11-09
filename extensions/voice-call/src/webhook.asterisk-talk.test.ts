import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import { createWebhookInFlightLimiter } from "openclaw/plugin-sdk/webhook-ingress";
import * as webhookRequestGuards from "openclaw/plugin-sdk/webhook-request-guards";
import { describe, expect, it, vi } from "vitest";
import type { CallManager } from "./manager.js";
import {
  provider,
  createConfig,
  createCall,
  automaticReplyManagerStub,
  createManager,
  createServer,
  createTwilioStreamingProvider,
  createAsteriskRegistrationFixture,
} from "./webhook.test-fixtures.js";
import { handleAsteriskRegistrationRequest } from "./webhook/asterisk-registration.js";

const mocks = vi.hoisted(() => {
  const realtimeTranscriptionProvider: RealtimeTranscriptionProviderPlugin = {
    id: "openai",
    label: "OpenAI",
    aliases: ["openai-realtime"],
    isConfigured: () => true,
    resolveConfig: ({ rawConfig }) => rawConfig,
    createSession: () => ({
      connect: async () => {},
      sendAudio: () => {},
      close: () => {},
      isConnected: () => true,
    }),
  };

  return {
    generateVoiceResponse: vi.fn(
      async (_params?: {
        onEarlyText?: (text: string) => Promise<boolean>;
      }): Promise<{ text: string | null; deliveredEarly: boolean }> => ({
        text: null,
        deliveredEarly: false,
      }),
    ),
    getRealtimeTranscriptionProvider: vi.fn<(...args: unknown[]) => unknown>(
      () => realtimeTranscriptionProvider,
    ),
    listRealtimeTranscriptionProviders: vi.fn(() => [realtimeTranscriptionProvider]),
  };
});

vi.mock("./realtime-transcription.runtime.js", () => ({
  getRealtimeTranscriptionProvider: mocks.getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders: mocks.listRealtimeTranscriptionProviders,
}));

vi.mock("./response-generator.js", () => ({
  generateVoiceResponse: mocks.generateVoiceResponse,
}));

describe("VoiceCallWebhookServer Asterisk registration", () => {
  it("authenticates and applies inbound policy before reserving a UUID", async () => {
    const fixture = createAsteriskRegistrationFixture();
    const register = vi.spyOn(fixture.provider, "registerInboundCall");
    try {
      const baseUrl = await fixture.server.start();
      const requestUrl = new URL(baseUrl);
      requestUrl.pathname = fixture.config.asterisk.registrationPath;
      const post = async (token: string, from: string) =>
        await fetch(requestUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            uuid: "123e4567-e89b-12d3-a456-426614174000",
            from,
            to: "+15550002222",
          }),
        });

      expect((await post("wrong-secret", "+15550001111")).status).toBe(401);
      expect((await post("registration-secret", "+15550003333")).status).toBe(403);
      const accepted = await post("registration-secret", "+15550001111");
      expect(accepted.status).toBe(202);
      expect(await accepted.text()).toBe("Accepted");
      expect(register).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.server.stop();
      await fixture.provider.stop();
    }
  });
  it("rejects a name-spoofed Asterisk provider before body read and releases its limiter", async () => {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = "POST";
    req.headers = { authorization: "Bearer registration-secret" };
    const spoofed = {
      ...provider,
      name: "asterisk" as const,
      verifyRegistrationToken: vi.fn(() => true),
      registerInboundCall: vi.fn(),
    };
    const readBody = vi.spyOn(webhookRequestGuards, "readRequestBodyWithLimit");
    const inFlightLimiter = createWebhookInFlightLimiter({ maxInFlightPerKey: 1 });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    try {
      await expect(
        handleAsteriskRegistrationRequest({
          req,
          provider: spoofed,
          config: createConfig({ provider: "asterisk" }),
          logger,
          inFlightLimiter,
          inFlightKey: "synthetic-request",
        }),
      ).resolves.toEqual({ statusCode: 401, body: "Unauthorized" });
      expect(readBody).not.toHaveBeenCalled();
      expect(spoofed.verifyRegistrationToken).not.toHaveBeenCalled();
      expect(spoofed.registerInboundCall).not.toHaveBeenCalled();
      expect(inFlightLimiter.size()).toBe(0);
      expect(inFlightLimiter.tryAcquire("synthetic-request")).toBe(true);
    } finally {
      inFlightLimiter.clear();
      readBody.mockRestore();
      req.destroy();
      socket.destroy();
    }
  });
});

describe("VoiceCallWebhookServer realtime transcription provider selection", () => {
  it("auto-selects the first registered provider when streaming.provider is unset", async () => {
    const { manager } = createManager([]);
    const config = createConfig({
      streaming: {
        ...createConfig().streaming,
        enabled: true,
        providers: {
          openai: {
            apiKey: "sk-test", // pragma: allowlist secret
          },
        },
      },
    });
    const autoSelectedProvider: RealtimeTranscriptionProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      autoSelectOrder: 5,
      isConfigured: () => true,
      resolveConfig: ({ rawConfig }) => rawConfig,
      createSession: () => ({
        connect: async () => {},
        sendAudio: () => {},
        close: () => {},
        isConnected: () => true,
      }),
    };
    mocks.getRealtimeTranscriptionProvider.mockReturnValueOnce(undefined);
    mocks.listRealtimeTranscriptionProviders.mockReturnValueOnce([autoSelectedProvider]);

    const server = createServer(config, manager, provider);
    try {
      await server.start();
      expect(mocks.getRealtimeTranscriptionProvider).not.toHaveBeenCalled();
      expect(mocks.listRealtimeTranscriptionProviders).toHaveBeenCalledWith(undefined, ["openai"]);
      const mediaStreamHandler = server.getMediaStreamHandler();
      if (!mediaStreamHandler) {
        throw new Error("expected media stream handler");
      }
      expect(mediaStreamHandler["handleUpgrade"]).toBeTypeOf("function");
      expect(mediaStreamHandler["sendAudio"]).toBeTypeOf("function");
    } finally {
      await server.stop();
    }
  });
  it("records media stream Talk events on the active call metadata", async () => {
    const call = createCall(Date.now());
    const manager = {
      ...automaticReplyManagerStub,
      getActiveCalls: () => [call],
      getCallByProviderCallId: (providerCallId: string) =>
        providerCallId === "provider-call-1" ? call : undefined,
      endCall: vi.fn(async () => ({ success: true })),
      processEvent: vi.fn(),
      speakInitialMessage: vi.fn(async () => {}),
    } as unknown as CallManager;
    const config = createConfig({
      provider: "twilio",
      streaming: {
        ...createConfig().streaming,
        enabled: true,
        providers: {
          openai: {
            apiKey: "sk-test", // pragma: allowlist secret
          },
        },
      },
    });

    const server = createServer(config, manager, createTwilioStreamingProvider());
    try {
      await server.start();
      const mediaHandler = server.getMediaStreamHandler() as unknown as {
        config: {
          onTalkEvent?: NonNullable<import("./media-stream.js").MediaStreamConfig["onTalkEvent"]>;
        };
      };
      mediaHandler.config.onTalkEvent?.("provider-call-1", "MZ-talk", {
        id: "voice-call:provider-call-1:MZ-talk:1",
        type: "transcript.done",
        sessionId: "voice-call:provider-call-1:MZ-talk",
        turnId: "MZ-talk:turn:1",
        seq: 1,
        timestamp: "2026-05-05T06:00:00.000Z",
        mode: "stt-tts",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        final: true,
        payload: { text: "hello", role: "user" },
      });

      expect(call.metadata?.lastTalkEventAt).toBe("2026-05-05T06:00:00.000Z");
      expect(call.metadata?.lastTalkEventType).toBe("transcript.done");
      expect(call.metadata?.recentTalkEvents).toEqual([
        {
          at: "2026-05-05T06:00:00.000Z",
          type: "transcript.done",
          sessionId: "voice-call:provider-call-1:MZ-talk",
          turnId: "MZ-talk:turn:1",
        },
      ]);
    } finally {
      await server.stop();
    }
  });
});
