import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { promoteMatrixDirectRoomCandidate } from "../direct-management.js";
import {
  hasDirectMatrixMemberFlag,
  isStrictDirectMembership,
  readJoinedMatrixMembers,
} from "../direct-room.js";
import type { MatrixClient } from "../sdk.js";
import { resolveMatrixSenderParticipant } from "../sender-identity.js";
import { setBoundedMap } from "./bounded-cache.js";

type DirectMessageCheck = {
  roomId: string;
  senderId?: string;
  selfUserId?: string;
  joinedMembers?: string[];
};

type DirectRoomTrackerOptions = {
  log?: (message: string) => void;
  /** The owning account generation, not a user's room-routing preference. */
  isCurrent?: () => boolean;
  /** A temporarily unhealthy sync cannot hold private audience evidence. */
  isAudienceCurrent?: () => boolean;
  isExplicitlyConfiguredRoom?: (roomId: string) => boolean | Promise<boolean>;
  canPromoteRecentInvite?: (roomId: string) => boolean | Promise<boolean>;
  canPromoteUnmappedStrictRoom?: (roomId: string) => boolean | Promise<boolean>;
  shouldKeepLocallyPromotedDirectRoom?:
    | ((roomId: string) => boolean | undefined | Promise<boolean | undefined>)
    | undefined;
};

const DM_CACHE_TTL_MS = 30_000;
const RECENT_INVITE_TTL_MS = 30_000;
const MAX_DM_ROOMS = 1024;
const MAX_DM_MEMBER_FLAGS = 2048;

/** The full native state response includes invitees, unlike joined_members. */
function privateAudienceMemberFlag(
  state: unknown,
  selfUserId: string,
  remoteUserId: string,
): boolean | null | undefined {
  if (!Array.isArray(state)) {
    return undefined;
  }
  // Matrix SDK room-state defaults apply only when the complete snapshot omits an event.
  let history = "shared";
  let selfMemberFlag: boolean | null = null;
  const members = new Map<string, string>();
  const seen = new Set<string>();
  let thirdPartyInvite = false;
  for (const event of state) {
    if (!isRecord(event) || typeof event.type !== "string" || typeof event.state_key !== "string") {
      return undefined;
    }
    if (
      ![
        "m.room.member",
        "m.room.history_visibility",
        "m.room.join_rules",
        "m.room.third_party_invite",
      ].includes(event.type)
    ) {
      continue;
    }
    const key = JSON.stringify([event.type, event.state_key]);
    if (seen.has(key) || !isRecord(event.content)) {
      return undefined;
    }
    seen.add(key);
    const content = event.content;
    if (event.type === "m.room.history_visibility" || event.type === "m.room.join_rules") {
      if (event.state_key !== "") return undefined;
      if (event.type === "m.room.history_visibility") {
        if (
          typeof content.history_visibility !== "string" ||
          !["shared", "invited", "joined"].includes(content.history_visibility)
        )
          return undefined;
        history = content.history_visibility;
      } else {
        if (content.join_rule !== "invite" && content.join_rule !== "knock") return undefined;
      }
    } else if (event.type === "m.room.member") {
      if (
        !resolveMatrixSenderParticipant({ stableId: event.state_key }) ||
        typeof content.membership !== "string" ||
        !["join", "invite", "leave", "ban", "knock"].includes(content.membership)
      ) {
        return undefined;
      }
      members.set(event.state_key, content.membership);
      if (event.state_key === selfUserId) {
        if (content.is_direct !== undefined && typeof content.is_direct !== "boolean")
          return undefined;
        selfMemberFlag = typeof content.is_direct === "boolean" ? content.is_direct : null;
      }
    } else if (Object.keys(content).length > 0) {
      thirdPartyInvite = true;
    }
  }
  if (
    !isStrictDirectMembership({
      selfUserId,
      remoteUserId,
      joinedMembers: [...members]
        .filter(([, membership]) => membership === "join")
        .map(([id]) => id),
    }) ||
    (history !== "joined" &&
      (thirdPartyInvite ||
        [...members].some(
          ([id, membership]) => membership === "invite" && id !== selfUserId && id !== remoteUserId,
        )))
  ) {
    return undefined;
  }
  return selfMemberFlag;
}

export function createDirectRoomTracker(client: MatrixClient, opts: DirectRoomTrackerOptions = {}) {
  const log = opts.log ?? (() => {});
  let lastDmUpdateMs = 0;
  // Once m.direct has seeded successfully, prefer the explicit cache over
  // re-enabling the broad 2-person fallback after a later transient failure.
  let hasSeededDmCache = false;
  let cachedSelfUserId: string | null = null;
  const joinedMembersCache = new Map<string, { members: string[]; ts: number }>();
  const directMemberFlagCache = new Map<string, { isDirect: boolean | null; ts: number }>();
  const recentInviteCandidates = new Map<string, { remoteUserId: string; ts: number }>();
  const locallyPromotedDirectRooms = new Map<string, { remoteUserId: string }>();
  const privateAudienceRooms = new Map<string, { senderId: string; selfUserId?: string }>();
  let active = true;

  const isOwnerCurrent = (): boolean => {
    try {
      if (active && (opts.isCurrent?.() ?? true)) {
        return true;
      }
    } catch {
      // An unavailable owner cannot retain a private disclosure claim.
    }
    active = false;
    privateAudienceRooms.clear();
    return false;
  };

  const isAudienceCurrent = (): boolean => {
    if (!isOwnerCurrent()) {
      return false;
    }
    try {
      if (opts.isAudienceCurrent?.() ?? true) {
        return true;
      }
    } catch {
      // Sync uncertainty revokes evidence without disposing the account owner.
    }
    privateAudienceRooms.clear();
    return false;
  };

  const ensureSelfUserId = async (): Promise<string | null> => {
    if (cachedSelfUserId) {
      return cachedSelfUserId;
    }
    try {
      cachedSelfUserId = await client.getUserId();
    } catch {
      cachedSelfUserId = null;
    }
    return cachedSelfUserId;
  };

  const refreshDmCache = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastDmUpdateMs < DM_CACHE_TTL_MS) {
      return;
    }
    lastDmUpdateMs = now;
    hasSeededDmCache = (await client.dms.update()) || hasSeededDmCache;
  };

  const resolveJoinedMembers = async (roomId: string): Promise<string[] | null> => {
    const cached = joinedMembersCache.get(roomId);
    const now = Date.now();
    if (cached && now - cached.ts < DM_CACHE_TTL_MS) {
      return cached.members;
    }
    try {
      const normalized = await readJoinedMatrixMembers(client, roomId);
      if (!normalized) {
        throw new Error("membership unavailable");
      }
      setBoundedMap(joinedMembersCache, roomId, { members: normalized, ts: now }, MAX_DM_ROOMS);
      return normalized;
    } catch (err) {
      log(`matrix: dm member lookup failed room=${roomId} (${String(err)})`);
      return null;
    }
  };

  const resolveDirectMemberFlag = async (
    roomId: string,
    userId?: string | null,
  ): Promise<boolean | null> => {
    const normalizedUserId = userId?.trim();
    if (!normalizedUserId) {
      return null;
    }
    const cacheKey = `${roomId}\n${normalizedUserId}`;
    const cached = directMemberFlagCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.ts < DM_CACHE_TTL_MS) {
      return cached.isDirect;
    }
    const isDirect = await hasDirectMatrixMemberFlag(client, roomId, normalizedUserId);
    setBoundedMap(directMemberFlagCache, cacheKey, { isDirect, ts: now }, MAX_DM_MEMBER_FLAGS);
    return isDirect;
  };

  const hasRecentInviteCandidate = (roomId: string, remoteUserId?: string | null): boolean => {
    const normalizedRemoteUserId = remoteUserId?.trim();
    if (!normalizedRemoteUserId) {
      return false;
    }
    const cached = recentInviteCandidates.get(roomId);
    if (!cached) {
      return false;
    }
    if (Date.now() - cached.ts >= RECENT_INVITE_TTL_MS) {
      recentInviteCandidates.delete(roomId);
      return false;
    }
    return cached.remoteUserId === normalizedRemoteUserId;
  };

  const roomPolicies = {
    canPromoteRecentInvite: [true, false, "recent invite promotion veto"],
    canPromoteUnmappedStrictRoom: [false, false, "unmapped strict room promotion veto"],
    shouldKeepLocallyPromotedDirectRoom: [undefined, undefined, "local promotion keep-check"],
    isExplicitlyConfiguredRoom: [false, true, "configured room check"],
  } as const;
  const checkRoomPolicy = async (key: keyof typeof roomPolicies, roomId: string) => {
    const [fallback, onError, label] = roomPolicies[key];
    try {
      return (await opts[key]?.(roomId)) ?? fallback;
    } catch (err) {
      log(`matrix: ${label} failed room=${roomId} (${String(err)})`);
      return onError;
    }
  };

  const hasLocallyPromotedDirectRoom = (roomId: string, remoteUserId?: string | null): boolean => {
    const normalizedRemoteUserId = remoteUserId?.trim();
    if (!normalizedRemoteUserId) {
      return false;
    }
    return locallyPromotedDirectRooms.get(roomId)?.remoteUserId === normalizedRemoteUserId;
  };

  const rememberLocallyPromotedDirectRoom = (roomId: string, remoteUserId: string): void => {
    const normalizedRemoteUserId = remoteUserId.trim();
    if (!normalizedRemoteUserId) {
      return;
    }
    setBoundedMap(
      locallyPromotedDirectRooms,
      roomId,
      { remoteUserId: normalizedRemoteUserId },
      MAX_DM_ROOMS,
    );
  };

  return {
    dispose: (): void => {
      active = false;
      privateAudienceRooms.clear();
    },
    invalidatePrivateAudiences: (roomId?: string): void => {
      if (roomId === undefined) privateAudienceRooms.clear();
      else privateAudienceRooms.delete(roomId);
    },
    invalidateRoom: (roomId: string): void => {
      privateAudienceRooms.delete(roomId);
      joinedMembersCache.delete(roomId);
      for (const key of directMemberFlagCache.keys()) {
        if (key.startsWith(`${roomId}\n`)) {
          directMemberFlagCache.delete(key);
        }
      }
      lastDmUpdateMs = 0;
      log(`matrix: invalidated dm cache room=${roomId}`);
    },
    rememberInvite: (roomId: string, remoteUserId: string): void => {
      const normalizedRemoteUserId = remoteUserId.trim();
      if (!normalizedRemoteUserId) {
        return;
      }
      const invite = { remoteUserId: normalizedRemoteUserId, ts: Date.now() };
      setBoundedMap(recentInviteCandidates, roomId, invite, MAX_DM_ROOMS);
      log(`matrix: remembered invite candidate room=${roomId} sender=${normalizedRemoteUserId}`);
    },
    /** Privacy evidence is independent of DM routing and never promotes a configured room. */
    preparePrivateAudience: async (
      params: DirectMessageCheck & { senderId: string },
    ): Promise<{ assertCurrent(): void } | undefined> => {
      const { roomId, senderId } = params;
      if (
        !isAudienceCurrent() ||
        !roomId ||
        roomId !== roomId.trim() ||
        !resolveMatrixSenderParticipant({ stableId: senderId })
      ) {
        return undefined;
      }
      let token = privateAudienceRooms.get(roomId);
      if (!token || token.senderId !== senderId) {
        token = { senderId };
        setBoundedMap(privateAudienceRooms, roomId, token, MAX_DM_ROOMS);
      }
      const selected = token;
      // Sync/membership ownership revokes evidence; a routing cache TTL cannot end a user turn.
      const current = () => isAudienceCurrent() && privateAudienceRooms.get(roomId) === selected;
      const deny = () => {
        if (privateAudienceRooms.get(roomId) === selected) {
          privateAudienceRooms.delete(roomId);
        }
        return undefined;
      };
      try {
        // Caller hints and routing caches cannot establish a private audience.
        const selfUserId = await client.getUserId();
        if (
          !current() ||
          !resolveMatrixSenderParticipant({ stableId: selfUserId }) ||
          senderId === selfUserId ||
          (selected.selfUserId !== undefined && selected.selfUserId !== selfUserId) ||
          (params.selfUserId !== undefined && params.selfUserId !== selfUserId)
        ) {
          return deny();
        }
        selected.selfUserId = selfUserId;
        const state = await client.doRequest(
          "GET",
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,
        );
        const memberFlag = privateAudienceMemberFlag(state, selfUserId, senderId);
        if (!current() || memberFlag === undefined || memberFlag === false) {
          return deny();
        }
        if (memberFlag !== true) {
          const updated = await client.dms.update();
          if (!current() || !updated || !client.dms.isDm(roomId)) {
            return deny();
          }
        }
        let revoked = false;
        return {
          assertCurrent() {
            if (revoked || !current()) {
              revoked = true;
              throw new Error("Matrix private audience is no longer current");
            }
          },
        };
      } catch {
        return deny();
      }
    },
    isDirectMessage: async (params: DirectMessageCheck): Promise<boolean> => {
      const { roomId, senderId } = params;
      if (await checkRoomPolicy("isExplicitlyConfiguredRoom", roomId)) {
        log(`matrix: dm rejected via explicit room config room=${roomId}`);
        return false;
      }
      const selfUserId = params.selfUserId ?? (await ensureSelfUserId());
      const joinedMembers = params.joinedMembers ?? (await resolveJoinedMembers(roomId));
      const strictDirectMembership = isStrictDirectMembership({
        selfUserId,
        remoteUserId: senderId,
        joinedMembers,
      });

      try {
        await refreshDmCache();
      } catch (err) {
        log(`matrix: dm cache refresh failed (${String(err)})`);
      }

      if (client.dms.isDm(roomId)) {
        if (strictDirectMembership) {
          log(`matrix: dm detected via m.direct room=${roomId}`);
          return true;
        }
        log(`matrix: ignoring stale m.direct classification room=${roomId}`);
      }

      if (strictDirectMembership) {
        const directViaSelf = await resolveDirectMemberFlag(roomId, selfUserId);
        if (directViaSelf === true) {
          log(`matrix: dm detected via member state room=${roomId}`);
          return true;
        }
        if (directViaSelf === false) {
          log(`matrix: dm rejected via member state room=${roomId}`);
          return false;
        }

        if (!hasSeededDmCache) {
          log(
            `matrix: dm detected via exact 2-member fallback before dm cache seed room=${roomId}`,
          );
          return true;
        }

        if (hasLocallyPromotedDirectRoom(roomId, senderId)) {
          const shouldKeep = await checkRoomPolicy("shouldKeepLocallyPromotedDirectRoom", roomId);
          if (shouldKeep !== false) {
            log(`matrix: dm detected via local promotion room=${roomId}`);
            return true;
          }
          locallyPromotedDirectRooms.delete(roomId);
          log(`matrix: local promotion cleared room=${roomId}`);
        }

        const promoteDirectRoom = async (source: string): Promise<boolean> => {
          const promotion = await promoteMatrixDirectRoomCandidate({
            client,
            remoteUserId: senderId ?? "",
            roomId,
            selfUserId,
          });
          if (promotion.classifyAsDirect) {
            rememberLocallyPromotedDirectRoom(roomId, senderId ?? "");
            log(
              `matrix: dm detected via ${source} room=${roomId} reason=${promotion.reason} repaired=${String(promotion.repaired)}`,
            );
          }
          return promotion.classifyAsDirect;
        };

        if (
          hasRecentInviteCandidate(roomId, senderId) &&
          (await checkRoomPolicy("canPromoteRecentInvite", roomId)) &&
          (await promoteDirectRoom("recent invite"))
        ) {
          return true;
        }
        if (
          (await checkRoomPolicy("canPromoteUnmappedStrictRoom", roomId)) &&
          (await promoteDirectRoom("per-room strict fallback"))
        ) {
          return true;
        }
      }

      log(
        `matrix: dm check room=${roomId} result=group members=${joinedMembers?.length ?? "unknown"}`,
      );
      return false;
    },
  };
}
