export const MATRIX_NODE_CARRIER_EVENT = "io.openclaw.node";
const MAX_CARRIER_BYTES = 12 * 1024;
const LINK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type MatrixNodeCarrierAddress = {
  version: 1;
  room_id: string;
  link_id: string;
};

export type MatrixNodeCarrierMessage = MatrixNodeCarrierAddress &
  (
    | { kind: "open" }
    | { kind: "close" }
    | {
        kind: "frame";
        seq: number;
        frame: Record<string, unknown>;
        expires_at_ms?: number;
      }
  );

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeInvoke(frame: Record<string, unknown>): boolean {
  return frame.type === "event" && frame.event === "node.invoke.request";
}

export function readMatrixNodeCarrierMessage(value: unknown): MatrixNodeCarrierMessage | undefined {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.room_id !== "string" ||
    !/^![^\s]{1,511}$/u.test(value.room_id) ||
    typeof value.link_id !== "string" ||
    !LINK_ID.test(value.link_id)
  ) {
    return undefined;
  }
  const address: MatrixNodeCarrierAddress = {
    version: 1,
    room_id: value.room_id,
    link_id: value.link_id,
  };
  const fieldCount = Object.keys(value).length;
  if (fieldCount === 4 && (value.kind === "open" || value.kind === "close")) {
    return { ...address, kind: value.kind };
  }
  if (
    value.kind === "frame" &&
    typeof value.seq === "number" &&
    Number.isSafeInteger(value.seq) &&
    value.seq >= 0 &&
    object(value.frame)
  ) {
    const invoke = isNodeInvoke(value.frame);
    const expiresAt = value.expires_at_ms;
    if (
      fieldCount !== (invoke ? 7 : 6) ||
      (invoke
        ? typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 1
        : Object.hasOwn(value, "expires_at_ms")) ||
      Buffer.byteLength(JSON.stringify(value)) > MAX_CARRIER_BYTES
    ) {
      return undefined;
    }
    return {
      ...address,
      kind: "frame",
      seq: value.seq,
      frame: value.frame,
      ...(typeof expiresAt === "number" ? { expires_at_ms: expiresAt } : {}),
    };
  }
  return undefined;
}
