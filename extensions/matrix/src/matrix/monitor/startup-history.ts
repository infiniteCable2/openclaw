import { isDeepStrictEqual } from "node:util";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  cloneRuntimeConfigSnapshot,
  createRuntimeConfigReader,
  getRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveMatrixAccountConfig } from "../account-config.js";
import { readJoinedMatrixMembers } from "../direct-room.js";
import type { MatrixClient } from "../sdk.js";
import { isMatrixQualifiedUserId } from "../target-ids.js";
import { resolveMatrixMonitorAccessState } from "./access-state.js";
import {
  resolveMatrixMonitorLiveUserAllowlist,
  type MatrixResolvedAllowlistEntry,
} from "./config.js";
import type { createDirectRoomTracker } from "./direct.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { resolveMatrixInboundRoute } from "./route.js";

/** One healthy account snapshot supplies real endpoint proofs, never synthetic user input. */
export async function prepareMatrixStartupConversationRoots(params: {
  client: MatrixClient;
  core: PluginRuntime;
  runtime: RuntimeEnv;
  accountId: string;
  groupPolicy: "open" | "allowlist" | "disabled";
  directTracker: ReturnType<typeof createDirectRoomTracker>;
  startupAllowFrom: readonly MatrixResolvedAllowlistEntry[];
  startupGroupAllowFrom: readonly MatrixResolvedAllowlistEntry[];
  getRuntimeConfig: PluginRuntime["config"]["current"];
  getRoomInfo(roomId: string): Promise<{
    canonicalAlias?: string | null;
    altAliases?: string[];
  }>;
  signal: AbortSignal;
  assertCurrent(): void;
  retainCleanup(close: () => Promise<void>): void | (() => void);
}): Promise<void> {
  const prepare = params.core.channel.inbound.ingress.conversation?.prepareConnection;
  if (!prepare) {
    return;
  }
  const original = params.getRuntimeConfig();
  const native = getRuntimeConfigSnapshot();
  // Only the actual native owner may supply publication-stable immutable captures.
  // An explicit scoped getter must never inherit an unrelated ambient runtime.
  const readPublished =
    native === original ? createRuntimeConfigReader(native, { capture: true }) : undefined;
  const captured = readPublished?.();
  const cfg = cloneRuntimeConfigSnapshot(captured ?? original);
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
    const current = params.getRuntimeConfig();
    if (
      readPublished
        ? getRuntimeConfigSnapshot() !== current || readPublished() !== captured
        : current !== original || !isDeepStrictEqual(current, cfg)
    ) {
      throw new Error("Matrix startup conversation configuration changed");
    }
  };
  assertCurrent();
  const account = resolveMatrixAccountConfig({ cfg, accountId: params.accountId });
  if (account.dm?.enabled === false) {
    return;
  }
  const selfUserId = await params.client.getUserId();
  assertCurrent();
  const rooms = await params.client.getJoinedRooms();
  assertCurrent();
  const allowFrom = await resolveMatrixMonitorLiveUserAllowlist({
    cfg,
    accountId: params.accountId,
    entries: account.dm?.allowFrom,
    startupResolvedEntries: params.startupAllowFrom,
    runtime: params.runtime,
    failClosedOnUnresolved: true,
  });
  const groupAllowFrom = await resolveMatrixMonitorLiveUserAllowlist({
    cfg,
    accountId: params.accountId,
    entries: account.groupAllowFrom,
    startupResolvedEntries: params.startupGroupAllowFrom,
    runtime: params.runtime,
    failClosedOnUnresolved: true,
  });
  assertCurrent();
  for (const roomId of new Set(rooms)) {
    assertCurrent();
    try {
      const joinedMembers = await readJoinedMatrixMembers(params.client, roomId);
      assertCurrent();
      if (joinedMembers?.length !== 2 || !joinedMembers.includes(selfUserId)) {
        continue;
      }
      const senderId = joinedMembers.find((member) => member !== selfUserId);
      if (!senderId || !isMatrixQualifiedUserId(senderId)) {
        continue;
      }
      const privateAudience = await params.directTracker.preparePrivateAudience({
        roomId,
        senderId,
      });
      assertCurrent();
      if (!privateAudience) {
        continue;
      }
      const isDirectMessage = await params.directTracker.isDirectMessage({
        roomId,
        senderId,
        selfUserId,
        joinedMembers,
        allowPromotion: false,
      });
      assertCurrent();
      const roomInfo = await params.getRoomInfo(roomId);
      assertCurrent();
      const room = resolveMatrixRoomConfig({
        roomId,
        aliases: [roomInfo.canonicalAlias, ...(roomInfo.altAliases ?? [])].filter(
          (alias): alias is string => typeof alias === "string" && alias.length > 0,
        ),
        rooms: account.groups ?? account.rooms,
      });
      if (!isDirectMessage && room.allowlistConfigured && !room.allowed) {
        continue;
      }
      const { route, bindingOwnerAvailable } = resolveMatrixInboundRoute({
        cfg,
        accountId: params.accountId,
        roomId,
        senderId,
        isDirectMessage,
        dmSessionScope: account.dm?.sessionScope,
        resolveAgentRoute: params.core.channel.routing.resolveAgentRoute,
      });
      if (!bindingOwnerAvailable) {
        continue;
      }
      const access = await resolveMatrixMonitorAccessState({
        accountId: params.accountId,
        senderId,
        conversationId: roomId,
        isRoom: !isDirectMessage,
        eventKind: "conversation",
        dmPolicy: account.allowlistOnly ? "allowlist" : account.dm?.policy,
        groupPolicy: params.groupPolicy,
        allowFrom,
        storeAllowFrom: await params.core.channel.pairing.readAllowFromStore({
          channel: "matrix",
          accountId: params.accountId,
          env: process.env,
        }),
        groupAllowFrom,
        roomUsers: room.config?.users ?? [],
      });
      assertCurrent();
      const binding = {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        nativeChannelId: roomId,
        inboundEventKind: "room_event" as const,
      };
      const conversation = {
        kind: isDirectMessage ? ("direct" as const) : ("channel" as const),
        id: roomId,
      };
      const ingress = await access.resolveMessageIngress(binding, conversation, privateAudience);
      assertCurrent();
      if (ingress.ingress.admission !== "dispatch") {
        continue;
      }
      await prepare({
        ingress,
        scope: {
          channelId: "matrix",
          accountId: params.accountId,
          rawPrincipalRef: senderId,
          conversation,
          binding,
        },
        purpose: "root-preparation",
        assertCurrent,
        signal: params.signal,
        retainCleanup: (close) => params.retainCleanup(close),
      });
      assertCurrent();
    } catch {
      assertCurrent();
      params.runtime.log?.("matrix: related-history startup endpoint preparation deferred");
    }
  }
}
