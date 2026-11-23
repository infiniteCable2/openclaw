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
  assertMatrixNodeCarrierDispatch,
  type MatrixNodeCarrierBinding,
} from "./matrix-node-carrier-authority.js";
import {
  isMatrixNodeCarrierCommand,
  MATRIX_NODE_CARRIER_MAX_BYTES,
} from "./matrix-node-carrier-policy.js";

/** Host-only handoff for a live, verified Matrix owner and its already authenticated peer. */
export type MatrixNodeCarrierOwner = {
  peerKey: string;
  agentId: string;
  expectedNodeId?: string;
  privateRequesterSenderId?: string;
  allowCrossChannelAccess?: boolean;
  /** Throws unless the Gateway-verified session still owns this live RTC admission. */
  assertInvokeSession?(sessionKey: string): void;
  roomId: string;
  signal: AbortSignal;
  assertCurrent(): void;
  sendFrame(
    nativeJson: string,
    invoke?: { deadlineAtMs: number; assertCurrent(): void },
  ): void | Promise<void>;
  onClose(): void;
};

export type MatrixNodeCarrierHostOwner = Omit<
  MatrixNodeCarrierOwner,
  "privateRequesterSenderId"
> & {
  accountId: string;
  privateRequester?: Readonly<{ profileId: string; isCurrent(): boolean }>;
};

export function attachMatrixNodeCarrier(
  connectionOptions: GatewayConnectionOptions,
  owner: MatrixNodeCarrierHostOwner,
) {
  if (
    !owner.agentId.trim() ||
    !owner.accountId.trim() ||
    !/^![^\s]+$/u.test(owner.roomId) ||
    (owner.expectedNodeId !== undefined &&
      (!/^[a-f0-9]{64}$/u.test(owner.expectedNodeId) ||
        typeof owner.assertInvokeSession !== "function"))
  ) {
    throw new Error("Invalid Matrix node carrier binding");
  }
  const current = () => {
    if (owner.signal.aborted) {
      throw new Error("Matrix node carrier revoked");
    }
    owner.assertCurrent();
    if (owner.allowCrossChannelAccess && !owner.privateRequester?.isCurrent()) {
      throw new Error("Matrix Node owner person profile changed");
    }
  };
  current();
  const binding: MatrixNodeCarrierBinding = Object.freeze({
    agentId: owner.agentId,
    roomId: owner.roomId,
    accountId: owner.accountId,
    expectedNodeId: owner.expectedNodeId,
    assertInvokeSession: owner.assertInvokeSession?.bind(owner),
    privateRequester: owner.privateRequester,
    allowCrossChannelAccess: owner.allowCrossChannelAccess,
    isCurrent: () => {
      current();
      return true;
    },
  });
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

    sendNodeInvoke(
      frame: Buffer,
      dispatchDeadlineAtMs: number,
      isDispatchAuthorized?: () => boolean,
    ) {
      // The adapter owns translation from this process-monotonic deadline to
      // its Matrix envelope, including the original challenge time anchor.
      return this.write(frame, undefined, {
        deadlineAtMs: dispatchDeadlineAtMs,
        isDispatchAuthorized,
      });
    }

    private write(
      frame: string | Buffer | SerializedGatewayFrame,
      settled?: (error?: Error) => void,
      invoke?: { deadlineAtMs: number; isDispatchAuthorized?: () => boolean },
    ): number | undefined {
      const json = frame.toString();
      const bytes = Buffer.byteLength(json);
      current();
      if (this.readyState !== 1) {
        throw new Error("Matrix node carrier closed");
      }
      const message = asOptionalObjectRecord(JSON.parse(json));
      const isInvoke = message?.type === "event" && message.event === "node.invoke.request";
      if (isInvoke !== Boolean(invoke)) {
        throw new Error("Matrix node invoke requires dispatch deadline");
      }
      if (message?.type === "event" && message.event !== "connect.challenge") {
        if (message.event !== "node.invoke.request") {
          settled?.();
          return undefined;
        }
        if (!isMatrixNodeCarrierCommand(asOptionalObjectRecord(message.payload)?.command)) {
          throw new Error("Matrix node command not allowed");
        }
      }
      if (
        bytes > MATRIX_NODE_CARRIER_MAX_BYTES ||
        this.bufferedAmount + bytes > MATRIX_NODE_CARRIER_MAX_BYTES
      ) {
        this.close(1009, "Matrix node carrier frame limit");
        throw new Error("Matrix node carrier frame limit");
      }
      const invokeMetadata = invoke && {
        deadlineAtMs: invoke.deadlineAtMs,
        assertCurrent: () => {
          const payload = asOptionalObjectRecord(message?.payload);
          assertMatrixNodeCarrierDispatch(
            binding,
            payload?.nodeId,
            payload?.command,
            invoke.isDispatchAuthorized,
          );
          current();
          if (owner.signal.aborted || this.readyState !== 1) {
            throw new Error("Matrix node carrier closed");
          }
          if (!Number.isFinite(invoke.deadlineAtMs) || invoke.deadlineAtMs <= performance.now()) {
            throw new Error("Matrix node invoke deadline elapsed");
          }
        },
      };
      invokeMetadata?.assertCurrent();
      this.bufferedAmount += bytes;
      let delivery;
      try {
        delivery = owner.sendFrame(json, invokeMetadata);
      } catch {
        this.bufferedAmount -= bytes;
        throw new Error("Matrix node carrier delivery failed");
      }
      void Promise.resolve(delivery).then(
        () => {
          this.bufferedAmount -= bytes;
          settled?.();
        },
        () => {
          this.bufferedAmount -= bytes;
          settled?.(new Error("Matrix node carrier delivery failed"));
          this.close(1011, "Matrix node carrier delivery failed");
        },
      );
      return bytes;
    }

    close(code = 1000, reason = "") {
      if (this.readyState !== 1) {
        return;
      }
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
    ...connectionOptions,
    socket,
    connectionKind: "gateway",
    // Only an empty header view is needed by the existing handshake contract.
    // This socket is never connected, bound, attributed as local, or trusted as a proxy.
    request: new IncomingMessage(new Socket()),
    ingressAttribution: {
      kind: "matrix-node-carrier",
      binding,
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
    assertCurrent: current,
    receive(rawJson: string) {
      try {
        current();
      } catch {
        socket.close(1008, "Matrix node carrier revoked");
        return;
      }
      if (socket.readyState !== 1) {
        return;
      }
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
