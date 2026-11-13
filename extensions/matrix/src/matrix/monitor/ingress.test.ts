import { DecryptionFailureCode } from "matrix-js-sdk/lib/crypto-api/index.js";
import { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { ChannelIngressMonitorLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import { matrixSyncResponse, useSyncStoreFixture } from "../client/sync-store.test-support.js";
import { MatrixClient, type MatrixRawEvent } from "../sdk.js";
import { createMatrixCryptoFacade } from "../sdk/crypto-facade.js";
import { matrixEventToRaw } from "../sdk/event-helpers.js";
import { MatrixRecoveryKeyStore } from "../sdk/recovery-key-store.js";
import { MatrixVerificationManager } from "../sdk/verification-manager.js";
import { createMatrixIngressMonitor } from "./ingress.js";

type IngressPayload = { version: 1; roomId: string; event: MatrixRawEvent };
const roomId = "!room:example.org";
const createClient = () => new MatrixClient("https://example.org", "synthetic-token");
const encryptedEvent = (event_id: string, origin_server_ts: number) =>
  ({
    event_id,
    origin_server_ts,
    sender: "@alice:example.org",
    type: "m.room.encrypted",
    content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "encrypted-fixture" },
  }) satisfies MatrixRawEvent;

describe("Matrix sync admission", () => {
  const storage = useSyncStoreFixture("openclaw-matrix-ingress-");
  const createQueue = (now?: () => number) =>
    createChannelIngressQueueForTests<IngressPayload>({
      channelId: "matrix",
      accountId: "default",
      stateDir: storage.root,
      ...(now ? { now } : {}),
    });

  it("preserves raw replay and left-room events", async () => {
    const queue = createQueue();
    const event = encryptedEvent("$ciphertext", 1_000);
    const sync = matrixSyncResponse("cursor", roomId, event, "previous");
    const monitor = createMatrixIngressMonitor({
      accountId: "default",
      client: createClient(),
      startupMs: 2_000,
      queue,
      dispatch: async () => {
        throw new Error("Admission must not dispatch before the monitor starts");
      },
    });
    try {
      sync.rooms.leave = {
        "!left:example.org": {
          state: { events: [] },
          timeline: {
            events: [{ ...event, event_id: "$left", type: "m.room.message" }],
            prev_batch: "left-previous",
          },
          account_data: { events: [] },
        },
      };
      await monitor.admitSync(sync, { hasSavedSync: true });
      await monitor.admitSync(sync, { hasSavedSync: true });
      expect(await queue.listPending()).toMatchObject([
        {
          id: "$ciphertext",
          laneKey: `room:${roomId}`,
          payload: { version: 1, roomId, event: { ...event, room_id: roomId } },
        },
        {
          id: "$left",
          laneKey: "room:!left:example.org",
          payload: { event: { event_id: "$left" } },
        },
      ]);
    } finally {
      await monitor.stop();
    }
  });

  it.each([
    DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID,
    DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX,
  ])(
    "retains %s without blocking later readable events and adopts the recovery once",
    async (reason) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const queue = createQueue();
      const event = encryptedEvent("$retry-decryption", now);
      const client = createClient();
      client.crypto = createMatrixCryptoFacade({
        client: { getCrypto: () => undefined, getUserId: () => null },
        verificationManager: new MatrixVerificationManager(),
        recoveryKeyStore: new MatrixRecoveryKeyStore(),
        downloadContent: async () => Buffer.alloc(0),
      });
      const failed = new MatrixEvent({
        ...event,
        type: "m.room.message",
        content: { msgtype: "m.bad.encrypted", body: "Synthetic missing room key" },
      });
      vi.spyOn(failed, "isDecryptionFailure").mockReturnValue(true);
      vi.spyOn(failed, "decryptionFailureReason", "get").mockReturnValue(reason);
      const later = ["$later-first", "$later-second"].map((id) => encryptedEvent(id, now + 1));
      const clearLater = later.map((raw) =>
        matrixEventToRaw(
          new MatrixEvent({
            ...raw,
            type: "m.room.message",
            content: { msgtype: "m.text", body: "Readable after the new device is ready" },
          }),
        ),
      );
      const hydrate = vi
        .spyOn(client, "hydrateEvents")
        .mockImplementation(async (_room, events) =>
          events.map((raw) =>
            raw.event_id === event.event_id
              ? matrixEventToRaw(failed)
              : clearLater.find((clear) => clear.event_id === raw.event_id)!,
          ),
        );
      const dispatch = vi.fn(
        async (
          _room: string,
          _event: MatrixRawEvent,
          lifecycle: ChannelIngressMonitorLifecycle,
        ) => {
          await lifecycle.onAdopted();
        },
      );
      const params = { accountId: "default", client, startupMs: now, queue, dispatch };
      const first = createMatrixIngressMonitor(params);
      try {
        const sync = matrixSyncResponse("cursor", roomId, event, "previous");
        sync.rooms.join[roomId]!.timeline!.events.push(...later);
        await first.admitSync(sync, {
          hasSavedSync: true,
        });
        first.start();
        await first.waitForIdle();
        expect(dispatch.mock.calls.map(([, raw]) => raw.event_id)).toEqual(
          later.map((raw) => raw.event_id),
        );
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending()).toMatchObject([
          {
            id: event.event_id,
            payload: { event },
            attempts: 1,
            lastError: expect.stringContaining(reason),
          },
        ]);
      } finally {
        await first.stop();
      }

      const clear = matrixEventToRaw(
        new MatrixEvent({
          ...event,
          type: "m.room.message",
          content: { msgtype: "m.text", body: "Decrypted fixture" },
        }),
      );
      hydrate.mockResolvedValue([clear]);
      clock.mockReturnValue(now + 2_000);
      const retry = createMatrixIngressMonitor(params);
      try {
        retry.start();
        await retry.waitForIdle();
        await retry.admitSync(matrixSyncResponse("replay", roomId, event, "previous"), {
          hasSavedSync: true,
        });
        await retry.waitForIdle();
        expect(dispatch.mock.calls.map(([, raw]) => raw.event_id)).toEqual([
          ...later.map((raw) => raw.event_id),
          event.event_id,
        ]);
        expect(dispatch).toHaveBeenLastCalledWith(roomId, clear, expect.any(Object));
        expect(hydrate).toHaveBeenCalledTimes(4);
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        await retry.stop();
      }
    },
  );

  it("keeps ordinary delivery failures ordered within their room", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const queue = createQueue();
    const head = {
      event_id: "$dispatch-head",
      type: "m.room.message",
      origin_server_ts: now,
      sender: "@alice:example.org",
      content: { msgtype: "m.text", body: "First" },
    };
    const sync = matrixSyncResponse("ordinary-failure", roomId, head, "previous");
    sync.rooms.join[roomId]!.timeline!.events.push({ ...head, event_id: "$dispatch-tail" });
    const dispatch = vi.fn(async () => {
      throw new Error("Synthetic delivery failure");
    });
    const monitor = createMatrixIngressMonitor({
      accountId: "default",
      client: createClient(),
      startupMs: now,
      queue,
      dispatch,
    });
    try {
      await monitor.admitSync(sync, { hasSavedSync: true });
      monitor.start();
      await monitor.waitForIdle();
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(await queue.listPending()).toMatchObject([
        { id: "$dispatch-head", attempts: 1, lastError: "Synthetic delivery failure" },
        { id: "$dispatch-tail", attempts: 0 },
      ]);
      expect(await queue.listClaims()).toEqual([]);
    } finally {
      await monitor.stop();
    }
  });

  it("readmits recovered ciphertext behind an active room delivery", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const queue = createQueue();
    const event = encryptedEvent("$late-key", now);
    const client = createClient();
    client.crypto = createMatrixCryptoFacade({
      client: { getCrypto: () => undefined, getUserId: () => null },
      verificationManager: new MatrixVerificationManager(),
      recoveryKeyStore: new MatrixRecoveryKeyStore(),
      downloadContent: async () => Buffer.alloc(0),
    });
    let readable = false;
    const hydrate = vi.spyOn(client, "hydrateEvents").mockImplementation(async (_room, events) =>
      events.map((raw) => {
        if (raw.event_id !== event.event_id) {
          return raw as MatrixRawEvent;
        }
        if (!readable) {
          return event;
        }
        return {
          ...event,
          type: "m.room.message",
          content: { msgtype: "m.text", body: "Recovered" },
        };
      }),
    );
    const initial = createMatrixIngressMonitor({
      accountId: "default",
      client,
      startupMs: now,
      queue,
      dispatch: async () => {
        throw new Error("No clear event exists yet");
      },
    });
    await initial.admitSync(matrixSyncResponse("initial", roomId, event, "previous"), {
      hasSavedSync: true,
    });
    initial.start();
    await initial.waitForIdle();
    await initial.stop();

    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delivered: string[] = [];
    const monitor = createMatrixIngressMonitor({
      accountId: "default",
      client,
      startupMs: now,
      queue,
      dispatch: async (_room, raw, lifecycle) => {
        delivered.push(raw.event_id!);
        if (raw.event_id === "$active") {
          started.resolve();
          await release.promise;
        }
        await lifecycle.onAdopted();
      },
    });
    const plain = (id: string) => ({
      ...event,
      event_id: id,
      type: "m.room.message",
      content: { msgtype: "m.text", body: id },
    });
    try {
      await monitor.admitSync(matrixSyncResponse("active", roomId, plain("$active"), "previous"), {
        hasSavedSync: true,
      });
      monitor.start();
      await started.promise;
      readable = true;
      clock.mockReturnValue(now + 2_000);
      await monitor.admitSync(matrixSyncResponse("tail", roomId, plain("$tail"), "previous"), {
        hasSavedSync: true,
      });
      await vi.waitFor(async () => {
        expect(await queue.listPending()).toMatchObject([
          { id: "$late-key", payload: { event } },
          { id: "$tail" },
        ]);
        expect(await queue.listClaims()).toMatchObject([{ id: "$active" }]);
        expect(hydrate).toHaveBeenCalledTimes(3);
      });
      expect(delivered).toEqual(["$active"]);
      release.resolve();
      await monitor.waitForIdle();
      expect(delivered).toEqual(["$active", "$late-key", "$tail"]);
      expect(await queue.listPending()).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
    } finally {
      release.resolve();
      await monitor.stop();
    }
  });

  it("does not deliver a late SDK result after the monitor stops", async () => {
    const now = Date.now();
    const queue = createQueue();
    const client = createClient();
    const started = Promise.withResolvers<void>();
    const hydrated = Promise.withResolvers<MatrixRawEvent[]>();
    const event = {
      ...encryptedEvent("$stopped-read", now),
      type: "m.room.message",
      content: { msgtype: "m.text", body: "Synthetic late SDK result" },
    };
    vi.spyOn(client, "hydrateEvents").mockImplementation(async () => {
      started.resolve();
      return await hydrated.promise;
    });
    const dispatch = vi.fn();
    const monitor = createMatrixIngressMonitor({
      accountId: "default",
      client,
      startupMs: now,
      queue,
      dispatch,
    });
    try {
      await monitor.admitSync(matrixSyncResponse("stop", roomId, event, "previous"), {
        hasSavedSync: true,
      });
      monitor.start();
      await started.promise;
      await monitor.stop();
      hydrated.resolve([event]);
      await monitor.waitForIdle();
      expect(dispatch).not.toHaveBeenCalled();
      const pending = await queue.listPending();
      const claims = await queue.listClaims();
      expect([...pending, ...claims]).toMatchObject([{ id: "$stopped-read", payload: { event } }]);
    } finally {
      hydrated.resolve([event]);
      await monitor.stop();
    }
  });

  it.each(["pending", "claimed"] as const)(
    "preserves timeline order across batches and restart with a %s tail",
    async (headState) => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const queue = createQueue(() => now);
      const event = {
        event_id: "$z-first",
        origin_server_ts: now,
        sender: "@alice:example.org",
        type: "m.room.message",
        content: { msgtype: "m.text", body: "First" },
      };
      const sync = matrixSyncResponse("first-batch", roomId, event, "previous");
      sync.rooms.join[roomId]!.timeline!.events.push({ ...event, event_id: "$a-second" });
      const delivered: string[] = [];
      const params = {
        accountId: "default",
        client: createClient(),
        startupMs: 0,
        queue,
        dispatch: async (
          _room: string,
          raw: MatrixRawEvent,
          lifecycle: ChannelIngressMonitorLifecycle,
        ) => {
          delivered.push(raw.event_id!);
          await lifecycle.onAdopted();
        },
      };
      const first = createMatrixIngressMonitor(params);
      await first.admitSync(sync, { hasSavedSync: true });
      await first.stop();
      if (headState === "claimed") {
        await queue.claim("$a-second", { ownerId: "2147483647:0:dead-worker" });
      }

      const restarted = createMatrixIngressMonitor(params);
      try {
        await restarted.admitSync(
          matrixSyncResponse("second-batch", roomId, { ...event, event_id: "$0-third" }, "next"),
          { hasSavedSync: true },
        );
        restarted.start();
        await restarted.waitForIdle();
        expect(delivered).toEqual(["$z-first", "$a-second", "$0-third"]);
      } finally {
        await restarted.stop();
      }
    },
  );
});
