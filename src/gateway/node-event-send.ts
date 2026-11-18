import { logRejectedLargePayload } from "../logging/diagnostic-payload.js";
import { isSerializedEventPayload, type SerializedEventPayload } from "./node-event-payload.js";
import { serializeNodeEvent } from "./node-invoke-request.js";
import { isPublishedPairingCurrent } from "./node-registry-pairing.js";
import type { NodeRunnerRegistrySession } from "./node-runner-inventory-runtime.js";
import type { NodeEventTransport, NodeSession } from "./node-session.types.js";
import { MAX_BUFFERED_BYTES, WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import { closeGatewayTransportWithGrace } from "./server/connection-transport-close.js";
import type { GatewayConnectionTransport } from "./server/connection-transport.js";

export type NodeInvokeDispatch = {
  deadlineAtMs?: number;
  isAuthorized?: () => boolean;
};

export type NodeRegistryEventSender = (
  node: NodeRunnerRegistrySession,
  event: string,
  payload: unknown,
  invoke?: NodeInvokeDispatch,
) => boolean;

type NodeSessionEventTarget = {
  node: NodeSession;
  event: string;
  eventTransport?: NodeEventTransport;
  isPairingStateCurrent: Parameters<typeof isPublishedPairingCurrent>[1];
};

function canSendNodeSessionEvent({ node, isPairingStateCurrent }: NodeSessionEventTarget): boolean {
  return node.client.invalidated !== true && isPublishedPairingCurrent(node, isPairingStateCurrent);
}

export function sendNodeSessionEvent(
  params: NodeSessionEventTarget & {
    payload: unknown;
    invoke?: NodeInvokeDispatch;
  },
): boolean {
  const { node, event, payload, eventTransport, invoke } = params;
  if (!canSendNodeSessionEvent(params)) {
    return false;
  }
  if (eventTransport) {
    return eventTransport.send(event, payload);
  }
  return sendNodeWebSocketEvent(
    node.client.socket,
    event,
    () => serializeNodeEvent(event, payload),
    invoke,
  );
}

export function sendNodeSessionRawEvent(
  params: NodeSessionEventTarget & {
    payloadJSON?: SerializedEventPayload | null;
  },
): boolean {
  const { node, event, payloadJSON, eventTransport } = params;
  if (!canSendNodeSessionEvent(params)) {
    return false;
  }
  if (payloadJSON != null && !isSerializedEventPayload(payloadJSON)) {
    return false;
  }
  if (eventTransport) {
    return eventTransport.sendRaw(event, payloadJSON);
  }
  return sendNodeWebSocketEvent(node.client.socket, event, () => {
    const payloadFragment = payloadJSON ? `,"payload":${payloadJSON.json}` : "";
    return `{"type":"event","event":${JSON.stringify(event)}${payloadFragment}}`;
  });
}

export function sendNodeWebSocketEvent(
  socket: GatewayConnectionTransport,
  event: string,
  serialize: () => string,
  invoke?: NodeInvokeDispatch,
): boolean {
  // ws.send() does not throw after entering CLOSING; it only accounts unsent bytes.
  if (socket.readyState !== WEBSOCKET_OPEN_READY_STATE) {
    return false;
  }
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    logRejectedLargePayload({
      surface: "gateway.ws.outbound_buffer",
      bytes: socket.bufferedAmount,
      limitBytes: MAX_BUFFERED_BYTES,
      reason: "ws_send_buffer_close",
    });
    closeGatewayTransportWithGrace(socket, 1008, "slow consumer");
    return false;
  }
  try {
    const frame = Buffer.from(serialize());
    let wireBytes: number | void;
    if (event === "node.invoke.request" && socket.sendNodeInvoke) {
      if (invoke?.deadlineAtMs === undefined || !Number.isFinite(invoke.deadlineAtMs)) {
        return false;
      }
      wireBytes = socket.sendNodeInvoke(frame, invoke.deadlineAtMs, invoke.isAuthorized);
    } else {
      wireBytes = socket.send(frame, { binary: false });
    }
    socket.recordEventSent?.(event, frame, undefined, undefined, wireBytes);
    return true;
  } catch {
    return false;
  }
}
