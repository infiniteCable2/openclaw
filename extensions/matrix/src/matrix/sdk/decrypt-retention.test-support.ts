import type { EventEmitter } from "node:events";
import { DecryptionError } from "matrix-js-sdk/lib/common-crypto/CryptoBackend.js";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import { DecryptionFailureCode } from "matrix-js-sdk/lib/crypto-api/index.js";
import type { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { MatrixDecryptBridge } from "./decrypt-bridge.js";
import {
  type FakeMatrixEvent,
  makeMatrixEvent,
  type MatrixEventDecryptor,
} from "./event.test-support.js";

type DecryptRetentionContext = {
  createSdkClient: () => MatrixClient;
  getMatrixJsClient: () => Pick<EventEmitter, "emit"> & {
    decryptEventIfNeeded: MatrixEventDecryptor;
  };
};

export function registerDecryptRetentionTests(context: DecryptRetentionContext): void {
  it.each(["retry cap", "capacity", "expiry"] as const)(
    "retains failed-decryption notifications through %s",
    async (retirement) => {
      vi.useFakeTimers();
      const client = context.createSdkClient();
      const sdk = context.getMatrixJsClient();
      const failed = vi.fn<(_room: string, _event: unknown, error: Error) => void>();
      const notifications = () => failed.mock.calls.map((call) => call[2].message);
      client.on("room.failed_decryption", failed);
      sdk.decryptEventIfNeeded = vi.fn(async () => {
        throw new Error("still missing key");
      });
      const emitFailure = (event: FakeMatrixEvent) => {
        sdk.emit("event", event);
        event.emit("decrypted", event, new Error("missing room key"));
      };
      const expectAttempts = async (count: number) => {
        await vi.advanceTimersByTimeAsync(200_000);
        expect(sdk.decryptEventIfNeeded).toHaveBeenCalledTimes(count);
      };
      const makeFailed = (eventId: string) => makeMatrixEvent({ eventId, decryptionFailure: true });
      const oldest = makeFailed("$oldest");
      const events = [
        oldest,
        ...Array.from({ length: retirement === "capacity" ? 512 : 0 }, (_unused, index) =>
          makeFailed(`$retained-${index}`),
        ),
      ];
      await client.start();
      events.forEach(emitFailure);
      let retained = events.at(-1) ?? oldest;
      if (retirement === "retry cap") {
        expect(notifications()).toEqual(["missing room key"]);
      }
      await expectAttempts(events.length * 8);
      if (retirement === "retry cap") {
        oldest.emit("decrypted", oldest, new Error("missing room key again"));
        await expectAttempts(8);
        expect(notifications()).toEqual(["missing room key"]);
        return;
      }
      if (retirement === "expiry") {
        await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
        retained = makeFailed("$retained");
        emitFailure(retained);
        await expectAttempts(16);
      }
      const initialNotifications = retirement === "capacity" ? 513 : 2;
      expect(failed).toHaveBeenCalledTimes(initialNotifications);
      retained.emit("decrypted", retained, new Error("retained failure"));
      expect(failed).toHaveBeenCalledTimes(initialNotifications);
      oldest.emit("decrypted", oldest, new Error("retired failure"));
      expect(failed).toHaveBeenCalledTimes(initialNotifications + 1);
      expect(failed).toHaveBeenLastCalledWith(
        "!room:example.org",
        expect.objectContaining({ event_id: "$oldest" }),
        expect.objectContaining({ message: "retired failure" }),
      );
    },
  );
}

const ROOM = "!room:example.org";
const secretText = { msgtype: "m.text" as const, body: "secret" };

type ExplicitDecryptContext = {
  createSdkClient: () => MatrixClient;
  initializeCrypto: (client: MatrixClient) => Promise<void>;
  captureReadAuthorityMock: ReturnType<typeof vi.fn<() => (() => void) | undefined>>;
  getMatrixJsClient: () => {
    getCrypto: ReturnType<typeof vi.fn<() => unknown>>;
    decryptEventIfNeeded: ReturnType<typeof vi.fn<MatrixEventDecryptor>>;
    getEventMapper: ReturnType<typeof vi.fn>;
    fetchRoomEvent: ReturnType<typeof vi.fn>;
    relations: ReturnType<typeof vi.fn>;
  };
};
function makeDecryptFixture(cryptoApi: unknown = {}) {
  const emitMessage = vi.fn();
  const emitFailedDecryption = vi.fn();
  const bridge = new MatrixDecryptBridge({
    client: { getCrypto: () => cryptoApi, decryptEventIfNeeded: vi.fn(async () => {}) },
    toRaw: (event) => ({ event_id: event.getId() ?? "" }),
    emitDecryptedEvent: vi.fn(),
    emitMessage,
    emitFailedDecryption,
  });
  type Retry = {
    event: FakeMatrixEvent;
    roomId: string;
    eventId: string;
    attempts: number;
    inFlight: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  };
  const internals = bridge as unknown as {
    decryptRetries: Map<string, Retry>;
    exhaustedDecryptRetries: Map<string, Retry & { exhaustedAt: number }>;
  };
  function exhaust(event: FakeMatrixEvent) {
    internals.exhaustedDecryptRetries.set(`!room:example.org|${event.getId()}`, {
      event,
      roomId: ROOM,
      eventId: event.getId(),
      attempts: 8,
      inFlight: false,
      timer: null,
      exhaustedAt: Date.now(),
    });
  }
  const { decryptRetries } = internals;
  return { bridge, emitMessage, emitFailedDecryption, exhaust, decryptRetries };
}

export function registerCachedDecryptionReadTests(context: ExplicitDecryptContext): void {
  const { createSdkClient, initializeCrypto } = context;
  it.each(["hydrateEvents", "getEvent", "getRelations"] as const)(
    "retries a cached missing-key event through %s after its key becomes available",
    async (read) => {
      const matrixJsClient = context.getMatrixJsClient();
      const native = await vi.importActual<typeof import("matrix-js-sdk/lib/matrix.js")>(
        "matrix-js-sdk/lib/matrix.js",
      );
      const raw = {
        room_id: ROOM,
        event_id: "$late-key",
        sender: "@alice:example.org",
        type: "m.room.encrypted",
        origin_server_ts: 1,
        content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "synthetic" },
      };
      let keyAvailable = false;
      const crypto = {
        decryptEvent: vi.fn(async () => {
          if (!keyAvailable) {
            throw new DecryptionError(
              DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID,
              "Synthetic missing room key",
            );
          }
          return { clearEvent: { type: "m.room.message", content: secretText } };
        }),
      };
      const nativeClient = { getCrypto: () => crypto, cryptoBackend: crypto };
      const cached = new native.MatrixEvent(raw);
      await native.MatrixClient.prototype.decryptEventIfNeeded.call(nativeClient, cached);
      expect(cached.isDecryptionFailure()).toBe(true);
      expect(cached.shouldAttemptDecryption()).toBe(false);
      const retry = vi.spyOn(cached, "attemptDecryption");
      keyAvailable = true;
      matrixJsClient.getCrypto.mockReturnValue(crypto);
      matrixJsClient.decryptEventIfNeeded = vi.fn(async (event) => {
        // Keep the real SDK's cached-failure guard, with no real transport.
        expect(event).toBe(cached);
        await native.MatrixClient.prototype.decryptEventIfNeeded.call(nativeClient, cached);
      });
      const client = createSdkClient();
      await initializeCrypto(client);
      matrixJsClient.getEventMapper.mockReturnValue(() => cached);
      matrixJsClient.fetchRoomEvent.mockResolvedValue(raw);
      matrixJsClient.relations.mockResolvedValue({ events: [cached] });
      const event =
        read === "hydrateEvents"
          ? (await client.hydrateEvents(ROOM, [raw]))[0]
          : read === "getEvent"
            ? await client.getEvent(ROOM, raw.event_id)
            : (await client.getRelations(ROOM, raw.event_id, null)).events[0];
      expect(event?.content).toEqual(secretText);
      expect(retry).toHaveBeenCalledExactlyOnceWith(crypto, { isRetry: true });
      expect(crypto.decryptEvent).toHaveBeenCalledTimes(2);
    },
  );
}

export function registerExplicitDecryptRetryTests(context: ExplicitDecryptContext): void {
  const { createSdkClient, initializeCrypto, captureReadAuthorityMock } = context;
  it("bounds exhausted decrypt retry rehydration on crypto signals", async () => {
    const { bridge, exhaust } = makeDecryptFixture();
    const events = Array.from({ length: 513 }, (_, index) => {
      const event = makeMatrixEvent({ eventId: "$event-" + index, decryptionFailure: true });
      event.onAttemptDecryption(() => {});
      exhaust(event);
      return event;
    });
    bridge.retryPendingNow({ includeExhausted: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(events[0]?.attemptDecryption).not.toHaveBeenCalled();
    expect(events.at(-1)?.attemptDecryption).toHaveBeenCalledTimes(1);
  });

  it.each([
    DecryptionFailureCode.UNKNOWN_SENDER_DEVICE,
    DecryptionFailureCode.UNSIGNED_SENDER_DEVICE,
    DecryptionFailureCode.SENDER_IDENTITY_PREVIOUSLY_VERIFIED,
  ])("leaves explicit read retries for trust failure %s to the native SDK", (reason) => {
    const { bridge } = makeDecryptFixture();
    const event = makeMatrixEvent({ decryptionFailure: true, decryptionFailureReason: reason });
    expect(bridge.retryDecryptionIfNeeded(event as unknown as MatrixEvent)).toBeUndefined();
    expect(event.attemptDecryption).not.toHaveBeenCalled();
  });

  it.each(["redacted", "state", "decrypting", "stopped"] as const)(
    "preserves the native %s exclusion during explicit read retries",
    (state) => {
      const { bridge } = makeDecryptFixture();
      const event = makeMatrixEvent({
        decryptionFailure: true,
        ...(state === "redacted" ? { unsigned: { redacted_because: {} } } : {}),
        ...(state === "state" ? { stateKey: "" } : {}),
      });
      if (state === "decrypting") {
        event.setDecryptionPromise(Promise.resolve());
      }
      if (state === "stopped") {
        bridge.stop();
      }
      expect(bridge.retryDecryptionIfNeeded(event as unknown as MatrixEvent)).toBeUndefined();
      expect(event.attemptDecryption).not.toHaveBeenCalled();
    },
  );

  it("keeps explicit read retries inside the current caller authority", async () => {
    const matrixJsClient = context.getMatrixJsClient();
    const client = createSdkClient();
    await initializeCrypto(client);
    matrixJsClient.getCrypto.mockReturnValue({});
    const event = makeMatrixEvent({ decryptionFailure: true });
    matrixJsClient.getEventMapper.mockReturnValue(() => event);
    captureReadAuthorityMock.mockReturnValue(() => {
      throw new Error("synthetic read authority revoked");
    });
    await expect(client.hydrateEvents(ROOM, [{}])).rejects.toThrow(
      "synthetic read authority revoked",
    );
    expect(event.attemptDecryption).not.toHaveBeenCalled();
  });

  it("joins explicit read decryption before crypto shutdown completes", async () => {
    const { bridge } = makeDecryptFixture();
    const release = createDeferred<void>();
    const event = makeMatrixEvent({ decryptionFailure: true });
    event.onAttemptDecryption(() => release.promise);
    const retry = bridge.retryDecryptionIfNeeded(event as unknown as MatrixEvent);
    let drained = false;
    const drain = bridge.drainPendingDecryptions("synthetic shutdown").then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    await Promise.all([retry, drain]);
    expect(drained).toBe(true);
  });

  it("lets an in-flight retry finish during quiesce without rearming it", async () => {
    const { bridge, emitFailedDecryption, emitMessage, decryptRetries } = makeDecryptFixture();
    let release: (() => void) | undefined;
    const event = makeMatrixEvent({ decryptionFailure: true });
    event.onAttemptDecryption(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            event.emit("decrypted", event, new Error("still missing"));
            resolve();
          };
        }),
    );
    decryptRetries.set("!room:example.org|$event", {
      event,
      roomId: ROOM,
      eventId: "$event",
      attempts: 1,
      inFlight: false,
      timer: null,
    });
    const drain = bridge.drainPendingDecryptions("test shutdown");
    await Promise.resolve();
    release?.();
    await drain;
    expect(emitFailedDecryption).not.toHaveBeenCalled();
    expect(emitMessage).not.toHaveBeenCalled();
    expect(decryptRetries.size).toBe(0);
  });

  it("blocks new encrypted events and crypto retry resurrection after quiescing", async () => {
    const listeners = new Map<string, () => void>();
    const cryptoApi = {
      on: (event: string, listener: () => void) => listeners.set(event, listener),
    };
    const { bridge, emitMessage, exhaust } = makeDecryptFixture(cryptoApi);
    const exhausted = makeMatrixEvent({ eventId: "$exhausted", decryptionFailure: true });
    exhaust(exhausted);
    bridge.bindCryptoRetrySignals(cryptoApi);
    await bridge.drainPendingDecryptions("test shutdown");
    listeners.get(CryptoEvent.KeyBackupDecryptionKeyCached)?.();
    const late = makeMatrixEvent({ eventId: "$late" });
    bridge.attachEncryptedEvent(late as unknown as MatrixEvent, ROOM);
    late.emit("decrypted", late);
    await Promise.resolve();
    expect(exhausted.attemptDecryption).not.toHaveBeenCalled();
    expect(emitMessage).not.toHaveBeenCalled();
  });
}
