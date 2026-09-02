import net from "node:net";
import {
  AUDIOSOCKET_MAX_PAYLOAD_BYTES,
  AudioSocketFrameDecoder,
  AudioSocketType,
  audioSocketSampleRateForType,
  audioSocketTypeForSampleRate,
  encodeAudioSocketFrame,
  uuidFromAudioSocketPayload,
} from "./audiosocket.js";

export type AsteriskAudioSocketRegistration = {
  uuid: string;
  from: string;
  to: string;
  direction: "inbound" | "outbound";
};

export type AsteriskAudioSocketSession = AsteriskAudioSocketRegistration & {
  remoteAddress?: string;
};

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type AsteriskAudioSocketServerOptions = {
  bind: string;
  port: number;
  handshakeTimeoutMs?: number;
  maxConnections?: number;
  consumeRegistration: (uuid: string) => AsteriskAudioSocketRegistration | undefined;
  onConnect?: (session: AsteriskAudioSocketSession) => void;
  onAudio?: (session: AsteriskAudioSocketSession, pcm: Buffer, sampleRate: number) => void;
  onDtmf?: (session: AsteriskAudioSocketSession, digit: string) => void;
  onHangup?: (session: AsteriskAudioSocketSession) => void;
  logger?: Logger;
};

type ActiveConnection = {
  socket: net.Socket;
  decoder: AudioSocketFrameDecoder;
  session?: AsteriskAudioSocketSession;
  handshakeTimer: NodeJS.Timeout;
  ended: boolean;
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_PRE_FRAME_BYTES = AUDIOSOCKET_MAX_PAYLOAD_BYTES + 3;
const VALID_DTMF = /^[0-9A-D*#]$/iu;

function resolveListenAddress(server: net.Server, fallbackHost: string, fallbackPort: number) {
  const address = server.address();
  if (!address || typeof address === "string") {
    return { host: fallbackHost, port: fallbackPort };
  }
  return { host: address.address, port: address.port };
}

/** Local TCP owner for authenticated Asterisk AudioSocket media sessions. */
export class AsteriskAudioSocketServer {
  private readonly options: AsteriskAudioSocketServerOptions;
  private readonly logger: Logger;
  private server: net.Server | null = null;
  private startPromise: Promise<{ host: string; port: number }> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly connections = new Set<ActiveConnection>();
  private readonly sessions = new Map<string, ActiveConnection>();

  constructor(options: AsteriskAudioSocketServerOptions) {
    this.options = options;
    this.logger = options.logger ?? console;
  }

  start(): Promise<{ host: string; port: number }> {
    if (this.server?.listening) {
      return Promise.resolve(
        resolveListenAddress(this.server, this.options.bind, this.options.port),
      );
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.server = net.createServer((socket) => this.accept(socket));
    this.startPromise = new Promise((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => {
        server.off("listening", onListening);
        this.startPromise = null;
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        this.startPromise = null;
        resolve(resolveListenAddress(server, this.options.bind, this.options.port));
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, this.options.bind);
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const server = this.server;
    this.server = null;
    for (const connection of this.connections) {
      connection.socket.destroy();
    }
    this.stopPromise = new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    }).finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  hasSession(uuid: string): boolean {
    return this.sessions.has(uuid.toLowerCase());
  }

  sendAudio(uuid: string, pcm: Buffer, sampleRate: number): boolean {
    const connection = this.sessions.get(uuid.toLowerCase());
    const type = audioSocketTypeForSampleRate(sampleRate);
    if (!connection || !type || pcm.byteLength > AUDIOSOCKET_MAX_PAYLOAD_BYTES) {
      return false;
    }
    return connection.socket.write(encodeAudioSocketFrame(type, pcm));
  }

  waitForDrain(uuid: string, timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<boolean> {
    const connection = this.sessions.get(uuid.toLowerCase());
    if (!connection || connection.socket.destroyed || !connection.socket.writable) {
      return Promise.resolve(false);
    }
    if (!connection.socket.writableNeedDrain) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const socket = connection.socket;
      const finish = (recovered: boolean) => {
        clearTimeout(timer);
        socket.off("drain", onDrain);
        socket.off("close", onClose);
        resolve(recovered && this.sessions.get(uuid.toLowerCase()) === connection);
      };
      const onDrain = () => finish(true);
      const onClose = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      socket.once("drain", onDrain);
      socket.once("close", onClose);
    });
  }

  sendDtmf(uuid: string, digit: string): boolean {
    const connection = this.sessions.get(uuid.toLowerCase());
    if (!connection || !VALID_DTMF.test(digit)) {
      return false;
    }
    return connection.socket.write(
      encodeAudioSocketFrame(AudioSocketType.dtmf, Buffer.from(digit, "ascii")),
    );
  }

  hangup(uuid: string): boolean {
    const connection = this.sessions.get(uuid.toLowerCase());
    if (!connection) {
      return false;
    }
    connection.socket.end(encodeAudioSocketFrame(AudioSocketType.hangup));
    return true;
  }

  private accept(socket: net.Socket): void {
    if (this.connections.size >= (this.options.maxConnections ?? DEFAULT_MAX_CONNECTIONS)) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    const connection: ActiveConnection = {
      socket,
      decoder: new AudioSocketFrameDecoder(),
      handshakeTimer: setTimeout(
        () => socket.destroy(new Error("AudioSocket UUID handshake timed out")),
        this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      ),
      ended: false,
    };
    connection.handshakeTimer.unref?.();
    this.connections.add(connection);
    socket.on("data", (chunk) =>
      this.receive(connection, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    socket.on("error", (error) => {
      this.logger.warn(`[voice-call] Asterisk AudioSocket error: ${error.message}`);
    });
    socket.on("close", () => this.finish(connection));
  }

  private receive(connection: ActiveConnection, chunk: Buffer): void {
    const frames = connection.decoder.push(chunk);
    if (connection.decoder.bufferedBytes > MAX_BUFFERED_PRE_FRAME_BYTES) {
      connection.socket.destroy(new Error("AudioSocket frame buffer exceeded protocol maximum"));
      return;
    }
    for (const frame of frames) {
      if (!connection.session) {
        if (frame.type !== AudioSocketType.uuid) {
          connection.socket.destroy(new Error("AudioSocket first frame must identify the UUID"));
          return;
        }
        let uuid: string;
        try {
          uuid = uuidFromAudioSocketPayload(frame.payload).toLowerCase();
        } catch (error) {
          connection.socket.destroy(error as Error);
          return;
        }
        const registration = this.options.consumeRegistration(uuid);
        if (!registration || this.sessions.has(uuid)) {
          connection.socket.destroy(
            new Error("AudioSocket UUID is not registered or already active"),
          );
          return;
        }
        clearTimeout(connection.handshakeTimer);
        connection.session = {
          ...registration,
          uuid,
          remoteAddress: connection.socket.remoteAddress,
        };
        this.sessions.set(uuid, connection);
        this.options.onConnect?.(connection.session);
        continue;
      }
      if (frame.type === AudioSocketType.hangup) {
        connection.socket.end();
        return;
      }
      if (frame.type === AudioSocketType.dtmf) {
        const digit = frame.payload.toString("ascii");
        if (frame.payload.byteLength === 1 && VALID_DTMF.test(digit)) {
          this.options.onDtmf?.(connection.session, digit);
        }
        continue;
      }
      const sampleRate = audioSocketSampleRateForType(frame.type);
      if (sampleRate) {
        if (frame.payload.byteLength % 2 !== 0) {
          connection.socket.destroy(
            new Error("AudioSocket PCM payload must contain 16-bit samples"),
          );
          return;
        }
        this.options.onAudio?.(connection.session, frame.payload, sampleRate);
        continue;
      }
      if (frame.type === AudioSocketType.error) {
        connection.socket.destroy(new Error("Asterisk reported an AudioSocket error"));
        return;
      }
      connection.socket.destroy(
        new Error(`Unsupported AudioSocket frame type 0x${frame.type.toString(16)}`),
      );
      return;
    }
  }

  private finish(connection: ActiveConnection): void {
    if (connection.ended) {
      return;
    }
    connection.ended = true;
    clearTimeout(connection.handshakeTimer);
    this.connections.delete(connection);
    const session = connection.session;
    if (session && this.sessions.get(session.uuid) === connection) {
      this.sessions.delete(session.uuid);
      this.options.onHangup?.(session);
    }
  }
}
