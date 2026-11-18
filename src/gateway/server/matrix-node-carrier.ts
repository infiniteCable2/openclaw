import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { buildRateLimitIdentityKey } from "../auth-rate-limit.js";
import type { SerializedGatewayFrame } from "../serialized-json.js";
import type { GatewayConnectionTransport } from "./connection-transport.js";
import { attachGatewayConnection, type GatewayConnectionOptions } from "./connection.js";
import {
  isMatrixNodeCarrierCommand,
  MATRIX_NODE_CARRIER_MAX_BYTES,
} from "./matrix-node-carrier-policy.js";

/** Host-only handoff for a live, verified Matrix owner and its already authenticated peer. */
export type MatrixNodeCarrierOwner = {
  peerKey: string;
  signal: AbortSignal;
  assertCurrent(): void;
  sendFrame(nativeJson: string, invoke?: { deadlineAtMs: number }): void | Promise<void>;
  onClose(): void;
};

export function attachMatrixNodeCarrier(
  options: GatewayConnectionOptions,
  owner: MatrixNodeCarrierOwner,
) {
  const current = () => {
    if (owner.signal.aborted) throw Error("Matrix node carrier revoked");
    owner.assertCurrent();
  };
  current();
  class Transport extends EventEmitter implements GatewayConnectionTransport {
    readyState = 1;
    bufferedAmount = 0;

    send(
      frame: string | Buffer | SerializedGatewayFrame,
      options?: { binary: false } | ((error?: Error) => void),
      callback?: (error?: Error) => void,
    ) {
      return this.write(frame, typeof options === "function" ? options : callback);
    }

    sendNodeInvoke(frame: Buffer, dispatchDeadlineAtMs: number) {
      // The adapter owns translation from this process-monotonic deadline to
      // its Matrix envelope, including the original challenge time anchor.
      return this.write(frame, undefined, { deadlineAtMs: dispatchDeadlineAtMs });
    }

    private write(
      frame: string | Buffer | SerializedGatewayFrame,
      settled?: (error?: Error) => void,
      invoke?: { deadlineAtMs: number },
    ) {
      const json = frame.toString();
      const bytes = Buffer.byteLength(json);
      current();
      if (this.readyState !== 1) throw Error("Matrix node carrier closed");
      const message = asOptionalObjectRecord(JSON.parse(json));
      const isInvoke = message?.type === "event" && message.event === "node.invoke.request";
      if (isInvoke !== Boolean(invoke))
        throw Error("Matrix node invoke requires dispatch deadline");
      if (message?.type === "event" && message.event !== "connect.challenge") {
        if (message.event !== "node.invoke.request") {
          settled?.();
          return;
        }
        if (!isMatrixNodeCarrierCommand(asOptionalObjectRecord(message.payload)?.command))
          throw Error("Matrix node command not allowed");
      }
      if (
        bytes > MATRIX_NODE_CARRIER_MAX_BYTES ||
        this.bufferedAmount + bytes > MATRIX_NODE_CARRIER_MAX_BYTES
      ) {
        this.close(1009, "Matrix node carrier frame limit");
        throw Error("Matrix node carrier frame limit");
      }
      if (
        invoke &&
        (!Number.isFinite(invoke.deadlineAtMs) || invoke.deadlineAtMs <= performance.now())
      )
        throw Error("Matrix node invoke deadline elapsed");
      this.bufferedAmount += bytes;
      let delivery;
      try {
        delivery = owner.sendFrame(json, invoke);
      } catch {
        this.bufferedAmount -= bytes;
        throw Error("Matrix node carrier delivery failed");
      }
      void Promise.resolve(delivery).then(
        () => {
          this.bufferedAmount -= bytes;
          settled?.();
        },
        () => {
          this.bufferedAmount -= bytes;
          settled?.(Error("Matrix node carrier delivery failed"));
          this.close(1011, "Matrix node carrier delivery failed");
        },
      );
      return bytes;
    }

    close(code = 1000, reason = "") {
      if (this.readyState !== 1) return;
      this.readyState = 3;
      this.emit("close", code, Buffer.from(reason));
      try {
        owner.onClose();
      } catch {
        // Owner cleanup must not interrupt native teardown or reject async delivery.
      }
    }

    terminate() {
      this.close(1006);
    }
  }
  const socket = new Transport();
  attachGatewayConnection({
    ...options,
    socket,
    connectionKind: "gateway",
    // Only an empty header view is needed by the existing handshake contract.
    // This socket is never connected, bound, attributed as local, or trusted as a proxy.
    request: new IncomingMessage(new Socket()),
    ingressAttribution: {
      kind: "matrix-node-carrier",
      clientIp: "",
      signal: owner.signal,
      assertCurrent: current,
      rateLimit: {
        subject: { key: buildRateLimitIdentityKey("matrix", owner.peerKey) },
        resetOnSuccess: true,
      },
    },
    addresses: {},
    releasePreauth: () => {},
    pluginNodeCapabilities: [],
    originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
    prepareAuthenticatedReceive: () => ({ ok: true, value: () => {} }),
  });
  return {
    receive(rawJson: string) {
      try {
        current();
      } catch {
        socket.close(1008, "Matrix node carrier revoked");
        return;
      }
      if (socket.readyState !== 1) return;
      if (Buffer.byteLength(rawJson) > MATRIX_NODE_CARRIER_MAX_BYTES) {
        socket.close(1009, "Matrix node carrier frame limit");
        return;
      }
      socket.emit("message", Buffer.from(rawJson));
    },
    close() {
      socket.close();
    },
  };
}
