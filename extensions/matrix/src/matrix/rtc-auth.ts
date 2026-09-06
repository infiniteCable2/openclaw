import type { IOpenIDToken } from "matrix-js-sdk/lib/client.js";
import type { MatrixRtcMode } from "./rtc-mode.js";

const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_JWT_BYTES = 16 * 1024;

export type MatrixRtcMembershipIdentity = {
  userId: string;
  deviceId: string;
  memberId: string;
};

export type MatrixRtcCredentials = {
  url: string;
  token: string;
};

function tokenEndpoint(authServiceUrl: string, mode: MatrixRtcMode): URL {
  const endpoint = new URL(authServiceUrl);
  const route = mode === "compatibility" ? "sfu/get" : "get_token";
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${route}`;
  return endpoint;
}

async function readBoundedResponse(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_AUTH_RESPONSE_BYTES) {
    throw new Error("MatrixRTC authorization response exceeded the size limit");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_AUTH_RESPONSE_BYTES) {
    throw new Error("MatrixRTC authorization response exceeded the size limit");
  }
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

export async function requestMatrixRtcCredentials(params: {
  mode: MatrixRtcMode;
  authServiceUrl: string;
  roomId: string;
  slotId: string;
  membership: MatrixRtcMembershipIdentity;
  openIdToken: IOpenIDToken;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<MatrixRtcCredentials> {
  const endpoint = tokenEndpoint(params.authServiceUrl, params.mode);
  const requestBody =
    params.mode === "compatibility"
      ? {
          room: params.roomId,
          openid_token: params.openIdToken,
          device_id: params.membership.deviceId,
        }
      : {
          room_id: params.roomId,
          slot_id: params.slotId,
          openid_token: params.openIdToken,
          member: {
            id: params.membership.memberId,
            claimed_user_id: params.membership.userId,
            claimed_device_id: params.membership.deviceId,
          },
        };
  const response = await (params.fetchFn ?? fetch)(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`MatrixRTC authorization failed with HTTP ${response.status}`);
  }
  const body = await readBoundedResponse(response);
  if (!body || typeof body !== "object") {
    throw new Error("MatrixRTC authorization returned an invalid response");
  }
  const candidate = body as { url?: unknown; jwt?: unknown };
  if (typeof candidate.url !== "string" || typeof candidate.jwt !== "string") {
    throw new Error("MatrixRTC authorization response is missing connection credentials");
  }
  if (!candidate.jwt || Buffer.byteLength(candidate.jwt, "utf8") > MAX_JWT_BYTES) {
    throw new Error("MatrixRTC authorization returned an invalid token");
  }
  let livekitUrl: URL;
  try {
    livekitUrl = new URL(candidate.url);
  } catch {
    throw new Error("MatrixRTC authorization returned an invalid LiveKit URL");
  }
  if (
    livekitUrl.protocol !== "wss:" ||
    livekitUrl.username ||
    livekitUrl.password ||
    livekitUrl.hostname !== endpoint.hostname
  ) {
    throw new Error("MatrixRTC authorization returned an untrusted LiveKit URL");
  }
  return { url: livekitUrl.toString(), token: candidate.jwt };
}
