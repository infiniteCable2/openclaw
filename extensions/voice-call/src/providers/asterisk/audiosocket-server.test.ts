import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsteriskAudioSocketServer } from "./audiosocket-server.js";
import {
  AudioSocketFrameDecoder,
  AudioSocketType,
  encodeAudioSocketFrame,
  uuidToAudioSocketPayload,
} from "./audiosocket.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

function waitForClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
  });
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("AsteriskAudioSocketServer", () => {
  const servers: AsteriskAudioSocketServer[] = [];
  const sockets: net.Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(servers.map((server) => server.stop()));
  });

  it("admits a registered UUID and carries PCM, DTMF, outbound media, and hangup", async () => {
    const onConnect = vi.fn();
    const onAudio = vi.fn();
    const onDtmf = vi.fn();
    const onHangup = vi.fn();
    const server = new AsteriskAudioSocketServer({
      bind: "127.0.0.1",
      port: 0,
      consumeRegistration: (uuid) =>
        uuid === UUID
          ? { uuid, from: "+49111111111", to: "+49222222222", direction: "inbound" }
          : undefined,
      onConnect,
      onAudio,
      onDtmf,
      onHangup,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    servers.push(server);
    const address = await server.start();
    const socket = await connect(address.port);
    sockets.push(socket);
    const received = new Promise<Buffer>((resolve) => {
      socket.once("data", resolve);
    });

    socket.write(
      Buffer.concat([
        encodeAudioSocketFrame(AudioSocketType.uuid, uuidToAudioSocketPayload(UUID)),
        encodeAudioSocketFrame(AudioSocketType.pcm16k, Buffer.from([1, 0, 2, 0])),
        encodeAudioSocketFrame(AudioSocketType.dtmf, Buffer.from("#")),
      ]),
    );
    await vi.waitFor(() => expect(onDtmf).toHaveBeenCalledOnce());

    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: UUID, direction: "inbound" }),
    );
    expect(onAudio).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: UUID }),
      Buffer.from([1, 0, 2, 0]),
      16_000,
    );
    expect(onDtmf).toHaveBeenCalledWith(expect.objectContaining({ uuid: UUID }), "#");
    expect(server.hasSession(UUID)).toBe(true);

    expect(server.sendAudio(UUID, Buffer.from([3, 0, 4, 0]), 16_000)).toBe(true);
    const decoder = new AudioSocketFrameDecoder();
    expect(decoder.push(await received)).toEqual([
      { type: AudioSocketType.pcm16k, payload: Buffer.from([3, 0, 4, 0]) },
    ]);

    const closed = waitForClose(socket);
    expect(server.hangup(UUID)).toBe(true);
    await closed;
    await vi.waitFor(() => expect(onHangup).toHaveBeenCalledOnce());
    expect(server.hasSession(UUID)).toBe(false);
  });

  it("rejects unregistered UUIDs before media callbacks run", async () => {
    const onConnect = vi.fn();
    const onAudio = vi.fn();
    const server = new AsteriskAudioSocketServer({
      bind: "127.0.0.1",
      port: 0,
      consumeRegistration: () => undefined,
      onConnect,
      onAudio,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    servers.push(server);
    const address = await server.start();
    const socket = await connect(address.port);
    sockets.push(socket);
    const closed = waitForClose(socket);
    socket.write(encodeAudioSocketFrame(AudioSocketType.uuid, uuidToAudioSocketPayload(UUID)));
    await closed;

    expect(onConnect).not.toHaveBeenCalled();
    expect(onAudio).not.toHaveBeenCalled();
  });

  it("rejects audio before the UUID handshake", async () => {
    const server = new AsteriskAudioSocketServer({
      bind: "127.0.0.1",
      port: 0,
      consumeRegistration: () => undefined,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    servers.push(server);
    const address = await server.start();
    const socket = await connect(address.port);
    sockets.push(socket);
    const closed = waitForClose(socket);
    socket.write(encodeAudioSocketFrame(AudioSocketType.pcm8k, Buffer.from([0, 0])));
    await closed;
    expect(server.hasSession(UUID)).toBe(false);
  });

  it.each([
    ["unknown frame", encodeAudioSocketFrame(0x7f)],
    ["misaligned PCM", encodeAudioSocketFrame(AudioSocketType.pcm16k, Buffer.from([0]))],
  ])("closes an authenticated connection for %s", async (_label, invalidFrame) => {
    const server = new AsteriskAudioSocketServer({
      bind: "127.0.0.1",
      port: 0,
      consumeRegistration: (uuid) => ({
        uuid,
        from: "+49111111111",
        to: "+49222222222",
        direction: "inbound",
      }),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    servers.push(server);
    const address = await server.start();
    const socket = await connect(address.port);
    sockets.push(socket);
    const closed = waitForClose(socket);
    socket.write(
      Buffer.concat([
        encodeAudioSocketFrame(AudioSocketType.uuid, uuidToAudioSocketPayload(UUID)),
        invalidFrame,
      ]),
    );
    await closed;
    expect(server.hasSession(UUID)).toBe(false);
  });
});
