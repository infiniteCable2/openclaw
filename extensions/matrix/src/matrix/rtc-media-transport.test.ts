import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { NativeMatrixRtcAudioTransport } from "./rtc-media-transport.js";

function createTransportFixture(options: { backpressure?: boolean } = {}) {
  const stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: vi.fn((_chunk: Buffer) => !options.backpressure),
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

function acknowledgeGate(control: net.Socket, gate: "normal" | "duck" | "paused") {
  control.emit(
    "data",
    Buffer.from(`${JSON.stringify({ type: "output_gate_set", gate })}\n`, "utf8"),
  );
}

describe("MatrixRTC media output framing", () => {
  it.each([true, false])("preserves the boolean output capability %s", async (outputGate) => {
    const { control, transport } = createTransportFixture();
    const pending = transport.waitForControlEvent("ready");
    const event = { type: "ready", output_gate: outputGate };
    control.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
    await expect(pending).resolves.toEqual(event);
  });

  it.each(["true", 1, null, undefined])(
    "rejects a malformed output capability %s before admitting readiness",
    async (outputGate) => {
      const { control, transport } = createTransportFixture();
      const pending = transport.waitForControlEvent("ready");
      control.emit(
        "data",
        Buffer.from(`${JSON.stringify({ type: "ready", output_gate: outputGate })}\n`),
      );
      await expect(pending).rejects.toThrow("MatrixRTC native media bridge failed");
    },
  );

  it("declares its remote participant track as full-duplex input", () => {
    const { transport } = createTransportFixture();

    expect(transport.supportsFullDuplexInput).toBe(true);
  });

  it("waits for the allowed caller's audio-track readiness event", async () => {
    const { control, transport } = createTransportFixture();
    let ready = false;
    const pending = transport.waitForRemoteAudioReady().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    control.emit("data", Buffer.from('{"type":"remote_audio_ready"}\n'));
    await pending;
    expect(ready).toBe(true);
  });

  it("encodes one bounded generation-tagged PCM frame", async () => {
    const { stdin, transport } = createTransportFixture();
    const pcm = Buffer.from([1, 0, 2, 0]);
    await transport.writeOutput(pcm);
    expect(stdin.write).toHaveBeenCalledOnce();
    const frame = stdin.write.mock.calls[0]![0];

    expect(frame.subarray(0, 4).toString("ascii")).toBe("OCAP");
    expect(frame.readUInt8(4)).toBe(1);
    expect(frame.subarray(5, 8)).toEqual(Buffer.alloc(3));
    expect(frame.readBigUInt64BE(8)).toBe(0n);
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
    expect(stdin.write.mock.calls[0]?.[0].readBigUInt64BE(8)).toBe(0n);
    expect(stdin.write.mock.calls[1]?.[0].readBigUInt64BE(8)).toBe(1n);
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

  it("serializes reversible output-gate changes and checks bridge acknowledgements", async () => {
    const { control, controlWrite, transport } = createTransportFixture();
    const duck = transport.setOutputGate("duck");
    const pause = transport.setOutputGate("paused");
    await Promise.resolve();
    expect(controlWrite).toHaveBeenCalledWith(
      `${JSON.stringify({ type: "set_output_gate", gate: "duck" })}\n`,
    );
    expect(controlWrite).toHaveBeenCalledTimes(1);
    acknowledgeGate(control, "duck");
    await duck;
    await Promise.resolve();
    expect(controlWrite).toHaveBeenCalledTimes(2);
    acknowledgeGate(control, "paused");
    await pause;
    const resume = transport.setOutputGate("normal");
    await Promise.resolve();
    expect(controlWrite).toHaveBeenCalledTimes(3);
    acknowledgeGate(control, "normal");
    await resume;
  });
});
