import { EventEmitter } from "node:events";
import { EventType } from "matrix-js-sdk/lib/@types/event.js";
import { ClientEvent } from "matrix-js-sdk/lib/client.js";
import { describe, expect, it, vi } from "vitest";
import { createMatrixRtcClientFacade } from "./matrix-rtc.js";

function createHarness() {
  const emitter = new EventEmitter();
  const facade = createMatrixRtcClientFacade({
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  } as never);
  return { emitter, facade };
}

function incomingKeyPayload(params: {
  encrypted: boolean;
  senderDevice?: string;
  keyBytes?: number;
}) {
  return {
    message: {
      type: EventType.CallEncryptionKeysPrefix,
      sender: "@owner:example.test",
      content: {
        room_id: "!room:example.test",
        keys: { index: 7, key: Buffer.alloc(params.keyBytes ?? 16, 3).toString("base64") },
        member: { claimed_device_id: "OWNERDEVICE", id: "owner-member" },
        sent_ts: 123,
      },
    },
    encryptionInfo: params.encrypted
      ? {
          sender: "@owner:example.test",
          senderDevice: params.senderDevice ?? "OWNERDEVICE",
          senderCurve25519KeyBase64: "curve-key",
          senderVerified: false,
        }
      : null,
  };
}

describe("MatrixRTC incoming key facade", () => {
  it.each([16, 32])("emits a validated encrypted %i-byte media key unchanged", (keyBytes) => {
    const harness = createHarness();
    const listener = vi.fn();
    const dispose = harness.facade.onIncomingMediaKey(listener);

    harness.emitter.emit(
      ClientEvent.ReceivedToDeviceMessage,
      incomingKeyPayload({ encrypted: true, keyBytes }),
    );

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "!room:example.test",
        userId: "@owner:example.test",
        deviceId: "OWNERDEVICE",
        memberId: "owner-member",
        index: 7,
        key: Uint8Array.from({ length: keyBytes }, () => 3),
        sentAt: 123,
      }),
    );
    dispose();
    expect(harness.emitter.listenerCount(ClientEvent.ReceivedToDeviceMessage)).toBe(0);
  });

  it.each([16, 32])("rejects clear or device-mismatched %i-byte media keys", (keyBytes) => {
    const harness = createHarness();
    const listener = vi.fn();
    harness.facade.onIncomingMediaKey(listener);

    harness.emitter.emit(
      ClientEvent.ReceivedToDeviceMessage,
      incomingKeyPayload({ encrypted: false, keyBytes }),
    );
    harness.emitter.emit(
      ClientEvent.ReceivedToDeviceMessage,
      incomingKeyPayload({ encrypted: true, senderDevice: "OTHERDEVICE", keyBytes }),
    );

    expect(listener).not.toHaveBeenCalled();
  });

  it.each([0, 15, 17, 24, 31, 33])("rejects an unsupported %i-byte media key", (keyBytes) => {
    const harness = createHarness();
    const listener = vi.fn();
    harness.facade.onIncomingMediaKey(listener);
    harness.emitter.emit(
      ClientEvent.ReceivedToDeviceMessage,
      incomingKeyPayload({ encrypted: true, keyBytes }),
    );
    expect(listener).not.toHaveBeenCalled();
  });
});
