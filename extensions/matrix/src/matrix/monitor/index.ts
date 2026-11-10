import { format } from "node:util";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveChannelStreamingBlockEnabled,
  waitUntilAbort,
} from "openclaw/plugin-sdk/channel-outbound";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import {
  resolvePromptHistoryLimit,
  resolveOptionalIntegerOption,
} from "openclaw/plugin-sdk/number-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "openclaw/plugin-sdk/thread-bindings-runtime";
import { getMatrixRuntime, getMatrixRuntimeLifecycle } from "../../runtime.js";
import type {
  CoreConfig,
  MatrixStreamingConfig,
  MatrixStreamingMode,
  ReplyToMode,
} from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import { resolveConfiguredMatrixBotUserIds } from "../accounts.js";
import {
  acquireSharedMatrixClient,
  backfillMatrixAuthDeviceIdAfterStartup,
  resolveMatrixAuth,
  resolveMatrixAuthContext,
  type SharedMatrixClientLease,
} from "../client.js";
import { resolveMatrixRtcConfig } from "../rtc-config.js";
import type { MatrixClient } from "../sdk.js";
import { isMatrixStartupAbortError } from "../startup-abort.js";
import {
  isMatrixDisconnectedSyncState,
  isMatrixReadySyncState,
  isMatrixTerminalSyncState,
  type MatrixSyncState,
} from "../sync-state.js";
import { createMatrixThreadBindingManager } from "../thread-bindings.js";
import { registerMatrixAutoJoin } from "./auto-join.js";
import { resolveMatrixMonitorConfig } from "./config.js";
import { createDirectRoomTracker } from "./direct.js";
import { registerMatrixMonitorEvents } from "./events.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { createMatrixIngressMonitor } from "./ingress.js";
import { shouldPromoteRecentInviteRoom } from "./recent-invite.js";
import { createMatrixRoomInfoResolver } from "./room-info.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { createMatrixStartupRootPreparation } from "./startup-history.js";
import { runMatrixStartupMaintenance } from "./startup.js";
import { createMatrixMonitorStatusController } from "./status.js";
import { createMatrixMonitorTaskRunner, getMatrixMonitorTaskSignal } from "./task-runner.js";

type MonitorMatrixOpts = {
  runtime?: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  initialSyncLimit?: number;
  replyToMode?: ReplyToMode;
  accountId?: string | null;
  setStatus?: (next: import("openclaw/plugin-sdk/channel-contract").ChannelAccountSnapshot) => void;
};

type MatrixStreamingInput = MatrixStreamingConfig | undefined;

function resolveMatrixStreamingMode(streaming: MatrixStreamingInput): MatrixStreamingMode {
  const mode = streaming?.mode;
  if (mode === "partial" || mode === "quiet" || mode === "progress") {
    return mode;
  }
  return "off";
}

function resolveMatrixPreviewToolProgressEnabled(streaming: MatrixStreamingInput): boolean {
  const mode = resolveMatrixStreamingMode(streaming);
  if (mode === "off") {
    return false;
  }
  if (mode === "progress") {
    // Progress drafts are quiet unless the operator opts into the tool log.
    return streaming?.progress?.toolProgress ?? streaming?.preview?.toolProgress ?? false;
  }
  return streaming?.preview?.toolProgress ?? true;
}

function formatSyncLifecycleError(state: MatrixSyncState, error?: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  const message = typeof error === "string" && error.trim() ? error.trim() : undefined;
  if (state === "STOPPED") {
    return new Error(message ?? "Matrix sync stopped unexpectedly");
  }
  return new Error(message ?? `Matrix sync entered ${state} unexpectedly`);
}

const DEFAULT_MEDIA_MAX_MB = 20;

export async function monitorMatrixProvider(opts: MonitorMatrixOpts = {}): Promise<void> {
  // Fast-cancel callers should not pay the full Matrix startup/import cost.
  if (opts.abortSignal?.aborted) {
    return;
  }
  const core = getMatrixRuntime();
  let cfg = core.config.current() as CoreConfig;
  if (cfg.channels?.["matrix"]?.enabled === false) {
    return;
  }

  const logger = core.logging.getChildLogger({ module: "matrix-auto-reply" });
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (...args) => {
      logger.info(format(...args));
    },
    error: (...args) => {
      logger.error(format(...args));
    },
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
  const logVerboseMessage = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    logger.debug?.(message);
  };

  const authContext = resolveMatrixAuthContext({
    cfg,
    accountId: opts.accountId,
  });
  const effectiveAccountId = authContext.accountId;

  const accountConfig = resolveMatrixAccountConfig({
    cfg,
    accountId: effectiveAccountId,
  });
  const rtcConfig = resolveMatrixRtcConfig(accountConfig.rtc);

  const allowlistOnly = accountConfig.allowlistOnly === true;
  const accountAllowBots = accountConfig.allowBots;
  let roomsConfig = accountConfig.groups ?? accountConfig.rooms;
  let needsRoomAliasesForConfig = false;
  const initialAllowFrom = (accountConfig.dm?.allowFrom ?? []).map(String);
  const initialGroupAllowFrom = (accountConfig.groupAllowFrom ?? []).map(String);

  const {
    allowFrom,
    allowFromResolvedEntries,
    groupAllowFrom,
    groupAllowFromResolvedEntries,
    roomsConfig: resolvedRoomsConfig,
  } = await resolveMatrixMonitorConfig({
    cfg,
    accountId: effectiveAccountId,
    allowFrom: initialAllowFrom,
    groupAllowFrom: initialGroupAllowFrom,
    roomsConfig,
    runtime,
  });
  roomsConfig = resolvedRoomsConfig;
  needsRoomAliasesForConfig = Boolean(
    roomsConfig && Object.keys(roomsConfig).some((key) => key.trim().startsWith("#")),
  );

  cfg = {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...cfg.channels?.["matrix"],
        dm: {
          ...cfg.channels?.["matrix"]?.dm,
          allowFrom,
        },
        groupAllowFrom,
        ...(roomsConfig ? { groups: roomsConfig } : {}),
      },
    },
  };

  const auth = await resolveMatrixAuth({ cfg, accountId: effectiveAccountId });
  if (opts.abortSignal?.aborted) {
    return;
  }
  const configuredBotUserIds = await resolveConfiguredMatrixBotUserIds({
    cfg,
    accountId: effectiveAccountId,
    abortSignal: opts.abortSignal,
  });
  if (opts.abortSignal?.aborted) {
    return;
  }
  const resolvedInitialSyncLimit =
    resolveOptionalIntegerOption(opts.initialSyncLimit, { min: 0 }) ?? auth.initialSyncLimit;
  const authWithLimit =
    resolvedInitialSyncLimit === auth.initialSyncLimit
      ? auth
      : { ...auth, initialSyncLimit: resolvedInitialSyncLimit };
  const statusController = createMatrixMonitorStatusController({
    accountId: auth.accountId,
    baseUrl: auth.homeserver,
    statusSink: opts.setStatus,
  });
  let cleanedUp = false;
  let cleanupPromise: Promise<void> | null = null;
  let client: MatrixClient | null = null;
  let clientLease: SharedMatrixClientLease | null = null;
  let monitorLifecycleSignal = opts.abortSignal;
  let threadBindingManager: { accountId: string; stop: () => Promise<void> } | null = null;
  let rtcController: ReturnType<
    typeof import("../rtc-controller.js").registerMatrixRtcController
  > | null = null;
  const monitorTaskRunner = createMatrixMonitorTaskRunner({
    logger,
    logVerboseMessage,
  });
  let disposeAutoJoin = () => {};
  let disposeMonitorEvents = () => {};
  let directTracker: ReturnType<typeof createDirectRoomTracker> | undefined;
  let disposeSyncIngress = () => {};
  let ingress: ReturnType<typeof createMatrixIngressMonitor> | undefined;
  let fatalError: Error | null = null;
  let resolveFatalWait: (() => void) | null = null;
  let rejectFatalWait: ((error: Error) => void) | null = null;
  const isStopping = () => cleanedUp || monitorLifecycleSignal?.aborted === true;
  let monitorSetupClosed = false;
  const cleanup = (mode: "persist" | "stop" = "persist"): Promise<void> => {
    if (cleanupPromise) {
      return cleanupPromise;
    }
    cleanedUp = true;
    directTracker?.dispose();
    cleanupPromise = (async () => {
      try {
        await rtcController?.stop({ waitForCleanup: true });
        await clientLease?.release({ mode });
      } finally {
        statusController.markStopped();
      }
    })();
    return cleanupPromise;
  };

  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy: groupPolicyRaw, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.["matrix"] !== undefined,
      groupPolicy: accountConfig.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "matrix",
    accountId: effectiveAccountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (message) => logVerboseMessage(message),
  });
  const groupPolicy = allowlistOnly && groupPolicyRaw === "open" ? "allowlist" : groupPolicyRaw;
  const replyToMode = opts.replyToMode ?? accountConfig.replyToMode ?? "off";
  const threadReplies = accountConfig.threadReplies ?? "inbound";
  const dmThreadReplies = accountConfig.dm?.threadReplies;
  const threadBindingIdleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel({
    cfg,
    channel: "matrix",
    accountId: effectiveAccountId,
  });
  const threadBindingMaxAgeMs = resolveThreadBindingMaxAgeMsForChannel({
    cfg,
    channel: "matrix",
    accountId: effectiveAccountId,
  });
  const dmConfig = accountConfig.dm;
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicyRaw = dmConfig?.policy ?? "pairing";
  const dmPolicy = allowlistOnly && dmPolicyRaw !== "disabled" ? "allowlist" : dmPolicyRaw;
  const dmSessionScope = dmConfig?.sessionScope ?? "per-user";
  const historyLimit = resolvePromptHistoryLimit(
    accountConfig.historyLimit ?? cfg.messages?.groupChat?.historyLimit,
    0,
  );
  const mediaMaxMb = opts.mediaMaxMb ?? accountConfig.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const mediaMaxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const streaming = resolveMatrixStreamingMode(accountConfig.streaming);
  const previewToolProgressEnabled = resolveMatrixPreviewToolProgressEnabled(
    accountConfig.streaming,
  );
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(accountConfig) === true;
  const startupMs = Date.now();
  const warnedEncryptedRooms = new Set<string>();
  const warnedCryptoMissingRooms = new Set<string>();
  let healthySyncSinceMs: number | undefined;
  let rootPreparation: AbortController | undefined;
  let startRootPreparation = () => {};
  let requestRootPreparation = (_roomId?: string) => {};
  const onDirectRoomsChanged = () =>
    directTracker?.invalidatePrivateAudiences(undefined, "routing-change");
  const onSyncState = (state: MatrixSyncState) => {
    const at = Date.now();
    if (isMatrixReadySyncState(state)) {
      if (healthySyncSinceMs === undefined) {
        healthySyncSinceMs = at;
        startRootPreparation();
      }
      return;
    }
    if (isMatrixDisconnectedSyncState(state)) {
      healthySyncSinceMs = undefined;
      rootPreparation?.abort();
      rootPreparation = undefined;
      requestRootPreparation = () => {};
      directTracker?.invalidatePrivateAudiences();
    }
  };
  const settleFatal = (error: Error) => {
    if (fatalError) {
      return;
    }
    fatalError = error;
    rejectFatalWait?.(error);
    resolveFatalWait = null;
    rejectFatalWait = null;
  };

  const onSyncLifecycleState = (
    state: MatrixSyncState,
    _prevState: string | null,
    error?: unknown,
  ) => {
    if (isMatrixTerminalSyncState(state) && !isStopping()) {
      const fatalErrorLocal = formatSyncLifecycleError(state, error);
      statusController.noteUnexpectedError(fatalErrorLocal);
      settleFatal(fatalErrorLocal);
      return;
    }
    // Fatal sync failures are sticky for telemetry; later SDK state churn during
    // cleanup or reconnect should not overwrite the first recorded error.
    if (fatalError) {
      return;
    }
    // Operator-initiated shutdown can still emit transient sync states before
    // the final STOPPED. Ignore that churn so intentional stops do not look
    // like runtime failures.
    if (isStopping() && !isMatrixTerminalSyncState(state)) {
      return;
    }
    statusController.noteSyncState(state, error);
  };

  const onUnexpectedSyncError = (error: Error) => {
    if (isStopping()) {
      return;
    }
    statusController.noteUnexpectedError(error);
    settleFatal(error);
  };

  const monitorRetirement = {
    closeTaskAdmission: () => {
      monitorSetupClosed = true;
      rootPreparation?.abort();
      directTracker?.dispose();
      monitorTaskRunner.close();
    },
    detachListeners: () => {
      disposeAutoJoin();
      disposeMonitorEvents();
      disposeSyncIngress();
      client?.off("sync.state", onSyncState);
      client?.off("direct.rooms.changed", onDirectRoomsChanged);
      resolveFatalWait?.();
      resolveFatalWait = null;
      rejectFatalWait = null;
      client?.off("sync.state", onSyncLifecycleState);
      client?.off("sync.unexpected_error", onUnexpectedSyncError);
    },
    waitForTasks: async () => {
      await ingress?.stop();
      await monitorTaskRunner.waitForIdle();
    },
    cleanup: async () => {
      await rtcController?.stop({ waitForCleanup: true });
      await threadBindingManager?.stop();
    },
  };

  try {
    clientLease = await acquireSharedMatrixClient({
      cfg,
      auth: authWithLimit,
      accountId: auth.accountId,
      abortSignal: opts.abortSignal,
      role: "monitor",
    });
    client = clientLease.client;
    monitorLifecycleSignal = opts.abortSignal
      ? AbortSignal.any([opts.abortSignal, clientLease.abortSignal])
      : clientLease.abortSignal;
    clientLease.registerMonitorRetirement(monitorRetirement);
    client.on("sync.state", onSyncLifecycleState);
    client.on("sync.unexpected_error", onUnexpectedSyncError);
    client.on("sync.state", onSyncState);
    client.on("direct.rooms.changed", onDirectRoomsChanged);
    const { getRoomInfo, getMemberDisplayName, invalidateMemberDisplayName, invalidateRoomName } =
      createMatrixRoomInfoResolver(client);
    const isExplicitlyConfiguredRoom = async (roomId: string): Promise<boolean> => {
      const roomInfoForConfig = needsRoomAliasesForConfig
        ? await getRoomInfo(roomId, { includeAliases: true })
        : undefined;
      const aliases = roomInfoForConfig
        ? [roomInfoForConfig.canonicalAlias ?? "", ...roomInfoForConfig.altAliases].filter(Boolean)
        : [];
      return (
        resolveMatrixRoomConfig({
          rooms: roomsConfig,
          roomId,
          aliases,
        }).matchSource === "direct"
      );
    };
    const canPromoteRecentInvite = async (roomId: string) =>
      shouldPromoteRecentInviteRoom({
        roomId,
        roomInfo: await getRoomInfo(roomId, { includeAliases: true }),
        rooms: roomsConfig,
      });
    directTracker = createDirectRoomTracker(client, {
      log: logVerboseMessage,
      isCurrent: () =>
        !cleanedUp && !monitorSetupClosed && monitorLifecycleSignal?.aborted !== true,
      isAudienceCurrent: () => healthySyncSinceMs !== undefined,
      onAudienceInvalidated: (roomId) => requestRootPreparation(roomId),
      isExplicitlyConfiguredRoom,
      canPromoteRecentInvite,
      canPromoteUnmappedStrictRoom:
        dmSessionScope === "per-room" ? canPromoteRecentInvite : undefined,
      shouldKeepLocallyPromotedDirectRoom: async (roomId) => {
        try {
          const roomInfo = await getRoomInfo(roomId, { includeAliases: true });
          if (!roomInfo.nameResolved || !roomInfo.aliasesResolved) {
            return undefined;
          }
          return shouldPromoteRecentInviteRoom({
            roomId,
            roomInfo,
            rooms: roomsConfig,
          });
        } catch (err) {
          logVerboseMessage(
            `matrix: local promotion revalidation failed room=${roomId} (${String(err)})`,
          );
          return undefined;
        }
      },
    });
    const rootTracker = directTracker;
    const rootClient = client;
    startRootPreparation = () => {
      if (rootPreparation || monitorSetupClosed || cleanedUp) {
        return;
      }
      const controller = new AbortController();
      rootPreparation = controller;
      const signal = AbortSignal.any([
        controller.signal,
        ...(monitorLifecycleSignal ? [monitorLifecycleSignal] : []),
      ]);
      const preparation = createMatrixStartupRootPreparation({
        client: rootClient,
        core,
        runtime,
        accountId: effectiveAccountId,
        groupPolicy,
        directTracker: rootTracker,
        startupAllowFrom: allowFromResolvedEntries,
        startupGroupAllowFrom: groupAllowFromResolvedEntries,
        getRuntimeConfig: () => core.config.current(),
        getRoomInfo: (roomId) => getRoomInfo(roomId, { includeAliases: true }),
        signal,
        assertCurrent() {
          signal.throwIfAborted();
          if (
            rootPreparation !== controller ||
            cleanedUp ||
            monitorSetupClosed ||
            healthySyncSinceMs === undefined
          ) {
            throw new Error("Matrix startup conversation account is no longer current");
          }
        },
        retainCleanup: (close) => monitorTaskRunner.retainCleanup(close),
        runTask: (task) =>
          monitorTaskRunner.runDetachedTask("related-history startup", async () => {
            await task().catch((error: unknown) => {
              if (!signal.aborted) {
                throw error;
              }
            });
          }),
      });
      requestRootPreparation = preparation.request;
      preparation.request();
    };
    disposeAutoJoin = registerMatrixAutoJoin({
      client,
      accountConfig,
      runtime,
      runDetachedTask: monitorTaskRunner.runDetachedTask,
    });
    const handleRoomMessage = createMatrixRoomMessageHandler({
      client,
      core,
      cfg,
      accountId: effectiveAccountId,
      accountConfig,
      runtime,
      logger,
      logVerboseMessage,
      allowFrom,
      allowFromResolvedEntries,
      groupAllowFrom,
      groupAllowFromResolvedEntries,
      roomsConfig,
      accountAllowBots,
      configuredBotUserIds,
      groupPolicy,
      replyToMode,
      threadReplies,
      dmThreadReplies,
      dmSessionScope,
      streaming,
      previewToolProgressEnabled,
      blockStreamingEnabled,
      dmEnabled,
      dmPolicy,
      mediaMaxBytes,
      historyLimit,
      directTracker,
      getRoomInfo,
      getMemberDisplayName,
      needsRoomAliasesForConfig,
    });
    const createdThreadBindingManager = await createMatrixThreadBindingManager({
      cfg,
      accountId: effectiveAccountId,
      auth,
      client,
      env: process.env,
      idleTimeoutMs: threadBindingIdleTimeoutMs,
      maxAgeMs: threadBindingMaxAgeMs,
      logVerboseMessage,
    });
    if (monitorSetupClosed) {
      await createdThreadBindingManager.stop();
      await cleanup("stop");
      return;
    }
    threadBindingManager = createdThreadBindingManager;
    logVerboseMessage(
      `matrix: thread bindings ready account=${threadBindingManager.accountId} idleMs=${threadBindingIdleTimeoutMs} maxAgeMs=${threadBindingMaxAgeMs}`,
    );

    disposeMonitorEvents = registerMatrixMonitorEvents({
      cfg,
      client,
      auth,
      allowFrom,
      dmEnabled,
      dmPolicy,
      readStoreAllowFrom: async () =>
        await core.channel.pairing
          .readAllowFromStore({
            channel: "matrix",
            env: process.env,
            accountId: effectiveAccountId,
          })
          .catch(() => []),
      directTracker,
      groupPolicy,
      roomsConfig,
      needsRoomAliasesForConfig,
      getRoomInfo,
      invalidateMemberDisplayName,
      invalidateRoomName,
      logVerboseMessage,
      warnedEncryptedRooms,
      warnedCryptoMissingRooms,
      logger,
      getHealthySyncSinceMs: () => healthySyncSinceMs,
      formatNativeDependencyHint: core.system.formatNativeDependencyHint,
      runDetachedTask: monitorTaskRunner.runDetachedTask,
    });

    if (rtcConfig) {
      const runInBackgroundContext = getMatrixRuntimeLifecycle()?.runInBackgroundContext;
      if (!runInBackgroundContext) {
        throw new Error("MatrixRTC requires an instance-bound background runtime");
      }
      const { registerMatrixRtcController } = await import("../rtc-controller.js");
      rtcController = registerMatrixRtcController({
        client,
        accountConfig,
        accountId: effectiveAccountId,
        config: rtcConfig,
        runtime: core,
        runInBackgroundContext,
        runtimeEnv: runtime,
        logger,
        abortSignal: monitorLifecycleSignal,
        preparePrivateAudience: directTracker.preparePrivateAudience,
      });
    }
    ingress = createMatrixIngressMonitor({
      accountId: effectiveAccountId,
      client,
      startupMs,
      dispatch: (roomId, event, lifecycle) =>
        monitorTaskRunner.runTask(() => handleRoomMessage(roomId, event, lifecycle)),
      onError: (error) => logger.warn("matrix ingress failed", { error: String(error) }),
    });
    disposeSyncIngress = await client.bindSyncIngress(ingress.admitSync);

    // Register Matrix thread bindings before the client starts syncing so threaded
    // commands during startup never observe Matrix as "unavailable".
    logVerboseMessage("matrix: starting client");
    await clientLease.start(monitorLifecycleSignal);
    if (monitorSetupClosed) {
      await cleanup("stop");
      return;
    }
    ingress.start();
    logVerboseMessage("matrix: client started");
    rtcController?.startExisting();

    logger.info(`matrix: logged in as ${auth.userId}`);
    void monitorTaskRunner.runDetachedTask("deviceId backfill", async () => {
      const taskSignal = getMatrixMonitorTaskSignal();
      await backfillMatrixAuthDeviceIdAfterStartup({
        auth,
        env: process.env,
        abortSignal:
          taskSignal && monitorLifecycleSignal
            ? AbortSignal.any([taskSignal, monitorLifecycleSignal])
            : (taskSignal ?? monitorLifecycleSignal),
      });
    });

    registerChannelRuntimeContext({
      channelRuntime: opts.channelRuntime,
      channelId: "matrix",
      accountId: effectiveAccountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      context: {
        client,
      },
      abortSignal: monitorLifecycleSignal,
    });

    await runMatrixStartupMaintenance({
      client,
      auth,
      accountId: effectiveAccountId,
      effectiveAccountId,
      accountConfig,
      logger,
      logVerboseMessage,
      getRuntimeConfig: () => core.config.current() as CoreConfig,
      replaceConfigFile: async (nextCfg) => {
        await core.config.replaceConfigFile({
          nextConfig: nextCfg,
          afterWrite: { mode: "auto" },
        });
      },
      loadWebMedia: async (url, maxBytes) => await core.media.loadWebMedia(url, maxBytes),
      env: process.env,
      abortSignal: monitorLifecycleSignal,
    });
    if (monitorSetupClosed) {
      await cleanup("stop");
      return;
    }
    statusController.markStartupComplete();

    await Promise.race([
      waitUntilAbort(monitorLifecycleSignal, async () => {
        try {
          logVerboseMessage("matrix: stopping client");
          await cleanup();
        } catch (err) {
          logger.warn("matrix: failed during monitor shutdown cleanup", {
            error: String(err),
          });
        }
      }),
      new Promise<void>((resolve, reject) => {
        if (fatalError) {
          reject(fatalError);
        } else {
          resolveFatalWait = resolve;
          rejectFatalWait = reject;
        }
      }),
    ]);
    await cleanup();
  } catch (err) {
    if (monitorSetupClosed || (monitorLifecycleSignal?.aborted && isMatrixStartupAbortError(err))) {
      await cleanup("stop");
      return;
    }
    statusController.noteUnexpectedError(err);
    await cleanup();
    throw err;
  }
}
