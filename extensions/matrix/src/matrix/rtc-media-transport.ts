import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { MeetingRealtimeAudioTransport } from "openclaw/plugin-sdk/meeting-runtime";

const CONTROL_LINE_LIMIT = 128 * 1024;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;
const OUTPUT_FRAME_MAGIC = Buffer.from("OCAP", "ascii");
const OUTPUT_FRAME_VERSION = 1;
const OUTPUT_FRAME_HEADER_BYTES = 20;
const OUTPUT_PCM_FRAME_BYTES = 480;

export type MatrixRtcMediaKey = {
  participantIdentity: string;
  index: number;
  key: Uint8Array<ArrayBuffer>;
};

type ControlEvent =
  | { type: "ready" }
  | { type: "connected" }
  | { type: "output_cleared"; generation: number }
  | { type: "stopped" }
  | { type: "fatal"; code?: string };

export function encodeMatrixRtcOutputFrame(generation: number, audio: Buffer): Buffer {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("MatrixRTC media output generation is invalid");
  }
  if (audio.byteLength === 0 || audio.byteLength > OUTPUT_PCM_FRAME_BYTES || audio.byteLength % 2) {
    throw new Error("MatrixRTC media output frame is invalid");
  }
  const header = Buffer.alloc(OUTPUT_FRAME_HEADER_BYTES);
  OUTPUT_FRAME_MAGIC.copy(header, 0);
  header.writeUInt8(OUTPUT_FRAME_VERSION, 4);
  header.writeBigUInt64BE(BigInt(generation), 8);
  header.writeUInt32BE(audio.byteLength, 16);
  return Buffer.concat([header, audio]);
}

function wireKey(key: MatrixRtcMediaKey) {
  return {
    participant_identity: key.participantIdentity,
    index: key.index,
    key_base64: Buffer.from(key.key).toString("base64"),
  };
}

async function validateMediaBridgeCommand(command: string): Promise<void> {
  if (!path.isAbsolute(command)) {
    throw new Error("MatrixRTC media bridge command must be absolute");
  }
  const info = await lstat(command);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("MatrixRTC media bridge command must be a regular file, not a symlink");
  }
  if ((info.mode & 0o111) === 0) {
    throw new Error("MatrixRTC media bridge command is not executable");
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error("MatrixRTC media bridge command must not be group- or world-writable");
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function connectControlSocket(
  socketPath: string,
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
): Promise<net.Socket> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("MatrixRTC media bridge exited before opening its control socket");
    }
    try {
      const info = await lstat(socketPath);
      if (!info.isSocket() || (info.mode & 0o777) !== 0o600) {
        throw new Error("MatrixRTC media bridge created an unsafe control socket");
      }
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.createConnection({ path: socketPath, signal });
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") {
        throw error;
      }
      await delay(25, undefined, { signal });
    }
  }
  throw new Error("MatrixRTC media bridge control socket timed out");
}

export class NativeMatrixRtcAudioTransport implements MeetingRealtimeAudioTransport {
  /** LiveKit delivers the remote participant track separately from the agent's published output. */
  readonly supportsFullDuplexInput = true;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #control: net.Socket;
  readonly #tempDir: string;
  #controlBuffer = Buffer.alloc(0);
  #events: ControlEvent[] = [];
  #eventWaiters: Array<{
    type: ControlEvent["type"];
    resolve: (event: ControlEvent) => void;
    reject: (error: Error) => void;
  }> = [];
  #fatalHandlers = new Set<() => void>();
  #fatal = false;
  #stopping = false;
  #stopped = false;
  #inputStarted = false;
  #outputGeneration = 0;
  #clearTail = Promise.resolve();

  constructor(params: {
    child: ChildProcessWithoutNullStreams;
    control: net.Socket;
    tempDir: string;
  }) {
    this.#child = params.child;
    this.#control = params.control;
    this.#tempDir = params.tempDir;
    this.#child.stderr.on("data", () => {});
    this.#child.once("error", () => this.#markFatal());
    this.#child.once("exit", () => {
      if (!this.#stopping && !this.#stopped) {
        this.#markFatal();
      }
    });
    this.#control.on("data", (chunk: Buffer) => this.#consumeControl(chunk));
    this.#control.once("error", () => this.#markFatal());
    this.#control.once("close", () => {
      if (!this.#stopping && !this.#stopped) {
        this.#markFatal();
      }
    });
  }

  #markFatal() {
    if (this.#fatal) {
      return;
    }
    this.#fatal = true;
    const error = new Error("MatrixRTC native media bridge failed");
    for (const waiter of this.#eventWaiters.splice(0)) {
      waiter.reject(error);
    }
    for (const handler of this.#fatalHandlers) {
      handler();
    }
  }

  #consumeControl(chunk: Buffer) {
    this.#controlBuffer = Buffer.concat([this.#controlBuffer, chunk]);
    if (this.#controlBuffer.byteLength > CONTROL_LINE_LIMIT) {
      this.#markFatal();
      return;
    }
    while (true) {
      const newline = this.#controlBuffer.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      const line = this.#controlBuffer.subarray(0, newline);
      this.#controlBuffer = this.#controlBuffer.subarray(newline + 1);
      let event: ControlEvent;
      try {
        event = JSON.parse(line.toString("utf8")) as ControlEvent;
      } catch {
        this.#markFatal();
        return;
      }
      if (event.type === "fatal") {
        this.#markFatal();
        return;
      }
      const waiterIndex = this.#eventWaiters.findIndex((waiter) => waiter.type === event.type);
      if (waiterIndex >= 0) {
        const [waiter] = this.#eventWaiters.splice(waiterIndex, 1);
        waiter?.resolve(event);
      } else {
        this.#events.push(event);
      }
    }
  }

  async waitForControlEvent(type: ControlEvent["type"]): Promise<ControlEvent> {
    const index = this.#events.findIndex((event) => event.type === type);
    if (index >= 0) {
      return this.#events.splice(index, 1)[0]!;
    }
    if (this.#fatal) {
      throw new Error("MatrixRTC native media bridge failed");
    }
    return await new Promise<ControlEvent>((resolve, reject) => {
      const waiter = { type, resolve, reject };
      this.#eventWaiters.push(waiter);
      const timer = setTimeout(() => {
        const waiterIndex = this.#eventWaiters.indexOf(waiter);
        if (waiterIndex >= 0) {
          this.#eventWaiters.splice(waiterIndex, 1);
        }
        reject(new Error(`MatrixRTC media bridge ${type} event timed out`));
      }, START_TIMEOUT_MS);
      const originalResolve = waiter.resolve;
      waiter.resolve = (event) => {
        clearTimeout(timer);
        originalResolve(event);
      };
      const originalReject = waiter.reject;
      waiter.reject = (error) => {
        clearTimeout(timer);
        originalReject(error);
      };
    });
  }

  sendControl(message: Record<string, unknown>): void {
    if (this.#fatal || this.#stopped || this.#control.destroyed) {
      throw new Error("MatrixRTC media bridge control channel is unavailable");
    }
    this.#control.write(`${JSON.stringify(message)}\n`);
  }

  sendKey(key: MatrixRtcMediaKey): void {
    this.sendControl({ type: "key", ...wireKey(key) });
  }

  onFatal(handler: () => void): void {
    this.#fatalHandlers.add(handler);
    if (this.#fatal) {
      handler();
    }
  }

  startInput(onAudio: (audio: Buffer) => void): void {
    if (this.#inputStarted) {
      throw new Error("MatrixRTC media input already started");
    }
    this.#inputStarted = true;
    this.#child.stdout.on("data", (chunk: Buffer) => onAudio(Buffer.from(chunk)));
    this.#child.stdout.resume();
  }

  async writeOutput(audio: Buffer): Promise<void> {
    if (this.#fatal || this.#stopped || !this.#child.stdin.writable) {
      throw new Error("MatrixRTC media output is unavailable");
    }
    if (audio.byteLength % 2) {
      throw new Error("MatrixRTC media output must contain complete PCM16 samples");
    }
    await this.#clearTail;
    const generation = this.#outputGeneration;
    for (let offset = 0; offset < audio.byteLength; offset += OUTPUT_PCM_FRAME_BYTES) {
      if (generation !== this.#outputGeneration || this.#fatal || this.#stopped) {
        return;
      }
      const payload = audio.subarray(
        offset,
        Math.min(offset + OUTPUT_PCM_FRAME_BYTES, audio.length),
      );
      const frame = encodeMatrixRtcOutputFrame(generation, payload);
      if (!this.#child.stdin.write(frame)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            this.#child.stdin.off("error", onError);
            resolve();
          };
          const onError = (error: Error) => {
            this.#child.stdin.off("drain", onDrain);
            reject(error);
          };
          this.#child.stdin.once("drain", onDrain);
          this.#child.stdin.once("error", onError);
        });
      }
    }
  }

  async clearOutput(): Promise<void> {
    if (this.#fatal || this.#stopped) {
      return;
    }
    this.#outputGeneration += 1;
    const generation = this.#outputGeneration;
    const clear = this.#clearTail.then(async () => {
      if (this.#fatal || this.#stopped) {
        return;
      }
      this.sendControl({ type: "clear_output", generation });
      const event = await this.waitForControlEvent("output_cleared");
      if (event.type !== "output_cleared" || event.generation !== generation) {
        throw new Error("MatrixRTC media bridge acknowledged the wrong output generation");
      }
    });
    this.#clearTail = clear;
    try {
      await clear;
    } catch (error) {
      this.#markFatal();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopping = true;
    this.#outputGeneration += 1;
    try {
      if (!this.#fatal && !this.#control.destroyed) {
        this.sendControl({ type: "stop" });
      }
      this.#child.stdin.end();
      if (!(await waitForExit(this.#child, STOP_TIMEOUT_MS))) {
        this.#child.kill("SIGTERM");
        if (!(await waitForExit(this.#child, STOP_TIMEOUT_MS))) {
          this.#child.kill("SIGKILL");
          await waitForExit(this.#child, 1_000);
        }
      }
    } finally {
      this.#stopped = true;
      this.#stopping = false;
    }
  }

  async dispose(): Promise<void> {
    this.#control.destroy();
    await rm(this.#tempDir, { recursive: true, force: true });
  }
}

export async function createMatrixRtcMediaTransport(params: {
  command: string;
  url: string;
  token: string;
  allowedRemoteIdentity: string;
  initialKeys: MatrixRtcMediaKey[];
}): Promise<NativeMatrixRtcAudioTransport> {
  await validateMediaBridgeCommand(params.command);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-matrix-rtc-"));
  await chmod(tempDir, 0o700);
  const socketPath = path.join(tempDir, `${randomUUID().slice(0, 12)}.sock`);
  const startup = new AbortController();
  const onChildError = () => startup.abort(new Error("MatrixRTC media bridge failed to start"));
  let child: ChildProcessWithoutNullStreams | undefined;
  let control: net.Socket | undefined;
  let transport: NativeMatrixRtcAudioTransport | undefined;
  try {
    child = spawn(params.command, ["--control-socket", socketPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // Spawn errors are asynchronous and can arrive before the socket exists.
    // Transfer error ownership only once the transport has installed its listener.
    child.on("error", onChildError);
    child.stdout.pause();
    control = await connectControlSocket(socketPath, child, startup.signal);
    startup.signal.throwIfAborted();
    transport = new NativeMatrixRtcAudioTransport({ child, control, tempDir });
    child.off("error", onChildError);
    await transport.waitForControlEvent("ready");
    transport.sendControl({
      type: "start",
      url: params.url,
      token: params.token,
      encrypted: true,
      allowed_remote_identities: [params.allowedRemoteIdentity],
      initial_keys: params.initialKeys.map(wireKey),
    });
    await transport.waitForControlEvent("connected");
    return transport;
  } catch (error) {
    try {
      if (transport) {
        await transport.stop();
      } else if (child?.pid !== undefined) {
        child.kill("SIGTERM");
        await waitForExit(child, 1_000);
      }
    } finally {
      if (transport) {
        await transport.dispose();
      } else {
        control?.destroy();
        await rm(tempDir, { recursive: true, force: true });
      }
    }
    throw error;
  }
}
