import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type net from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  encodeMatrixRtcOutputFrame,
  NativeMatrixRtcAudioTransport,
} from "./rtc-media-transport.js";

function createTransportFixture(options: { backpressure?: boolean } = {}) {
  const stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: vi.fn(() => !options.backpressure),
    end: vi.fn(),
  });
  const stdout = Object.assign(new EventEmitter(), {
    pause: vi.fn(),
    resume: vi.fn(),
  });
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  }) as unknown as ChildProcessWithoutNullStreams;
  const controlWrite = vi.fn();
  const control = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: controlWrite,
    destroy: vi.fn(),
  }) as unknown as net.Socket;
  const transport = new NativeMatrixRtcAudioTransport({
    child,
    control,
    tempDir: "/tmp/openclaw-matrix-rtc-test",
  });
  return { child, control, controlWrite, stdin, transport };
}

function acknowledgeClear(control: net.Socket, generation: number) {
  control.emit(
    "data",
    Buffer.from(`${JSON.stringify({ type: "output_cleared", generation })}\n`, "utf8"),
  );
}

describe("MatrixRTC media output framing", () => {
  it("declares its remote participant track as full-duplex input", () => {
    const { transport } = createTransportFixture();

    expect(transport.supportsFullDuplexInput).toBe(true);
  });

  it("encodes one bounded generation-tagged PCM frame", () => {
    const pcm = Buffer.from([1, 0, 2, 0]);
    const frame = encodeMatrixRtcOutputFrame(42, pcm);

    expect(frame.subarray(0, 4).toString("ascii")).toBe("OCAP");
    expect(frame.readUInt8(4)).toBe(1);
    expect(frame.subarray(5, 8)).toEqual(Buffer.alloc(3));
    expect(frame.readBigUInt64BE(8)).toBe(42n);
    expect(frame.readUInt32BE(16)).toBe(pcm.byteLength);
    expect(frame.subarray(20)).toEqual(pcm);
  });

  it("advances and acknowledges the generation before sending later audio", async () => {
    const { control, controlWrite, stdin, transport } = createTransportFixture();
    await transport.writeOutput(Buffer.alloc(480, 1));
    const clearing = transport.clearOutput();
    await vi.waitFor(() => {
      expect(controlWrite).toHaveBeenCalledWith(
        `${JSON.stringify({ type: "clear_output", generation: 1 })}\n`,
      );
    });
    acknowledgeClear(control, 1);
    await clearing;
    await transport.writeOutput(Buffer.alloc(480, 2));

    expect(stdin.write).toHaveBeenCalledTimes(2);
    expect((stdin.write.mock.calls[0]![0] as Buffer).readBigUInt64BE(8)).toBe(0n);
    expect((stdin.write.mock.calls[1]![0] as Buffer).readBigUInt64BE(8)).toBe(1n);
  });

  it("fences a backpressured write as soon as output is cleared", async () => {
    const { control, controlWrite, stdin, transport } = createTransportFixture({
      backpressure: true,
    });
    const writing = transport.writeOutput(Buffer.alloc(960, 1));
    await vi.waitFor(() => {
      expect(stdin.write).toHaveBeenCalledOnce();
    });

    const clearing = transport.clearOutput();
    await vi.waitFor(() => {
      expect(controlWrite).toHaveBeenCalledOnce();
    });
    acknowledgeClear(control, 1);
    stdin.emit("drain");
    await Promise.all([writing, clearing]);

    expect(stdin.write).toHaveBeenCalledOnce();
  });
});
