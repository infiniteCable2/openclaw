import { listAgentIds } from "../agents/agent-scope-config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { buildHostChannelInboundEventContext } from "../channels/inbound-event/context.js";
import {
  isNodeCommandAllowed,
  resolveNodeCommandAllowlist,
} from "../gateway/node-command-policy.js";
import type { NodeSession } from "../gateway/node-session.types.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { isPairedDeviceNodeBindingCurrent } from "../infra/device-pairing-node-state.js";
import { resolveAgentConversationRoute } from "../routing/conversation-mode.js";
import { prepareSessionParticipantInput } from "../sessions/session-participant-input.js";
import {
  createConversationInputAdmission,
  ConversationInputAdmissionError,
} from "../talk/conversation-input-admission.js";
import type {
  PluginNodeConversationInputRequestV1,
  PluginNodeConversationInputV1,
} from "./plugin-registration.types.js";

type ConversationNode = Pick<
  NodeSession,
  | "nodeId"
  | "connId"
  | "pairingIdentity"
  | "pairingGeneration"
  | "commands"
  | "caps"
  | "platform"
  | "deviceFamily"
> & { client: Pick<NodeSession["client"], "invalidated"> };
type ConversationNodeContext = Pick<GatewayRequestContext, "getRuntimeConfig"> & {
  nodeRegistry: {
    getCurrentConnected(nodeId: string): Promise<ConversationNode | undefined>;
    get(nodeId: string): ConversationNode | undefined;
  };
};

/** A native service owns the source; IDs supplied by a plugin never stand in for pairing. */
export async function preparePluginServiceNodeConversationInput(params: {
  request: PluginNodeConversationInputRequestV1;
  pluginId: string;
  context: ConversationNodeContext;
  assertServiceCurrent(): void;
  bindContext(context: MsgContext, assertCurrent: () => void): void;
}): Promise<PluginNodeConversationInputV1> {
  const {
    nodeId,
    command,
    agentId,
    conversationId,
    label,
    signal,
    assertAssigned,
    assertInputCurrent: assertBridgeCurrent,
  } = params.request;
  const { pluginId, context, assertServiceCurrent, bindContext } = params;
  if ([nodeId, command, agentId, conversationId, label].some((value) => !value.trim())) {
    throw new ConversationInputAdmissionError();
  }
  assertServiceCurrent();
  signal?.throwIfAborted();
  const nodeRegistry = context.nodeRegistry;
  const node = await nodeRegistry.getCurrentConnected(nodeId);
  assertServiceCurrent();
  if (
    !node ||
    node.nodeId !== nodeId ||
    !node.pairingIdentity ||
    !node.commands.includes(command)
  ) {
    throw new ConversationInputAdmissionError();
  }
  const pairing = Object.freeze({
    identity: node.pairingIdentity,
    generation: node.pairingGeneration,
  });
  const config = context.getRuntimeConfig();
  const conversation = resolveAgentConversationRoute({
    cfg: config,
    agentId,
    channel: pluginId,
    accountId: nodeId,
    peer: { kind: "group", id: `node:${nodeId}:speech:${conversationId}` },
    dmScope: "per-account-channel-peer",
    groupScope: "per-group",
  });
  let accepting = true;
  const assertCurrent = () => {
    assertServiceCurrent();
    const current = context.getRuntimeConfig();
    assertAssigned(current);
    if (
      context.nodeRegistry !== nodeRegistry ||
      !listAgentIds(current).includes(agentId) ||
      current.session?.scope === "global" ||
      !isPairedDeviceNodeBindingCurrent(nodeId, pairing) ||
      !isNodeCommandAllowed({
        command,
        declaredCommands: node.commands,
        allowlist: resolveNodeCommandAllowlist(current, node),
      }).ok
    ) {
      throw new ConversationInputAdmissionError();
    }
    const selected = resolveAgentConversationRoute({
      cfg: current,
      agentId,
      channel: pluginId,
      accountId: nodeId,
      peer: { kind: "group", id: `node:${nodeId}:speech:${conversationId}` },
      dmScope: "per-account-channel-peer",
      groupScope: "per-group",
    });
    if (selected.sessionKey !== conversation.sessionKey || selected.mode !== conversation.mode) {
      throw new ConversationInputAdmissionError();
    }
  };
  const assertInputCurrent = () => {
    assertCurrent();
    signal?.throwIfAborted();
    assertBridgeCurrent();
    if (
      !accepting ||
      nodeRegistry.get(nodeId) !== node ||
      node.client.invalidated ||
      !node.commands.includes(command)
    ) {
      throw new ConversationInputAdmissionError();
    }
  };
  assertInputCurrent();
  const inputSource: PluginNodeConversationInputV1["inputSource"] = Object.freeze({
    version: 1,
    async admitInput(
      scope: Parameters<PluginNodeConversationInputV1["inputSource"]["admitInput"]>[0],
    ) {
      scope.signal?.throwIfAborted();
      assertInputCurrent();
      if (scope.agentId !== agentId || scope.conversationId !== conversationId) {
        throw new ConversationInputAdmissionError();
      }
      const admittedScope = Object.freeze({
        agentId,
        conversationId,
        inputId: scope.inputId,
        purpose: scope.purpose,
      });
      const promptedAt = Date.now();
      const identity = Object.freeze({
        type: "observation" as const,
        pluginId,
        accountId: nodeId,
        senderKind: "unknown" as const,
        id: nodeId,
      });
      return createConversationInputAdmission({
        scope: admittedScope,
        source: {
          channelId: pluginId,
          accountId: nodeId,
          sessionKey: conversation.sessionKey,
          nativeChannelId: nodeId,
        },
        participant: { identity, promptedAt },
        assertCurrent,
        assertInputCurrent,
        async prepareContext(text) {
          assertCurrent();
          const context = buildHostChannelInboundEventContext({
            channel: pluginId,
            accountId: nodeId,
            channelIngress: "unsupported",
            messageId: admittedScope.inputId,
            timestamp: promptedAt,
            from: `node:${nodeId}`,
            sender: { id: nodeId, displayLabel: "Unidentified device speaker" },
            conversation: {
              kind: "group",
              id: conversationId,
              label,
              nativeChannelId: nodeId,
              routePeer: { kind: "group", id: `node:${nodeId}:speech:${conversationId}` },
            },
            route: {
              agentId,
              accountId: nodeId,
              routeSessionKey: conversation.sessionKey,
              mainSessionKey: conversation.rootSessionKey,
            },
            reply: { to: nodeId, nativeChannelId: nodeId },
            message: { rawBody: text, sourceModality: "audio", inboundEventKind: "user_request" },
            access: { commands: { authorized: false } },
          });
          prepareSessionParticipantInput(context, identity, promptedAt);
          context.CommandInterpretationSuppressed = true;
          bindContext(context, assertCurrent);
          assertCurrent();
          return context;
        },
      });
    },
  });
  return Object.freeze({
    inputSource,
    agentId,
    conversationId,
    sessionKey: conversation.sessionKey,
    assertCurrent,
    assertInputCurrent,
    connectionPresentation: Object.freeze({
      kind: "assistant",
      channel: pluginId,
      label,
      readTarget: Object.freeze({ agentId, sessionKey: conversation.sessionKey }),
      input: Object.freeze({ audio: true }),
      output: Object.freeze({ audio: true }),
      operations: Object.freeze(["current-turn-reply"] as const),
      assertCurrent: assertInputCurrent,
    }),
    release() {
      accepting = false;
    },
  });
}
