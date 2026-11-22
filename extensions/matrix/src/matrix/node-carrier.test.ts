import { setImmediate as nextTask } from "node:timers/promises";
import type { MatrixClient } from "matrix-js-sdk/lib/client.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../types.js";
import {
  createMatrixNodeCarrierAdmission,
  listMatrixPersonalNodeBindings,
} from "./node-carrier-admission.js";
import {
  MATRIX_NODE_CARRIER_EVENT,
  readMatrixNodeCarrierMessage,
  type MatrixNodeCarrierMessage,
} from "./node-carrier-wire.js";
import { registerMatrixNodeCarrier } from "./node-carrier.js";
import {
  createMatrixNodeCarrierFacade,
  readVerifiedMatrixNodeEvent,
  type MatrixNodeCarrierFacade,
  type MatrixNodePeer,
} from "./sdk/matrix-node-carrier.js";

const address = {
  version: 1,
  room_id: "!example:example.org",
  link_id: "bfa67601-2ceb-4427-bbd4-dafa636af340",
} as const;
const peer = { userId: "@peer:example.org", deviceId: "TEST_DEVICE", deviceKey: "key" };
const open = { ...address, kind: "open" } as const;

function envelope(content: Record<string, unknown>, senderVerified = true) {
  return {
    message: { type: MATRIX_NODE_CARRIER_EVENT, sender: peer.userId, content },
    encryptionInfo: {
      sender: peer.userId,
      senderDevice: peer.deviceId,
      senderCurve25519KeyBase64: peer.deviceKey,
      senderVerified,
    },
  };
}

describe("Matrix Node carrier", () => {
  const admit = vi.fn(async () => ({
    agentId: "example",
    assertCurrent: vi.fn(),
    assertInvokeSession: vi.fn(),
  }));
  const gateway = { receive: vi.fn(), close: vi.fn() };
  const send = vi.fn<MatrixNodeCarrierFacade["send"]>(async () => {});
  beforeEach(() => vi.clearAllMocks());

  function start(admitOpen: Parameters<typeof registerMatrixNodeCarrier>[0]["admit"] = admit) {
    const abort = new AbortController();
    let receive: ((peer: MatrixNodePeer, message: MatrixNodeCarrierMessage) => void) | undefined;
    const attachGateway = vi.fn<Parameters<typeof registerMatrixNodeCarrier>[0]["attachGateway"]>(
      async () => gateway,
    );
    const carrier = registerMatrixNodeCarrier({
      client: {
        subscribe(listener) {
          receive = listener;
          return () => {
            receive = undefined;
          };
        },
        send,
      },
      signal: abort.signal,
      admit: admitOpen,
      attachGateway,
    });
    return {
      ...carrier,
      abort,
      dispatch: (from: MatrixNodePeer, event: MatrixNodeCarrierMessage) => receive?.(from, event),
      attachGateway,
    };
  }

  it("requires an exact verified Olm device and bounds the JSON envelope", () => {
    expect(readVerifiedMatrixNodeEvent(envelope(open))).toEqual({ peer, message: open });
    expect(readVerifiedMatrixNodeEvent(envelope(open, false))).toBeUndefined();
    const missingDevice = envelope(open);
    expect(
      readVerifiedMatrixNodeEvent({
        ...missingDevice,
        encryptionInfo: { ...missingDevice.encryptionInfo, senderDevice: undefined },
      }),
    ).toBeUndefined();
    expect(
      readVerifiedMatrixNodeEvent(
        envelope({
          ...address,
          kind: "frame",
          seq: 0,
          frame: { body: "ä".repeat(6500) },
        }),
      ),
    ).toBeUndefined();
  });

  it("sends ciphertext only to the pinned key, including after a device key replacement", async () => {
    let key = "replacement";
    const sendToDevice = vi.fn(async () => ({}));
    const client = {
      getCrypto: () => ({
        getDeviceVerificationStatus: async () => ({ isVerified: () => true }),
        encryptToDeviceMessages: async () => ({
          eventType: "m.room.encrypted",
          batch: [{ ...peer, payload: { ciphertext: { [key]: { type: 0, body: "fixture" } } } }],
        }),
      }),
      sendToDevice,
    } as unknown as MatrixClient;
    const facade = createMatrixNodeCarrierFacade(client, {});
    await expect(facade.send(peer, open, () => {})).rejects.toThrow("peer key changed");
    expect(sendToDevice).not.toHaveBeenCalled();
    key = peer.deviceKey;
    await facade.send(peer, open, () => {});
    expect(sendToDevice).toHaveBeenCalledOnce();
  });

  it("binds the private Matrix device to its current Agent and native Node", async () => {
    const device: { deviceId: string; nodeId?: string; allowCrossChannelAccess?: boolean } = {
      deviceId: peer.deviceId,
    };
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          enabled: true,
          homeserver: "https://matrix.example.org",
          userId: "@gateway:example.org",
          rtc: {
            enabled: true,
            admissions: [
              {
                roomId: address.room_id,
                userId: peer.userId,
                agentId: "example",
                nodeDevices: [device],
              },
            ],
          },
        },
      },
    };
    const callLifetime = new AbortController();
    const call = {
      signal: callLifetime.signal,
      assertInvokeSession: () => {},
    };
    const bindNodeConnection = vi.fn((): typeof call | undefined => call);
    const admission = createMatrixNodeCarrierAdmission({
      currentConfig: () => cfg,
      accountId: "default",
      client: { isEncryptedDirectRoom: () => true },
      signal: new AbortController().signal,
      preparePrivateAudience: async () => ({ assertCurrent: () => {} }),
      bindNodeConnection,
    });
    expect(await admission({ ...peer, deviceId: "OTHER" }, address.room_id)).toBeUndefined();
    const bootstrap = await admission(peer, address.room_id);
    expect(bootstrap?.expectedNodeId).toBeUndefined();
    expect(bootstrap?.agentId).toBe("example");
    expect(listMatrixPersonalNodeBindings(cfg, "example", ["default"])).toEqual([]);
    device.nodeId = "a".repeat(64);
    expect(listMatrixPersonalNodeBindings(cfg, "example", ["default"])).toEqual([
      { accountId: "default", senderId: peer.userId, nodeId: device.nodeId },
    ]);
    expect(listMatrixPersonalNodeBindings(cfg, "unrelated", ["default"])).toEqual([]);
    expect(() => bootstrap?.assertCurrent()).toThrow("admission changed");
    expect((await admission(peer, address.room_id))?.expectedNodeId).toBe(device.nodeId);

    bindNodeConnection.mockReturnValue(undefined);
    expect(await admission(peer, address.room_id)).toBeUndefined();
    device.allowCrossChannelAccess = true;
    expect(await admission({ ...peer, deviceId: "OTHER" }, address.room_id)).toBeUndefined();
    const shared = await admission(peer, address.room_id);
    expect(shared?.crossChannelSenderId).toBe(peer.userId);
    expect(() => shared?.assertCurrent()).not.toThrow();
    expect(() => shared?.assertInvokeSession("unrelated-session")).toThrow(
      "requires the current Assistant Voice session",
    );
    bindNodeConnection.mockReturnValue(call);
    const callBoundShared = await admission(peer, address.room_id);
    expect(callBoundShared?.crossChannelSenderId).toBe(peer.userId);
    expect(callBoundShared?.signal).toBe(callLifetime.signal);
    callLifetime.abort();
    expect(() => callBoundShared?.assertCurrent()).toThrow();
    device.allowCrossChannelAccess = false;
    expect(() => shared?.assertCurrent()).toThrow("admission changed");
  });

  it("carries the original deadline exclusively on a native invoke frame", () => {
    const invoke = { type: "event", event: "node.invoke.request" };
    const wire = { ...address, kind: "frame", seq: 0, frame: invoke };
    expect(readMatrixNodeCarrierMessage(wire)).toBeUndefined();
    expect(
      readMatrixNodeCarrierMessage({ ...wire, expires_at_ms: 1_900_000_000_000 }),
    ).toMatchObject({
      frame: invoke,
      expires_at_ms: 1_900_000_000_000,
    });
    expect(
      readMatrixNodeCarrierMessage({ ...open, expires_at_ms: 1_900_000_000_000 }),
    ).toBeUndefined();
  });

  it("reconnects the same device after an Assistant Voice call ends without a Matrix close", async () => {
    let call = new AbortController();
    const carrier = start(async () => ({ ...(await admit()), signal: call.signal }));
    const next = { ...open, link_id: "ad6d9ac5-2b12-428c-8e5b-e06c6a48fdbc" };
    try {
      carrier.dispatch(peer, open);
      await nextTask();
      expect(carrier.attachGateway).toHaveBeenCalledTimes(1);
      carrier.dispatch(peer, next);
      expect(admit).toHaveBeenCalledTimes(1);

      call.abort();
      expect(gateway.close).toHaveBeenCalledOnce();
      call = new AbortController();
      carrier.dispatch(peer, next);
      await nextTask();
      expect(carrier.attachGateway).toHaveBeenCalledTimes(2);

      carrier.dispatch(peer, { ...open, kind: "close" });
      carrier.dispatch(peer, { ...next, kind: "frame", seq: 0, frame: { type: "req" } });
      expect(gateway.receive).toHaveBeenCalledExactlyOnceWith('{"type":"req"}');
      expect(gateway.close).toHaveBeenCalledOnce();
    } finally {
      carrier.abort.abort();
    }
  });

  it("holds the link to one verified device, discards replay and retires a sequence gap", async () => {
    const carrier = start();
    try {
      carrier.dispatch(peer, open);
      carrier.dispatch(peer, open);
      await vi.waitFor(() => expect(carrier.attachGateway).toHaveBeenCalledOnce());
      await Promise.resolve();
      const owner = carrier.attachGateway.mock.calls[0]![0];
      expect(owner).toMatchObject({ agentId: "example", roomId: address.room_id });
      const challengeTime = 1_900_000_000_000;
      await owner.sendFrame(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { ts: challengeTime },
        }),
      );
      expect(send).toHaveBeenCalledWith(
        peer,
        expect.objectContaining({ kind: "frame", seq: 0 }),
        expect.any(Function),
      );
      await owner.sendFrame(JSON.stringify({ type: "event", event: "node.invoke.request" }), {
        deadlineAtMs: performance.now() + 60_000,
        assertCurrent: vi.fn(),
      });
      const invoke = send.mock.calls[1]?.[1];
      expect(invoke).toMatchObject({ kind: "frame", seq: 1, expires_at_ms: expect.any(Number) });
      if (invoke?.kind === "frame") {
        expect(invoke.expires_at_ms).toBeGreaterThanOrEqual(challengeTime + 60_000);
        expect(invoke.expires_at_ms).toBeLessThan(challengeTime + 61_000);
      }
      const message = { ...address, kind: "frame", seq: 0, frame: { type: "req" } } as const;
      carrier.dispatch({ ...peer, deviceKey: "replacement" }, message);
      carrier.dispatch(peer, message);
      carrier.dispatch(peer, message);
      expect(gateway.receive).toHaveBeenCalledExactlyOnceWith('{"type":"req"}');
      carrier.dispatch(peer, { ...message, seq: 2 });
      expect(gateway.close).toHaveBeenCalledOnce();
      carrier.dispatch(peer, { ...message, seq: 1 });
      expect(gateway.receive).toHaveBeenCalledOnce();
    } finally {
      carrier.abort.abort();
    }
  });
});
