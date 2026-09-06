import { RTC_SLOT_ENCRYPTION_PER_MEMBER } from "matrix-js-sdk/lib/matrixrtc/types.js";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";

type MatrixRtcMembershipLike = {
  userId: string;
};

export function assertMatrixRtcCallAdmission<T extends MatrixRtcMembershipLike>(params: {
  isDirectRoom: boolean;
  joinedUserIds: string[];
  selfUserId: string;
  allowedUserId: string;
  routedAgentId: string;
  allowedAgentId: string;
  memberships: T[];
}): T {
  if (!params.isDirectRoom) {
    throw new Error("MatrixRTC admission is restricted to direct rooms");
  }

  const actualUsers = params.joinedUserIds.toSorted();
  const expectedUsers = [params.allowedUserId, params.selfUserId].toSorted();
  if (
    actualUsers.length !== expectedUsers.length ||
    actualUsers.some((entry, index) => entry !== expectedUsers[index])
  ) {
    throw new Error("MatrixRTC admission requires an exact two-user direct room");
  }

  if (normalizeAgentId(params.routedAgentId) !== normalizeAgentId(params.allowedAgentId)) {
    throw new Error("MatrixRTC admission does not match the normal Matrix agent route");
  }

  if (
    params.memberships.some(
      (membership) =>
        membership.userId !== params.selfUserId && membership.userId !== params.allowedUserId,
    )
  ) {
    throw new Error("MatrixRTC session contains an unexpected Matrix identity");
  }
  const remote = params.memberships.filter(
    (membership) => membership.userId === params.allowedUserId,
  );
  if (remote.length !== 1) {
    throw new Error("MatrixRTC requires exactly one active membership for the allowed user");
  }
  return remote[0]!;
}

function normalizeServiceUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

export function assertMatrixRtcEncryptionCompatibility(advertisedType: unknown): void {
  // MSC4143 makes the slot's encryption descriptor optional. A missing
  // descriptor is therefore not evidence of clear media: the controller joins
  // with managed media keys and refuses to start its bridge until it has both
  // the local key and a key from the exactly admitted remote membership.
  if (advertisedType === undefined) {
    return;
  }
  if (advertisedType !== RTC_SLOT_ENCRYPTION_PER_MEMBER) {
    throw new Error("MatrixRTC call advertises an unsupported media encryption scheme");
  }
}

export function assertMatrixRtcPinnedTransports(params: {
  pinnedAuthServiceUrl: string;
  homeserverLivekitServiceUrl: string;
  remoteTransportType?: string;
  remoteLivekitServiceUrl?: unknown;
}): void {
  if (normalizeServiceUrl(params.homeserverLivekitServiceUrl) !== params.pinnedAuthServiceUrl) {
    throw new Error("MatrixRTC homeserver transport does not match the pinned authorization URL");
  }
  if (
    params.remoteTransportType !== "livekit" ||
    typeof params.remoteLivekitServiceUrl !== "string" ||
    normalizeServiceUrl(params.remoteLivekitServiceUrl) !== params.pinnedAuthServiceUrl
  ) {
    throw new Error("MatrixRTC remote membership uses an untrusted transport");
  }
}
