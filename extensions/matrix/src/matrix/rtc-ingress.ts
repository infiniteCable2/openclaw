import type { CallMembership } from "matrix-js-sdk/lib/matrixrtc/CallMembership.js";
import {
  defineStableChannelIngressIdentity,
  type ConversationInputSourceV1,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveAgentSpeechConversationRoute } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { cloneRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { findMatrixAccountEntry, hasImplicitMatrixAccountConfig } from "../account-selection.js";
import {
  resolveMatrixAccountAllowlistConfig,
  resolveMatrixAccountConfig,
} from "./account-config.js";
import { normalizeMatrixUserId } from "./monitor/allowlist.js";
import {
  resolveMatrixMonitorLiveUserAllowlist,
  type MatrixResolvedAllowlistEntry,
} from "./monitor/config.js";
import type { createDirectRoomTracker } from "./monitor/direct.js";
import { resolveMatrixInboundRoute } from "./monitor/route.js";
import { findMatrixRtcAdmission, resolveMatrixRtcConfig } from "./rtc-config.js";
import { resolveMatrixSenderParticipant } from "./sender-identity.js";
import { isMatrixQualifiedUserId } from "./target-ids.js";

// SDK CallMembership parsing checks the Matrix event sender against member.user_id.
// This is account identity, not a claim that the device is cross-signing verified.
const rtcIdentity = defineStableChannelIngressIdentity({
  key: "sender-id",
  authentication: "verified",
  normalize: (value) => normalizeMatrixUserId(value) || null,
  resolveParticipant: resolveMatrixSenderParticipant,
});

type MatrixRtcInputSourceParams = {
  runtime: PluginRuntime;
  runtimeEnv: RuntimeEnv;
  accountId: string;
  roomId: string;
  agentId: string;
  conversationId: string;
  sourceSessionKey: string;
  /** Final native conversation target, selected before any original input is admitted. */
  dispatchSessionKey: string;
  remoteMembership: Pick<CallMembership, "userId" | "deviceId" | "memberId" | "rtcBackendIdentity">;
  /** Revalidate the original SDK session, membership, slot and controller call incarnation. */
  assertCurrent: () => void;
  /** Account-owned room privacy, deliberately independent of the call's audio lifetime. */
  preparePrivateAudience: ReturnType<typeof createDirectRoomTracker>["preparePrivateAudience"];
  signal?: AbortSignal;
  startupResolvedEntries?: readonly MatrixResolvedAllowlistEntry[];
};

/**
 * Admit real RTC inputs without manufacturing a text message or delegator authority.
 * The controller must supply the SDK-validated membership and retain its exact live
 * call owner. This source does not make a raw Matrix ID proof of call membership.
 */
export function createMatrixRtcConversationInputSource(
  params: MatrixRtcInputSourceParams,
): ConversationInputSourceV1 {
  const {
    runtime,
    runtimeEnv,
    accountId,
    roomId,
    agentId,
    conversationId,
    sourceSessionKey,
    dispatchSessionKey,
    preparePrivateAudience,
    assertCurrent: assertCallCurrent,
    signal: callSignal,
  } = params;
  const senderId = params.remoteMembership.userId;
  const membership = params.remoteMembership;
  if (
    !isMatrixQualifiedUserId(senderId) ||
    !membership.deviceId.trim() ||
    !membership.memberId.trim() ||
    !membership.rtcBackendIdentity.trim() ||
    !accountId.trim() ||
    !roomId.trim() ||
    !agentId.trim() ||
    !conversationId.trim() ||
    !sourceSessionKey.trim() ||
    !dispatchSessionKey.trim()
  ) {
    throw new Error("MatrixRTC conversation input requires an exact admitted call binding");
  }
  const startupResolvedEntries = params.startupResolvedEntries?.map((entry) => ({ ...entry }));
  const assertTransportCurrent = () => {
    callSignal?.throwIfAborted();
    assertCallCurrent();
  };
  const selectCurrent = () => {
    assertTransportCurrent();
    // Existing account/routing consumers require an owned mutable projection.
    // Read and copy the exact live source each time, including in-place updates.
    const cfg = cloneRuntimeConfigSnapshot(runtime.config.current());
    if (
      !findMatrixAccountEntry(cfg, accountId) &&
      !hasImplicitMatrixAccountConfig(cfg, accountId)
    ) {
      throw new Error("MatrixRTC conversation input account is no longer available");
    }
    const account = resolveMatrixAccountConfig({ cfg, accountId });
    const rtc = resolveMatrixRtcConfig(account.rtc);
    const admission = rtc && findMatrixRtcAdmission(rtc, roomId);
    if (
      cfg.channels?.matrix?.enabled === false ||
      account.enabled === false ||
      account.dm?.enabled === false ||
      !admission ||
      admission.userId !== senderId ||
      admission.agentId !== agentId
    ) {
      throw new Error("MatrixRTC conversation input admission is no longer current");
    }
    const route = resolveMatrixInboundRoute({
      cfg,
      accountId,
      roomId,
      senderId,
      isDirectMessage: true,
      dmSessionScope: account.dm?.sessionScope,
      resolveAgentRoute: runtime.channel.routing.resolveAgentRoute,
    });
    // A normal runtime conversation binding is allowed. Other dispatch owners
    // cannot silently become an embedded speech agent through this V2 adapter.
    if (!route.bindingOwnerAvailable || route.configuredBinding || route.pluginId) {
      throw new Error("MatrixRTC conversation input uses an unsupported route owner");
    }
    if (route.route.agentId !== agentId || route.route.sessionKey !== sourceSessionKey) {
      throw new Error("MatrixRTC conversation input route changed");
    }
    const dispatch = resolveAgentSpeechConversationRoute({
      cfg,
      agentId,
      channel: "matrix",
      accountId,
      sourceSessionKey,
      conversationId,
    });
    if (dispatch.sessionKey !== dispatchSessionKey) {
      throw new Error("MatrixRTC conversation input dispatch target changed");
    }
    const allowlists = resolveMatrixAccountAllowlistConfig({ cfg, accountId });
    const rawPolicy = account.dm?.policy ?? "pairing";
    const dmPolicy = account.allowlistOnly && rawPolicy !== "disabled" ? "allowlist" : rawPolicy;
    // Compare only admission-affecting config, not unrelated live config changes.
    const policyKey = JSON.stringify({
      dmPolicy,
      allowFrom: allowlists.dmAllowFrom,
      dangerouslyAllowNameMatching: account.dangerouslyAllowNameMatching,
      accessGroups: cfg.accessGroups,
    });
    return { cfg, allowlists, dmPolicy, policyKey, route: route.route };
  };
  // Reject an unavailable account or incompatible dispatch owner before the
  // controller acquires speech providers. This does not admit a synthetic input.
  selectCurrent();
  const resolveAdmission = async (messageId?: string, inputSignal?: AbortSignal) => {
    const conversation = runtime.channel.inbound.ingress.conversation;
    if (!conversation || conversation.version !== 1) {
      throw new Error("MatrixRTC requires host conversation-input admission version 1");
    }
    const signal =
      callSignal && inputSignal
        ? AbortSignal.any([callSignal, inputSignal])
        : (inputSignal ?? callSignal);
    signal?.throwIfAborted();
    const selected = selectCurrent();
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (selectCurrent().policyKey !== selected.policyKey) {
        throw new Error("MatrixRTC conversation input policy changed");
      }
    };
    const allowFrom = await resolveMatrixMonitorLiveUserAllowlist({
      cfg: selected.cfg,
      accountId,
      entries: selected.allowlists.dmAllowFrom,
      startupResolvedEntries,
      runtime: runtimeEnv,
    });
    assertCurrent();
    const privateAudience = await preparePrivateAudience({ roomId, senderId });
    assertCurrent();
    const scope = {
      channelId: "matrix",
      accountId,
      rawPrincipalRef: senderId,
      conversation: { kind: "direct" as const, id: roomId },
      binding: {
        agentId,
        sessionKey: dispatchSessionKey,
        ...(messageId !== undefined ? { messageId } : {}),
        nativeChannelId: roomId,
        inboundEventKind: "user_request" as const,
      },
    };
    const ingress = await runtime.channel.inbound.ingress.resolve({
      channelId: scope.channelId,
      accountId,
      identity: rtcIdentity,
      subject: { stableId: senderId },
      conversation: scope.conversation,
      contextBinding: scope.binding,
      privateAudience,
      event: { kind: "conversation", authMode: "inbound", mayPair: false },
      policy: { dmPolicy: selected.dmPolicy, groupPolicy: "disabled" },
      accessGroups: selected.cfg.accessGroups,
      allowFrom,
      readStoreAllowFrom: async () => {
        assertCurrent();
        const entries = await runtime.channel.pairing.readAllowFromStore({
          channel: "matrix",
          accountId,
          env: process.env,
        });
        assertCurrent();
        return entries;
      },
    });
    assertCurrent();
    return { conversation, ingress, scope, selected, assertCurrent, signal };
  };
  return Object.freeze({
    version: 1 as const,
    async prepareConnection(options?: { signal?: AbortSignal }) {
      const prepare = runtime.channel.inbound.ingress.conversation?.prepareConnection;
      if (!prepare) {
        return;
      }
      const admitted = await resolveAdmission(undefined, options?.signal);
      await prepare({
        ingress: admitted.ingress,
        scope: admitted.scope,
        assertCurrent: admitted.assertCurrent,
        signal: admitted.signal,
      });
      admitted.assertCurrent();
    },
    async admitInput(input: Parameters<ConversationInputSourceV1["admitInput"]>[0]) {
      const { signal: inputSignal, ...scopeInput } = input;
      if (scopeInput.agentId !== agentId || scopeInput.conversationId !== conversationId) {
        throw new Error("MatrixRTC conversation input does not match its call binding");
      }
      const { conversation, ingress, scope, selected, assertCurrent, signal } =
        await resolveAdmission(scopeInput.inputId, inputSignal);
      return conversation.admitInput({
        ingress,
        scope,
        input: scopeInput,
        context: {
          channel: "matrix",
          accountId,
          from: senderId,
          sender: { id: senderId },
          conversation: {
            kind: "direct",
            id: roomId,
            nativeChannelId: roomId,
            routePeer: { kind: "direct", id: senderId },
          },
          route: {
            ...selected.route,
            routeSessionKey: selected.route.sessionKey,
            dispatchSessionKey,
          },
          reply: { to: roomId, nativeChannelId: roomId },
        },
        assertCurrent,
        signal,
      });
    },
  });
}
