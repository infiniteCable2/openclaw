import { EventEmitter } from "node:events";
import { RTCEncryptionManager } from "matrix-js-sdk/lib/matrixrtc/RTCEncryptionManager.js";
import { describe, expect, it, vi } from "vitest";

describe("MatrixRTC initial key distribution", () => {
  it("distributes a key when joining an already-active session", async () => {
    const emitter = new EventEmitter();
    const sendKey = vi.fn(async () => undefined);
    const transport = {
      on: emitter.on.bind(emitter),
      off: emitter.off.bind(emitter),
      start: vi.fn(),
      stop: vi.fn(),
      sendKey,
    };
    const remoteMembership = {
      sender: "@owner:example.test",
      userId: "@owner:example.test",
      deviceId: "OWNERDEVICE",
      memberId: "@owner:example.test:OWNERDEVICE",
      createdTs: () => 1,
    };
    const onEncryptionKeysChanged = vi.fn();
    const manager = new RTCEncryptionManager(
      {
        userId: "@nova:example.test",
        deviceId: "NOVADEVICE",
        memberId: "@nova:example.test:NOVADEVICE",
      },
      () => [remoteMembership as never],
      transport as never,
      onEncryptionKeysChanged,
    );

    manager.join({ manageMediaKeys: true, unstableSendStickyEvents: false });

    await vi.waitFor(() => expect(sendKey).toHaveBeenCalledOnce());
    expect(sendKey).toHaveBeenCalledWith(expect.any(String), 0, [
      expect.objectContaining({
        userId: remoteMembership.userId,
        deviceId: remoteMembership.deviceId,
      }),
    ]);
    expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      0,
      expect.objectContaining({ userId: "@nova:example.test", deviceId: "NOVADEVICE" }),
      "@nova:example.test:NOVADEVICE",
    );

    manager.leave();
  });
});
