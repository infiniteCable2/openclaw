import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  missingScopeErrorShape,
  validateNodeInvokeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { captureActiveEmbeddedRunPersonalToolParticipants } from "../../agents/embedded-agent-runner/run-state.js";
import { captureNodePairingGeneration } from "../../infra/device-pairing-node-state.js";
import {
  isAdminOnlyNodeInvokeCommand,
  isBrowserProxyNodeInvokeCommand,
  isPrivateGoENodeCommand,
  isPrivateNodeInvokeCommand,
  NODE_NETWORK_DEVICE_STOP_COMMAND,
} from "../../infra/node-commands.js";
import { awaitWithinDeadline, ABSOLUTE_DEADLINE_EXPIRED } from "../../utils/absolute-deadline.js";
import { isForbiddenBrowserProxyMutation } from "../node-browser-proxy-policy.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { applyPluginNodeInvokePolicy } from "../node-invoke-plugin-policy.js";
import { invokeNodeWithReadinessRetry } from "../node-invoke-readiness.js";
import { sanitizeNodeInvokeParamsForForwarding } from "../node-invoke-sanitize.js";
import { enqueuePendingNodeAction, removePendingNodeAction } from "../node-runtime-state.js";
import { captureNodeWakeLifecycle, releaseNodeWakeLifecycle } from "../node-wake-state.js";
import { ADMIN_SCOPE, hasGatewayAdminScope } from "../operator-scopes.js";
import { captureMatrixNodeCarrierDispatch } from "../server/matrix-node-carrier-authority.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import {
  captureGatewayClientUploadCommitGuard,
  GATEWAY_UPLOADS_DISABLED_CODE,
  GATEWAY_UPLOADS_DISABLED_MESSAGE,
} from "../upload-policy.js";
import { buildNodeCommandRejectionHint } from "./node-command-rejection-hint.js";
import { nodeInvokePolicy } from "./nodes-policy.js";
import { handleNodeInvokeProgress } from "./nodes.handlers.invoke-progress.js";
import { handleNodeInvokeResult } from "./nodes.handlers.invoke-result.js";
import {
  respondUnavailableOnNodeInvokeErrorWithProvenance,
  parseGatewayPayload,
} from "./nodes.helpers.js";
import {
  captureGoECallerAuthority,
  captureNodeSystemRunEventSource,
  isForwardedNodeInvokeApprovalAuthorityActive,
  resolveNodeInvokeRuntimeAuthorityError,
} from "./nodes.invoke-authority.js";
import { shouldQueueAsPendingForegroundAction } from "./nodes.invoke-foreground.js";
import { emitTalkPttNodeEvent } from "./nodes.invoke-talk-events.js";
import { toPendingParamsJSON } from "./nodes.pending.js";
import { publishNodePermissionMissing } from "./nodes.permission-missing.js";
import {
  isNodePairingWorkCurrent,
  resolveDispatchableNodeSession,
  respondPairingChanged,
} from "./nodes.shared.js";
import { wakeNodeForReconnect } from "./nodes.wake-reconnect.js";
import { maybeSendNodeWakeNudge, maybeWakeNodeWithApns } from "./nodes.wake.js";
import { respondError, respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const nodeInvokeHandlers: GatewayRequestHandlers = {
  "node.invoke": async ({
    params,
    respond,
    context,
    client,
    req,
    signal,
    hasCurrentClientAuthority,
    sessionMutationCommitGuard,
  }) => {
    if (!assertValidParams(params, validateNodeInvokeParams, "node.invoke", respond)) {
      return;
    }
    const p = params;
    const nodeId = normalizeOptionalString(p.nodeId) ?? "";
    const command = normalizeOptionalString(p.command) ?? "";
    let sessionKey = normalizeOptionalString(p.sessionKey);
    // Only the authenticated agent bridge can bind completion delivery. Payload
    // route hints are approval replay metadata, not source-conversation authority.
    let turnSource = client?.internal?.agentRuntimeIdentity
      ? {
          channel: p.turnSourceChannel,
          to: p.turnSourceTo,
          accountId: p.turnSourceAccountId,
          threadId: p.turnSourceThreadId,
        }
      : undefined;
    const assertUploadAllowed = captureGatewayClientUploadCommitGuard({
      method: "node.invoke",
      requestParams: p,
      client,
      context,
    });
    const isUploadAllowed = () => {
      try {
        assertUploadAllowed?.();
        return true;
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          return false;
        }
        throw error;
      }
    };
    const rejectDisabledUpload = () => {
      if (isUploadAllowed()) {
        return false;
      }
      respondError(respond, ErrorCodes.FORBIDDEN, GATEWAY_UPLOADS_DISABLED_MESSAGE, {
        details: { code: GATEWAY_UPLOADS_DISABLED_CODE },
      });
      return true;
    };
    if (rejectDisabledUpload()) {
      return;
    }
    const nodeInvokeStream =
      client?.internal?.syntheticClient === true && client.internal.pluginRuntimeOwnerId
        ? client.internal.nodeInvokeStream
        : undefined;
    if (!nodeId || !command) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "nodeId and command required");
      return;
    }
    if (isPrivateNodeInvokeCommand(command)) {
      respondError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "node.invoke does not allow private node controls",
        {
          details: { command },
        },
      );
      return;
    }
    if (command === "system.execApprovals.get" || command === "system.execApprovals.set") {
      respondError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "node.invoke does not allow system.execApprovals.*; use exec.approvals.node.*",
        { details: { command } },
      );
      return;
    }
    if (nodeInvokePolicy.rejectUnsupportedRequest(command, p.params, respond)) {
      return;
    }
    const privateGoE = isPrivateGoENodeCommand(command);
    const identity = client?.internal?.agentRuntimeIdentity;
    const isGoECallerCurrent = privateGoE
      ? captureGoECallerAuthority(client, sessionMutationCommitGuard)
      : undefined;
    if (isGoECallerCurrent?.() === false) {
      respondError(
        respond,
        ErrorCodes.FORBIDDEN,
        "go-e command requires an active go-e plugin invocation",
      );
      return;
    }
    if (isBrowserProxyNodeInvokeCommand(command) && isForbiddenBrowserProxyMutation(p.params)) {
      respondError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        `node.invoke cannot mutate persistent browser profiles via ${command}`,
        { details: { command } },
      );
      return;
    }
    if (isAdminOnlyNodeInvokeCommand(command) && !hasGatewayAdminScope(client)) {
      respond(
        false,
        undefined,
        missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
      );
      return;
    }
    const invokeDeadlineAtMs =
      typeof p.timeoutMs === "number" && p.timeoutMs > 0
        ? performance.now() + p.timeoutMs
        : undefined;
    const withinInvokeDeadline = <T>(operation: () => Promise<T>) =>
      awaitWithinDeadline(operation, invokeDeadlineAtMs, () => performance.now());
    const respondWithInvocationResult = (
      result: { payload?: unknown; payloadJSON?: string | null },
      responsePayload: "original" | "decoded",
      isMatrixDispatchCurrent?: () => boolean,
    ) => {
      if (isMatrixDispatchCurrent?.() === false) {
        respondError(respond, ErrorCodes.FORBIDDEN, "Matrix node invoke authority closed");
        return;
      }
      const payload = result.payloadJSON ? parseGatewayPayload(result.payloadJSON) : result.payload;
      emitTalkPttNodeEvent({ context, nodeId, command, payload });
      respond(
        true,
        {
          ok: true,
          nodeId,
          command,
          payload: responsePayload === "decoded" ? payload : result.payload,
          payloadJSON: result.payloadJSON ?? null,
        },
        undefined,
      );
    };
    let nodeCommandDispatched = false;
    const resolveRemainingInvokeTimeoutMs = () =>
      invokeDeadlineAtMs === undefined
        ? p.timeoutMs
        : Math.max(0, invokeDeadlineAtMs - performance.now());
    const respondIfInvokeExpired = () => {
      if (invokeDeadlineAtMs === undefined || resolveRemainingInvokeTimeoutMs() !== 0) {
        return false;
      }
      respondUnavailableOnNodeInvokeErrorWithProvenance(
        respond,
        {
          ok: false,
          error: { code: "TIMEOUT", message: "node invoke timed out" },
        },
        { nodeCommandDispatched },
      );
      return true;
    };
    await respondUnavailableOnThrow(respond, async () => {
      const generation = await withinInvokeDeadline(() => captureNodePairingGeneration(nodeId));
      if (generation === ABSOLUTE_DEADLINE_EXPIRED) {
        respondIfInvokeExpired();
        return;
      }
      if (!generation) {
        respondPairingChanged(respond);
        return;
      }
      const wakeLifecycle = captureNodeWakeLifecycle(nodeId, generation.key);
      // Wake helpers identify their owner by the original signal. Compose the
      // caller only for dispatched node work; never replace that owner signal.
      const invocationLifecycle = signal ? AbortSignal.any([wakeLifecycle, signal]) : wakeLifecycle;
      let releaseApprovalHandoff: (() => void) | undefined;
      try {
        const continuePairingWork = async (): Promise<boolean> => {
          const pairingCurrent = await withinInvokeDeadline(() =>
            isNodePairingWorkCurrent({ nodeId, generation, lifecycle: wakeLifecycle }),
          );
          if (pairingCurrent === ABSOLUTE_DEADLINE_EXPIRED) {
            respondIfInvokeExpired();
            return false;
          }
          if (pairingCurrent) {
            return true;
          }
          respondPairingChanged(respond);
          return false;
        };

        if (respondIfInvokeExpired()) {
          return;
        }

        const cfg = context.getRuntimeConfig();
        let nodeSession = resolveDispatchableNodeSession(
          context.nodeRegistry.getForPairingGeneration(nodeId, generation.key),
        );
        if (!nodeSession) {
          const wakeReqId = req.id;
          const wakeFlowStartedAtMs = Date.now();
          context.logGateway.info(
            `node wake start node=${nodeId} req=${wakeReqId} command=${command}`,
          );

          // Wake attempts can be shared; each stage retains this caller's deadline.
          for (const force of [false, true]) {
            const wake = await wakeNodeForReconnect({
              nodeId,
              context,
              cfg,
              generation,
              lifecycle: wakeLifecycle,
              requestId: wakeReqId,
              source: "invoke",
              force,
              deadlineAtMs: invokeDeadlineAtMs,
            });
            if (wake === ABSOLUTE_DEADLINE_EXPIRED) {
              respondIfInvokeExpired();
              return;
            }
            if (!(await continuePairingWork()) || respondIfInvokeExpired()) {
              return;
            }
            nodeSession = resolveDispatchableNodeSession(
              context.nodeRegistry.getForPairingGeneration(nodeId, generation.key),
            );
            if (nodeSession || !wake.available) {
              break;
            }
          }
          if (!nodeSession) {
            if (respondIfInvokeExpired()) {
              return;
            }
            const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
            const nudge = await withinInvokeDeadline(() =>
              maybeSendNodeWakeNudge(nodeId, {
                cfg,
                lifecycle: wakeLifecycle,
                generation,
              }),
            );
            if (nudge === ABSOLUTE_DEADLINE_EXPIRED) {
              respondIfInvokeExpired();
              return;
            }
            if (!(await continuePairingWork())) {
              return;
            }
            context.logGateway.info(
              `node wake nudge node=${nodeId} req=${wakeReqId} sent=${nudge.sent} ` +
                `throttled=${nudge.throttled} reason=${nudge.reason} durationMs=${nudge.durationMs} ` +
                `apnsStatus=${nudge.apnsStatus ?? -1} apnsReason=${nudge.apnsReason ?? "-"}`,
            );
            context.logGateway.warn(
              `node wake done node=${nodeId} req=${wakeReqId} connected=false ` +
                `reason=not_connected totalMs=${totalDurationMs}`,
            );
            respondError(respond, ErrorCodes.UNAVAILABLE, "node not connected", {
              details: {
                code: "NOT_CONNECTED",
                nodeError: { code: "NOT_CONNECTED", message: "node not connected" },
                nodeCommandDispatched: false,
              },
            });
            return;
          }

          const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
          context.logGateway.info(
            `node wake done node=${nodeId} req=${wakeReqId} connected=true totalMs=${totalDurationMs}`,
          );
        }
        const matrixBinding = nodeSession.client?.matrixNodeCarrier;
        if (nodeInvokePolicy.rejectUnsupportedTransport(command, Boolean(matrixBinding), respond)) {
          return;
        }
        const connId = nodeSession.connId;
        let isNativeDispatchCurrent = () => isUploadAllowed();
        const isPrivateRequesterProfile = (profileId: string) =>
          identity !== undefined &&
          captureActiveEmbeddedRunPersonalToolParticipants(
            identity,
          )?.participants?.isPrivateRequesterProfile(profileId) === true;
        const privateRequester = matrixBinding?.privateRequester;
        const isGoEPrivateDispatchCurrent = () =>
          privateRequester?.isCurrent() === true &&
          isGoECallerCurrent?.() === true &&
          isPrivateRequesterProfile(privateRequester.profileId);
        const matrixDispatch =
          matrixBinding &&
          captureMatrixNodeCarrierDispatch({
            binding: matrixBinding,
            identity,
            validate: context.validateAgentRuntimeApprovalAuthority,
            nodeId,
            command,
            sessionKey,
            isPrivateRequesterProfile:
              privateRequester && identity ? isPrivateRequesterProfile : undefined,
            isRequestCurrent: () =>
              !invocationLifecycle.aborted &&
              (invokeDeadlineAtMs === undefined || performance.now() < invokeDeadlineAtMs) &&
              hasCurrentClientAuthority?.() !== false &&
              context.nodeRegistry.getForPairingGeneration(nodeId, generation.key)?.connId ===
                connId &&
              isNativeDispatchCurrent() &&
              (!privateGoE || isGoEPrivateDispatchCurrent()),
          });
        if (matrixBinding) {
          if (!matrixDispatch || !identity) {
            respondError(
              respond,
              ErrorCodes.FORBIDDEN,
              "Matrix node invoke requires a current admitted agent run for this room and node",
            );
            return;
          }
          sessionKey = identity.sessionKey;
          turnSource = {
            channel: identity.turnSourceChannel,
            to: identity.turnSourceTo,
            accountId: identity.turnSourceAccountId,
            threadId: identity.turnSourceThreadId,
          };
        }
        const authorizeNodeCommand = (
          session: NonNullable<typeof nodeSession>,
          authorizationCfg: typeof cfg,
        ): boolean => {
          const allowlist = resolveNodeCommandAllowlist(authorizationCfg, {
            ...session,
            approvedCommands: session.commands,
          });
          const allowed = isNodeCommandAllowed({
            command,
            declaredCommands: session.commands,
            allowlist,
          });
          if (!allowed.ok) {
            const hint = buildNodeCommandRejectionHint(
              allowed.reason,
              command,
              session,
              authorizationCfg,
            );
            respondError(respond, ErrorCodes.INVALID_REQUEST, hint, {
              details: { reason: allowed.reason, command },
            });
            return false;
          }
          return true;
        };
        // A reload may revoke authority for an in-flight request, but it must not
        // retroactively grant one that was denied when admitted before node wake.
        for (const authorizationCfg of [cfg, context.getRuntimeConfig()]) {
          if (!authorizeNodeCommand(nodeSession, authorizationCfg)) {
            return;
          }
        }

        const forwardedParams = await sanitizeNodeInvokeParamsForForwarding({
          nodeId,
          command,
          caps: nodeSession.caps,
          rawParams: p.params,
          client,
          execApprovalManager: context.execApprovalManager,
        });
        if (!forwardedParams.ok) {
          respondError(respond, ErrorCodes.INVALID_REQUEST, forwardedParams.message, {
            details: forwardedParams.details ?? null,
          });
          return;
        }
        if (respondIfInvokeExpired()) {
          return;
        }
        if (forwardedParams.approvalAuthority) {
          const authority = forwardedParams.approvalAuthority;
          releaseApprovalHandoff =
            context.execApprovalManager?.retainForHandoff(authority.recordId) ?? undefined;
          if (!releaseApprovalHandoff) {
            respondError(
              respond,
              ErrorCodes.INVALID_REQUEST,
              "approved runtime authority closed before node dispatch",
              { details: { code: "APPROVAL_AUTHORITY_CLOSED" } },
            );
            return;
          }
        }
        const runtimeAuthorityError = () =>
          resolveNodeInvokeRuntimeAuthorityError({
            context,
            client,
            approvalAuthority: forwardedParams.approvalAuthority,
          });
        isNativeDispatchCurrent = () =>
          isUploadAllowed() &&
          (nodeInvokeStream?.isRuntimeCurrent() ?? true) &&
          runtimeAuthorityError() === undefined;
        const isForwardedApprovalAuthorityActive = () =>
          isUploadAllowed() &&
          isForwardedNodeInvokeApprovalAuthorityActive({
            manager: context.execApprovalManager,
            authority: forwardedParams.approvalAuthority,
          });
        if (rejectDisabledUpload()) {
          return;
        }
        // These fixed commands use only the verified carrier and exact parameters.
        const invokeWithPluginPolicy = () =>
          withinInvokeDeadline(() =>
            applyPluginNodeInvokePolicy({
              context,
              client,
              nodeSession,
              command,
              params: forwardedParams.params,
              ...(sessionKey ? { sessionKey } : {}),
              turnSource: matrixBinding
                ? turnSource
                : {
                    channel: p.turnSourceChannel,
                    to: p.turnSourceTo,
                    accountId: p.turnSourceAccountId,
                    threadId: p.turnSourceThreadId,
                  },
              timeoutMs: p.timeoutMs,
              deadlineAtMs: invokeDeadlineAtMs,
              signal: invocationLifecycle,
              resolveRemainingTimeoutMs: resolveRemainingInvokeTimeoutMs,
              onNodeCommandDispatched: () => {
                // Deadline races must retain transport ownership so a command
                // already handed to the node is never advertised as retry-safe.
                nodeCommandDispatched = true;
              },
              idempotencyKey: p.idempotencyKey,
              matrixDispatch,
              isInvocationCurrent: async () =>
                (await isNodePairingWorkCurrent({
                  nodeId,
                  generation,
                  lifecycle: wakeLifecycle,
                })) && isUploadAllowed(),
              isApprovalAuthorityActive: isForwardedApprovalAuthorityActive,
              ...(nodeInvokeStream ? { nodeInvokeStream } : {}),
            }),
          );
        const policyResult = privateGoE ? undefined : await invokeWithPluginPolicy();
        if (policyResult === ABSOLUTE_DEADLINE_EXPIRED) {
          respondIfInvokeExpired();
          return;
        }
        if (!(await continuePairingWork())) {
          return;
        }
        if (policyResult) {
          // Plugin policies can satisfy an invocation without crossing the raw
          // node command channel; still emit mirrored Talk events for UI state.
          if (!policyResult.ok) {
            const permission = publishNodePermissionMissing({
              error: asOptionalObjectRecord(policyResult.details)?.nodeError,
              nodeId,
              nodeName: nodeSession.displayName,
              command,
              client,
              context,
            });
            const errorCode = policyResult.unavailable
              ? ErrorCodes.UNAVAILABLE
              : ErrorCodes.INVALID_REQUEST;
            respondError(respond, errorCode, permission?.message ?? policyResult.message, {
              details: {
                ...policyResult.details,
                ...(policyResult.code ? { code: policyResult.code } : {}),
                ...(permission ? { permissionMissing: permission.permissionMissing } : {}),
              },
            });
            return;
          }
          respondWithInvocationResult(policyResult, "original", matrixDispatch);
          return;
        }
        const dispatchSession = resolveDispatchableNodeSession(
          context.nodeRegistry.getForPairingGeneration(nodeId, generation.key),
        );
        if (!dispatchSession || dispatchSession.connId !== nodeSession.connId) {
          respondError(respond, ErrorCodes.UNAVAILABLE, "node connection changed before dispatch", {
            retryable: true,
            details: { code: "ROUTE_CHANGED" },
          });
          return;
        }
        if (!authorizeNodeCommand(dispatchSession, context.getRuntimeConfig())) {
          return;
        }
        const dispatchTimeoutMs = resolveRemainingInvokeTimeoutMs();
        if (invokeDeadlineAtMs !== undefined && dispatchTimeoutMs === 0) {
          respondIfInvokeExpired();
          return;
        }
        // Policy, pairing, and approval checks above may await. Revalidate the
        // exact runtime capability at the final raw transport handoff.
        const authorityError = runtimeAuthorityError();
        if (authorityError) {
          respondError(respond, ErrorCodes.INVALID_REQUEST, authorityError, {
            details: { code: "APPROVAL_AUTHORITY_CLOSED" },
          });
          return;
        }
        if (rejectDisabledUpload()) {
          return;
        }
        const dispatchRequest = {
          nodeId,
          expectedConnId: nodeSession.connId,
          expectedPairingGeneration: generation.key,
          command,
          params: forwardedParams.params,
          turnSource,
          prepareSystemRunEventSource: (key) =>
            captureNodeSystemRunEventSource({ client, context, hasCurrentClientAuthority }, key),
          timeoutMs: dispatchTimeoutMs,
          deadlineAtMs: invokeDeadlineAtMs,
          signal: invocationLifecycle,
          idempotencyKey: p.idempotencyKey,
          ...(sessionKey ? { sessionKey } : {}),
          ...(nodeInvokeStream && {
            onProgress: nodeInvokeStream.onProgress,
            idleTimeoutMs: nodeInvokeStream.idleTimeoutMs,
          }),
          isDispatchAuthorized: matrixDispatch ?? isNativeDispatchCurrent,
          onDispatchReady: (invokeId) => {
            nodeCommandDispatched = true;
            nodeInvokeStream?.onDispatchReady(invokeId);
          },
        } satisfies Parameters<typeof context.nodeRegistry.invoke>[0];
        // Do not send a second stop request if the first one was sent to the phone.
        const res =
          command === NODE_NETWORK_DEVICE_STOP_COMMAND
            ? await context.nodeRegistry.invoke(dispatchRequest)
            : await invokeNodeWithReadinessRetry(context.nodeRegistry, dispatchRequest);
        if (!(await continuePairingWork())) {
          return;
        }
        if (!res.ok) {
          if (
            shouldQueueAsPendingForegroundAction({
              platform: nodeSession.platform,
              command,
              error: res.error,
            }) &&
            // Pending actions outlive this RPC. Closure-bound agent or approval
            // authority cannot be transferred to a later device pull.
            !client?.internal?.agentRuntimeIdentity &&
            !forwardedParams.approvalAuthority
          ) {
            // Foreground-only iOS commands become pullable pending actions instead
            // of failing permanently while the device is locked/backgrounded.
            const paramsJSON = toPendingParamsJSON(forwardedParams.params);
            const queued = enqueuePendingNodeAction({
              nodeId,
              pairingGeneration: generation.key,
              command,
              paramsJSON,
              idempotencyKey: p.idempotencyKey,
              ttlMs: nodeInvokePolicy.pendingActionTtlMs,
              maxPerNode: nodeInvokePolicy.pendingActionMaxPerNode,
            });
            const wake = await withinInvokeDeadline(() =>
              maybeWakeNodeWithApns(nodeId, {
                cfg,
                lifecycle: wakeLifecycle,
                generation,
              }),
            );
            if (wake === ABSOLUTE_DEADLINE_EXPIRED || !(await continuePairingWork())) {
              if (wake === ABSOLUTE_DEADLINE_EXPIRED) {
                respondIfInvokeExpired();
              }
              if (queued.created) {
                removePendingNodeAction({
                  nodeId,
                  pairingGeneration: generation.key,
                  actionId: queued.action.id,
                  ttlMs: nodeInvokePolicy.pendingActionTtlMs,
                });
              }
              return;
            }
            context.logGateway.info(
              `node pending queued node=${nodeId} req=${req.id} command=${command} ` +
                `queuedId=${queued.action.id} wakePath=${wake.path} wakeAvailable=${wake.available}`,
            );
            respondError(
              respond,
              ErrorCodes.UNAVAILABLE,
              "node command queued until iOS returns to foreground",
              {
                retryable: true,
                details: {
                  code: "QUEUED_UNTIL_FOREGROUND",
                  queuedActionId: queued.action.id,
                  nodeId,
                  command,
                  wake: {
                    path: wake.path,
                    available: wake.available,
                    throttled: wake.throttled,
                    apnsStatus: wake.apnsStatus,
                    apnsReason: wake.apnsReason,
                  },
                  nodeError: res.error ?? null,
                },
              },
            );
            return;
          }
          respondUnavailableOnNodeInvokeErrorWithProvenance(respond, res, {
            nodeCommandDispatched,
            ...publishNodePermissionMissing({
              error: res.error,
              nodeId,
              nodeName: nodeSession.displayName,
              command,
              client,
              context,
            }),
          });
          return;
        }
        respondWithInvocationResult(res, "decoded", matrixDispatch);
      } finally {
        releaseApprovalHandoff?.();
        releaseNodeWakeLifecycle(nodeId, wakeLifecycle);
      }
    });
  },
  "node.invoke.progress": handleNodeInvokeProgress,
  "node.invoke.result": handleNodeInvokeResult,
};
