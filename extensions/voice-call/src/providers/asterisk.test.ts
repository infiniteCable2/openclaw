import net from "node:net";
import type {
  RealtimeTranscriptionSessionCallbacks,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsteriskConfig } from "../config.js";
import type { NormalizedEvent } from "../types.js";
import { AsteriskProvider } from "./asterisk.js";
import {
  AudioSocketFrameDecoder,
  AudioSocketType,
  encodeAudioSocketFrame,
  uuidToAudioSocketPayload,
} from "./asterisk/audiosocket.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

function config(): AsteriskConfig {
  return {
    registrationPath: "/voice/asterisk/register",
    audioSocket: {
      bind: "127.0.0.1",
      port: 0,
      sampleRate: 16_000,
      handshakeTimeoutMs: 500,
      registrationTtlMs: 1_000,
      maxConnections: 2,
    },
  };
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("AsteriskProvider", () => {
  const providers: AsteriskProvider[] = [];
  const sockets: net.Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(providers.map((provider) => provider.stop()));
  });

  it("closes the authenticated inbound STT-agent-TTS media loop", async () => {
    let callbacks: RealtimeTranscriptionSessionCallbacks | undefined;
    let connected = false;
    const sendAudio = vi.fn();
    const provider = new AsteriskProvider({
      config: config(),
      registrationToken: "registration-secret",
      coreConfig: {},
      transcriptionProvider: {
        id: "test-stt",
        isConfigured: () => true,
        createSession: (request: RealtimeTranscriptionSessionCreateRequest) => {
          callbacks = request;
          return {
            connect: async () => {
              connected = true;
            },
            sendAudio,
            close: () => {
              connected = false;
            },
            isConnected: () => connected,
          };
        },
      },
      transcriptionProviderConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    providers.push(provider);
    const events: NormalizedEvent[] = [];
    provider.setEventSink((event) => events.push(event));
    provider.setTTSProvider({
      synthesisTimeoutMs: 1_000,
      synthesizeForTelephony: vi.fn(async () => Buffer.alloc(160, 0xff)),
    });
    provider.registerInboundCall(
      { uuid: UUID, from: "+49111111111", to: "+49222222222", direction: "inbound" },
      "registration-secret",
    );
    const address = await provider.start();
    const socket = await connect(address.port);
    sockets.push(socket);
    socket.write(encodeAudioSocketFrame(AudioSocketType.uuid, uuidToAudioSocketPayload(UUID)));
    await vi.waitFor(() => expect(connected).toBe(true));

    socket.write(encodeAudioSocketFrame(AudioSocketType.pcm16k, Buffer.alloc(640)));
    await vi.waitFor(() => expect(sendAudio).toHaveBeenCalled());
    expect(events.slice(0, 2).map((event) => event.type)).toEqual([
      "call.initiated",
      "call.answered",
    ]);

    callbacks?.onTranscript?.("Guten Morgen");
    expect(events.at(-1)).toMatchObject({
      type: "call.speech",
      providerCallId: UUID,
      transcript: "Guten Morgen",
    });

    const received = new Promise<Buffer>((resolve) => {
      socket.once("data", resolve);
    });
    await provider.playTts({ callId: "internal", providerCallId: UUID, text: "Hallo" });
    const frames = new AudioSocketFrameDecoder().push(await received);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: AudioSocketType.pcm16k });
    expect(frames[0]?.payload.byteLength).toBeGreaterThan(0);
  });

  it("rejects unauthenticated, malformed, and duplicate registrations", () => {
    const provider = new AsteriskProvider({
      config: config(),
      registrationToken: "registration-secret",
      coreConfig: {},
      transcriptionProvider: {
        id: "test-stt",
        isConfigured: () => true,
        createSession: () => ({
          connect: async () => {},
          sendAudio: () => {},
          close: () => {},
          isConnected: () => true,
        }),
      },
      transcriptionProviderConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    providers.push(provider);
    const call = {
      uuid: UUID,
      from: "+49111111111",
      to: "+49222222222",
      direction: "inbound" as const,
    };
    expect(() => provider.registerInboundCall(call, "wrong-secret")).toThrow("Unauthorized");
    expect(() =>
      provider.registerInboundCall({ ...call, from: "anonymous" }, "registration-secret"),
    ).toThrow("E.164");
    provider.registerInboundCall(call, "registration-secret");
    expect(() => provider.registerInboundCall(call, "registration-secret")).toThrow(
      "already registered",
    );
  });
});
