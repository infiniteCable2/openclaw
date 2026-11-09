import { isDeepStrictEqual } from "node:util";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { retryAsync, sleepWithAbort } from "openclaw/plugin-sdk/retry-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  cloneRuntimeConfigSnapshot,
  createRuntimeConfigReader,
  createRuntimeConfigSnapshotMatcher,
  getRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveMatrixAccountConfig } from "../account-config.js";
import { readJoinedMatrixMembers } from "../direct-room.js";
import type { MatrixClient } from "../sdk.js";
import { isMatrixQualifiedUserId } from "../target-ids.js";
import { resolveMatrixEndpointPolicy, resolveMatrixMonitorAccessState } from "./access-state.js";
import {
  resolveMatrixMonitorLiveUserAllowlist,
  type MatrixResolvedAllowlistEntry,
} from "./config.js";
import type { createDirectRoomTracker } from "./direct.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { resolveMatrixInboundRouteAsync } from "./route.js";

type RootState = "registered" | "prepared" | "unavailable" | "invalidated";
type RoomScope = {
  signal: AbortSignal;
  assertCurrent(): void;
  onState(state: RootState): void;
  failed(): void;
};

type QualificationPhase =
  | "account"
  | "rooms"
  | "allowlist"
  | "membership"
  | "privacy"
  | "route"
  | "ingress"
  | "registration";

class StartupQualificationError extends Error {
  constructor() {
    super("Matrix startup qualification remains unavailable");
  }
}

function reportQualificationFailure(
  runtime: RuntimeEnv,
  phase: QualificationPhase,
  error: unknown,
) {
  const refused = [
    "AbortError",
    "ConversationInputAdmissionError",
    "PersonalConversationReadRefusedError",
    "SessionMutationAuthorizationChangedError",
  ];
  const failureClass =
    error instanceof StartupQualificationError
      ? "unavailable"
      : error instanceof Error &&
          [
            ...refused,
            "SessionMutationFactsUnavailableError",
            "SessionTranscriptReadFenceError",
            "MatrixPrivateAudienceReadError",
            "TimeoutError",
            "TypeError",
          ].includes(error.name)
        ? error.name
        : "unknown";
  runtime.log?.("matrix: related-history startup qualification failed", { phase, failureClass });
  return !refused.includes(failureClass);
}

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
  roomIds?: ReadonlySet<string>;
  scopeForRoom?(roomId: string): RoomScope | undefined;
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
  const published = readPublished
    ? { read: readPublished, matches: createRuntimeConfigSnapshotMatcher(cfg) }
    : undefined;
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
    const current = params.getRuntimeConfig();
    if (
      published
        ? getRuntimeConfigSnapshot() !== current || !published.matches(published.read())
        : current !== original || !isDeepStrictEqual(current, cfg)
    ) {
      throw new Error("Matrix startup conversation configuration changed");
    }
  };
  const observe = async <T>(phase: QualificationPhase, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      assertCurrent();
      if (reportQualificationFailure(params.runtime, phase, error)) {
        throw new StartupQualificationError();
      }
      throw error;
    }
  };
  assertCurrent();
  const account = resolveMatrixAccountConfig({ cfg, accountId: params.accountId });
  const selfUserId = await observe("account", () => params.client.getUserId());
  assertCurrent();
  const rooms = await observe("rooms", () => params.client.getJoinedRooms());
  assertCurrent();
  const allowFrom = await observe("allowlist", () =>
    resolveMatrixMonitorLiveUserAllowlist({
      cfg,
      accountId: params.accountId,
      entries: account.dm?.allowFrom,
      startupResolvedEntries: params.startupAllowFrom,
      runtime: params.runtime,
      failClosedOnUnresolved: true,
    }),
  );
  const groupAllowFrom = await observe("allowlist", () =>
    resolveMatrixMonitorLiveUserAllowlist({
      cfg,
      accountId: params.accountId,
      entries: account.groupAllowFrom,
      startupResolvedEntries: params.startupGroupAllowFrom,
      runtime: params.runtime,
      failClosedOnUnresolved: true,
    }),
  );
  assertCurrent();
  let retryNeeded = false;
  for (const roomId of new Set(rooms)) {
    assertCurrent();
    if (params.roomIds && !params.roomIds.has(roomId)) {
      continue;
    }
    const scope = params.scopeForRoom?.(roomId);
    if (params.scopeForRoom && !scope) {
      continue;
    }
    const check = () => {
      assertCurrent();
      scope?.assertCurrent();
    };
    let phase: QualificationPhase = "membership";
    try {
      const joinedMembers = await readJoinedMatrixMembers(params.client, roomId);
      check();
      // This helper returns null only after a failed read. Shared/empty membership
      // is an actual array and remains an ordinary refusal below.
      if (joinedMembers === null) {
        throw new StartupQualificationError();
      }
      if (joinedMembers?.length !== 2 || !joinedMembers.includes(selfUserId)) {
        continue;
      }
      const senderId = joinedMembers.find((member) => member !== selfUserId);
      if (!senderId || !isMatrixQualifiedUserId(senderId)) {
        continue;
      }
      phase = "privacy";
      const privateAudience = await params.directTracker.preparePrivateAudience({
        roomId,
        senderId,
        throwOnReadError: true,
      });
      check();
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
      check();
      phase = "route";
      const roomInfo = await params.getRoomInfo(roomId);
      check();
      const room = resolveMatrixRoomConfig({
        roomId,
        aliases: [roomInfo.canonicalAlias, ...(roomInfo.altAliases ?? [])].filter(
          (alias): alias is string => typeof alias === "string" && alias.length > 0,
        ),
        rooms: account.groups ?? account.rooms,
      });
      if (
        resolveMatrixEndpointPolicy({
          isDirectMessage,
          dmEnabled: account.dm?.enabled,
          dmPolicy: account.dm?.policy,
          groupPolicy: params.groupPolicy,
          room,
        })
      ) {
        continue;
      }
      const { route, bindingOwnerAvailable } = await resolveMatrixInboundRouteAsync({
        cfg,
        accountId: params.accountId,
        roomId,
        senderId,
        isDirectMessage,
        dmSessionScope: account.dm?.sessionScope,
        resolveAgentRoute: params.core.channel.routing.resolveAgentRoute,
      });
      check();
      if (!bindingOwnerAvailable) {
        continue;
      }
      phase = "ingress";
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
      check();
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
      check();
      if (ingress.ingress.admission !== "dispatch") {
        continue;
      }
      phase = "registration";
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
        assertCurrent: check,
        signal: scope?.signal ?? params.signal,
        retainCleanup: (close) => params.retainCleanup(close),
        onRootPreparationState: scope ? (state) => scope.onState(state) : undefined,
      });
      check();
    } catch (error) {
      assertCurrent();
      if (scope?.signal.aborted) {
        continue;
      }
      if (reportQualificationFailure(params.runtime, phase, error)) {
        scope?.failed();
        retryNeeded = true;
      }
    }
  }
  if (retryNeeded) {
    throw new StartupQualificationError();
  }
}

/** The existing account task owner coalesces endpoint requalification, not transcript work. */
export function createMatrixStartupRootPreparation(
  params: Omit<
    Parameters<typeof prepareMatrixStartupConversationRoots>[0],
    "roomIds" | "scopeForRoom"
  > & {
    runTask(task: () => Promise<void>): Promise<void>;
  },
) {
  const scopes = new Map<string, { controller: AbortController; state: RootState }>();
  let all = false;
  const pending = new Set<string>();
  let running: Promise<void> | undefined;
  let retryController: AbortController | undefined;
  let retrySleeping = false;
  let closed = params.signal.aborted;
  const report = (state: RootState | "pass-complete") => {
    const counts = { registered: 0, prepared: 0, unavailable: 0 };
    for (const scope of scopes.values()) {
      if (scope.state !== "invalidated") {
        counts[scope.state]++;
      }
    }
    params.runtime.log?.("matrix: related-history startup state", { state, ...counts });
  };
  const schedule = () => {
    if (closed || running || params.signal.aborted) {
      return;
    }
    const controller = new AbortController();
    retryController = controller;
    const retrySignal = AbortSignal.any([params.signal, controller.signal]);
    const task = params.runTask(async () => {
      try {
        while (all || pending.size > 0) {
          if (closed || retrySignal.aborted) {
            break;
          }
          params.assertCurrent();
          const roomIds = all ? undefined : new Set(pending);
          all = false;
          pending.clear();
          await retryAsync(
            () =>
              prepareMatrixStartupConversationRoots({
                ...params,
                roomIds,
                scopeForRoom(roomId) {
                  if (scopes.has(roomId)) {
                    return undefined;
                  }
                  const scope: { controller: AbortController; state: RootState } = {
                    controller: new AbortController(),
                    state: "unavailable",
                  };
                  scopes.set(roomId, scope);
                  const signal = AbortSignal.any([params.signal, scope.controller.signal]);
                  return {
                    signal,
                    failed() {
                      if (!signal.aborted && scopes.get(roomId) === scope) {
                        scope.controller.abort();
                        scopes.delete(roomId);
                      }
                    },
                    assertCurrent() {
                      signal.throwIfAborted();
                      params.assertCurrent();
                      if (scopes.get(roomId) !== scope) {
                        throw new Error("Matrix startup endpoint generation changed");
                      }
                    },
                    onState(state) {
                      if (signal.aborted || scopes.get(roomId) !== scope) {
                        return;
                      }
                      if (state === "invalidated") {
                        report(state);
                        request(roomId);
                      } else if (scope.state !== state) {
                        scope.state = state;
                        report(state);
                      }
                    },
                  };
                },
              }),
            {
              attempts: 4,
              minDelayMs: 1_000,
              maxDelayMs: 8_000,
              jitter: 0,
              shouldRetry: (error) =>
                error instanceof StartupQualificationError && !retrySignal.aborted,
              sleep: async (ms) => {
                retrySleeping = true;
                try {
                  await sleepWithAbort(ms, retrySignal);
                } finally {
                  retrySleeping = false;
                }
              },
              onRetry: ({ attempt, delayMs }) => {
                retrySleeping = true;
                params.runtime.log?.("matrix: related-history startup qualification retry", {
                  attempt,
                  delayMs,
                });
              },
            },
          );
          params.assertCurrent();
          report("pass-complete");
        }
      } catch {
        if (!retrySignal.aborted) {
          params.runtime.log?.("matrix: related-history startup qualification deferred");
        }
      }
    });
    running = task;
    void task
      .finally(() => {
        if (running === task) {
          running = undefined;
          retryController = undefined;
          retrySleeping = false;
        }
        if (all || pending.size > 0) {
          schedule();
        }
      })
      .catch(() => {});
  };
  const request = (roomId?: string) => {
    if (closed || params.signal.aborted) {
      return;
    }
    if (retrySleeping) {
      retryController?.abort();
    }
    if (roomId === undefined) {
      for (const scope of scopes.values()) {
        scope.controller.abort();
      }
      scopes.clear();
      all = true;
    } else {
      scopes.get(roomId)?.controller.abort();
      scopes.delete(roomId);
      pending.add(roomId);
    }
    schedule();
  };
  const unsubscribeConfig = closed ? () => {} : params.core.config.subscribe(() => request());
  params.signal.addEventListener(
    "abort",
    () => {
      closed = true;
      retryController?.abort();
      unsubscribeConfig();
      for (const scope of scopes.values()) {
        scope.controller.abort();
      }
      scopes.clear();
      pending.clear();
      all = false;
    },
    { once: true },
  );
  return { request };
}
