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
