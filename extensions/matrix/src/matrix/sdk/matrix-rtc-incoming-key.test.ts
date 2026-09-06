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

function incomingKeyPayload(params: { encrypted: boolean; senderDevice?: string }) {
  return {
    message: {
      type: EventType.CallEncryptionKeysPrefix,
      sender: "@owner:example.test",
      content: {
        room_id: "!room:example.test",
        keys: { index: 7, key: Buffer.alloc(16, 3).toString("base64") },
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
  it("emits a validated encrypted media key", () => {
    const harness = createHarness();
    const listener = vi.fn();
    const dispose = harness.facade.onIncomingMediaKey(listener);

    harness.emitter.emit(
      ClientEvent.ReceivedToDeviceMessage,
      incomingKeyPayload({ encrypted: true }),
    );

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "!room:example.test",
        userId: "@owner:example.test",
        deviceId: "OWNERDEVICE",
        memberId: "owner-member",
        index: 7,
        key: Uint8Array.from({ length: 16 }, () => 3),
        sentAt: 123,
      }),
    );
    dispose();
    expect(harness.emitter.listenerCount(ClientEvent.ReceivedToDeviceMessage)).toBe(0);
  });

  it("rejects clear or device-mismatched media keys", () => {
    const harness = createHarness();
    const listener = vi.fn();
    harness.facade.onIncomingMediaKey(listener);

    harness.emitter.emit(
      ClientEvent.ReceivedToDeviceMessage,
      incomingKeyPayload({ encrypted: false }),
    );
    harness.emitter.emit(
      ClientEvent.ReceivedToDeviceMessage,
      incomingKeyPayload({ encrypted: true, senderDevice: "OTHERDEVICE" }),
    );

    expect(listener).not.toHaveBeenCalled();
  });
});
