import { createHash } from "node:crypto";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  readMatrixNodeCarrierMessage,
  type MatrixNodeCarrierAddress,
  type MatrixNodeCarrierMessage,
} from "./node-carrier-wire.js";
import type { MatrixNodeCarrierFacade, MatrixNodePeer } from "./sdk/matrix-node-carrier.js";

const MAX_LINKS = 8;
const MAX_PENDING_SENDS = 8;
const OPEN_TIMEOUT_MS = 20_000;

type GatewayLink = {
  assertCurrent?(): void;
  receive(frame: string): void;
  close(): void;
};

type MatrixNodeAdmission = {
  agentId: string;
  expectedNodeId?: string;
  crossChannelSenderId?: string;
  signal?: AbortSignal;
  assertCurrent(): void;
  assertInvokeSession(sessionKey: string): void;
};

export type MatrixNodeCarrierAttach = (owner: {
  peerKey: string;
  agentId: string;
  expectedNodeId?: string;
  roomId: string;
  crossChannelSenderId?: string;
  signal: AbortSignal;
  assertCurrent(): void;
  assertInvokeSession(sessionKey: string): void;
  sendFrame(
    nativeJson: string,
    invoke?: { deadlineAtMs: number; assertCurrent(): void },
  ): Promise<void>;
  onClose(): void;
}) => GatewayLink | Promise<GatewayLink>;

type Link = {
  address: MatrixNodeCarrierAddress;
  peer: MatrixNodePeer;
  controller: AbortController;
  deadline: ReturnType<typeof setTimeout>;
  assertCurrent?: () => void;
  disposeLifetime?: () => void;
  gateway?: GatewayLink;
  clock?: { utcMs: number; monotonicMs: number };
  inbound: number;
  outbound: number;
  pendingSends: number;
  sendQueue: Promise<void>;
};

function samePeer(left: MatrixNodePeer, right: MatrixNodePeer): boolean {
  return (
    left.userId === right.userId &&
    left.deviceId === right.deviceId &&
    left.deviceKey === right.deviceKey
  );
}

/** The Matrix account owns the carrier lifetime; the native Gateway owns Node authority. */
export function registerMatrixNodeCarrier(params: {
  client: Pick<MatrixNodeCarrierFacade, "subscribe" | "send">;
  signal: AbortSignal;
  admit(peer: MatrixNodePeer, roomId: string): Promise<MatrixNodeAdmission | undefined>;
  attachGateway: MatrixNodeCarrierAttach;
}) {
  const links = new Map<string, Link>();
  const isCurrent = (link: Link) =>
    !params.signal.aborted && links.get(link.address.link_id) === link;

  function retire(link: Link, notify: boolean) {
    if (links.get(link.address.link_id) !== link) {
      return;
    }
    links.delete(link.address.link_id);
    link.disposeLifetime?.();
    link.controller.abort();
    clearTimeout(link.deadline);
    link.gateway?.close();
    const assertCurrent = link.assertCurrent;
    if (notify && assertCurrent && !params.signal.aborted) {
      void params.client
        .send(link.peer, { ...link.address, kind: "close" }, () => {
          params.signal.throwIfAborted();
          assertCurrent();
        })
        .catch(() => undefined);
    }
  }

  async function open(peer: MatrixNodePeer, address: MatrixNodeCarrierAddress) {
    if (params.signal.aborted || links.has(address.link_id)) {
      return;
    }
    for (const previous of links.values()) {
      if (
        previous.address.room_id !== address.room_id ||
        previous.peer.userId !== peer.userId ||
        previous.peer.deviceId !== peer.deviceId
      ) {
        continue;
      }
      try {
        previous.assertCurrent?.();
        previous.gateway?.assertCurrent?.();
        return;
      } catch {
        // Pinning or revoking an owner can invalidate the previously attached link.
        retire(previous, false);
      }
    }
    if (links.size >= MAX_LINKS) {
      return;
    }
    const link: Link = {
      address,
      peer,
      controller: new AbortController(),
      deadline: setTimeout(() => {
        if (!link.gateway) {
          retire(link, false);
        }
      }, OPEN_TIMEOUT_MS).unref(),
      inbound: 0,
      outbound: 0,
      pendingSends: 0,
      sendQueue: Promise.resolve(),
    };
    links.set(address.link_id, link);
    try {
      const admission = await params.admit(peer, address.room_id);
      if (!admission || !isCurrent(link)) {
        retire(link, false);
        return;
      }
      link.assertCurrent = () => admission.assertCurrent();
      const lifetime = admission.signal;
      lifetime?.throwIfAborted();
      if (lifetime) {
        const end = () => retire(link, false);
        lifetime.addEventListener("abort", end, { once: true });
        link.disposeLifetime = () => lifetime.removeEventListener("abort", end);
      }
      const assertCurrent = () => {
        if (!isCurrent(link)) {
          throw new Error("Matrix node transport link is closed");
        }
        admission.assertCurrent();
      };
      assertCurrent();
      const gateway = await params.attachGateway({
        peerKey: createHash("sha256")
          .update(JSON.stringify([address.room_id, peer.userId, peer.deviceId, peer.deviceKey]))
          .digest("hex"),
        agentId: admission.agentId,
        expectedNodeId: admission.expectedNodeId,
        roomId: address.room_id,
        crossChannelSenderId: admission.crossChannelSenderId,
        signal: link.controller.signal,
        assertCurrent,
        assertInvokeSession(sessionKey) {
          assertCurrent();
          admission.assertInvokeSession(sessionKey);
        },
        sendFrame(nativeJson, invoke) {
          const deadlineAtMs = invoke?.deadlineAtMs;
          const frame = asOptionalObjectRecord(JSON.parse(nativeJson));
          if (frame?.type === "event" && frame.event === "connect.challenge") {
            const payload = frame.payload;
            const clock = payload && typeof payload === "object" && "ts" in payload && payload.ts;
            if (!link.clock && typeof clock === "number" && Number.isSafeInteger(clock)) {
              link.clock = { utcMs: clock, monotonicMs: performance.now() };
            }
          }
          const expiresAtMs =
            deadlineAtMs !== undefined && link.clock
              ? Math.floor(link.clock.utcMs + deadlineAtMs - link.clock.monotonicMs)
              : undefined;
          const message = readMatrixNodeCarrierMessage({
            ...address,
            kind: "frame",
            seq: link.outbound,
            frame,
            ...(expiresAtMs === undefined ? {} : { expires_at_ms: expiresAtMs }),
          });
          if (!isCurrent(link) || !message || link.pendingSends >= MAX_PENDING_SENDS) {
            retire(link, false);
            return Promise.reject(new Error("Matrix node transport send refused"));
          }
          link.outbound++;
          link.pendingSends++;
          const assertDispatchCurrent = () => {
            assertCurrent();
            invoke?.assertCurrent();
            if (deadlineAtMs !== undefined && performance.now() >= deadlineAtMs) {
              throw new Error("Matrix node invocation expired before delivery");
            }
          };
          const send = link.sendQueue.then(() => {
            assertDispatchCurrent();
            return params.client.send(peer, message, assertDispatchCurrent);
          });
          link.sendQueue = send.catch(() => retire(link, false));
          return send.finally(() => link.pendingSends--);
        },
        onClose: () => retire(link, true),
      });
      if (!isCurrent(link)) {
        gateway.close();
        return;
      }
      link.gateway = gateway;
      clearTimeout(link.deadline);
    } catch {
      retire(link, false);
    }
  }

  function receive(peer: MatrixNodePeer, message: MatrixNodeCarrierMessage) {
    if (message.kind === "open") {
      const { version, room_id, link_id } = message;
      void open(peer, { version, room_id, link_id });
      return;
    }
    const link = links.get(message.link_id);
    if (
      !link ||
      !isCurrent(link) ||
      link.address.room_id !== message.room_id ||
      !samePeer(link.peer, peer)
    ) {
      return;
    }
    if (message.kind === "close") {
      retire(link, false);
      return;
    }
    if (message.seq < link.inbound) {
      return;
    }
    if (!link.gateway || message.seq !== link.inbound || message.expires_at_ms !== undefined) {
      retire(link, true);
      return;
    }
    try {
      link.assertCurrent?.();
      link.inbound++;
      link.gateway.receive(JSON.stringify(message.frame));
    } catch {
      retire(link, false);
    }
  }

  const unsubscribe = params.client.subscribe(receive);
  function stop() {
    unsubscribe();
    params.signal.removeEventListener("abort", stop);
    for (const link of links.values()) {
      retire(link, false);
    }
  }
  params.signal.addEventListener("abort", stop, { once: true });
  if (params.signal.aborted) {
    stop();
  }
  return {
    stop,
    invalidateRoom(roomId?: string) {
      for (const link of links.values()) {
        if (roomId === undefined || link.address.room_id === roomId) {
          retire(link, false);
        }
      }
    },
  };
}
