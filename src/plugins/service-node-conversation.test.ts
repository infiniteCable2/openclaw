import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindHostConversationContextGatewayResolver } from "../channels/message-access/admission-evidence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionParticipantInput } from "../sessions/session-participant-input.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  prepareConversationReplyContext,
} from "../talk/conversation-input-admission.js";
import { preparePluginServiceNodeConversationInput } from "./service-node-conversation.js";

const pairing = vi.hoisted(() => ({ current: true }));
// The native pairing owner is the permission boundary, not a plugin-provided boolean.
vi.mock("../infra/device-pairing-node-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing-node-state.js")>()),
  isPairedDeviceNodeBindingCurrent: () => pairing.current,
}));

function fixture() {
  const state = { live: true, service: true, bridge: true, assigned: true };
  const config: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { example: { conversationMode: "branches" } } },
    gateway: { nodes: { commands: { allow: ["example.audio"] } } },
  };
  const node = {
    nodeId: "paired-node",
    connId: "original-connection",
    pairingIdentity: "original-pairing",
    pairingGeneration: "generation",
    client: { invalidated: false },
    commands: ["example.audio"],
    caps: [],
  };
  const scope = {
    agentId: "example",
    conversationId: "conversation",
    inputId: "input",
    purpose: "user" as const,
  };
  const params: Parameters<typeof preparePluginServiceNodeConversationInput>[0] = {
    pluginId: "example-assistant",
    context: {
      getRuntimeConfig: () => config,
      nodeRegistry: {
        getCurrentConnected: async () => (state.live ? node : undefined),
        get: () => (state.live ? node : undefined),
      },
    },
    assertServiceCurrent() {
      if (!state.service) throw new Error("Service revoked");
    },
    bindContext(context, assertCurrent) {
      // Only identity is observed here; the real service provides its complete native Gateway.
      bindHostConversationContextGatewayResolver({
        context,
        assertCurrent,
        resolveGatewayContext: () => params.context as never,
      });
    },
    request: {
      nodeId: node.nodeId,
      command: "example.audio",
      agentId: scope.agentId,
      conversationId: scope.conversationId,
      label: "Shared room assistant",
      assertAssigned() {
        if (!state.assigned) throw new Error("Assignment revoked");
      },
      assertInputCurrent() {
        if (!state.bridge) throw new Error("Bridge closed");
      },
    },
  };
  return { state, config, node, scope, params };
}

describe("service-owned paired device conversation input", () => {
  beforeEach(() => {
    pairing.current = true;
  });

  it("requires the actual current paired connection, not matching plugin-supplied IDs", async () => {
    const f = fixture();
    f.state.live = false;
    await expect(preparePluginServiceNodeConversationInput(f.params)).rejects.toThrow("admission");
    f.state.live = true;
    pairing.current = false;
    await expect(preparePluginServiceNodeConversationInput(f.params)).rejects.toThrow("admission");
  });

  it("projects real admitted speech as an unidentified shared-device conversation, never private main", async () => {
    const f = fixture();
    const source = await preparePluginServiceNodeConversationInput(f.params);
    const admission = await source.inputSource.admitInput(f.scope);
    const input = consumeConversationInputAdmission(admission, f.scope);
    claimConversationInputExecution(input);
    const context = await prepareConversationReplyContext(input, {
      text: "Please tell me the time.",
    });
    expect(context).toMatchObject({
      AgentId: "example",
      ChatType: "group",
      SourceModality: "audio",
      CommandAuthorized: false,
      CommandInterpretationSuppressed: true,
      SessionKey: source.sessionKey,
    });
    expect(context.SessionKey).not.toBe("agent:example:main");
    expect(context.ParentSessionKey).toBeUndefined();
    expect(context.ModelParentSessionKey).toBeUndefined();
    expect(input.principal).toBeUndefined();
    expect(input.operatorAuthority).toBeUndefined();
    expect(input.assertOwnerCurrent).toBeUndefined();
    expect(Reflect.get(context, sessionParticipantInput)).toEqual([
      expect.objectContaining({
        identity: {
          type: "observation",
          pluginId: "example-assistant",
          accountId: f.node.nodeId,
          senderKind: "unknown",
          id: f.node.nodeId,
        },
      }),
    ]);
    expect(source.connectionPresentation.readTarget).toEqual({
      agentId: "example",
      sessionKey: source.sessionKey,
    });
    expect(source.connectionPresentation.operations).toEqual(["current-turn-reply"]);
    source.release();
  });

  it("closes input and availability immediately while accepted work retains original permission", async () => {
    const f = fixture();
    const source = await preparePluginServiceNodeConversationInput(f.params);
    const input = consumeConversationInputAdmission(
      await source.inputSource.admitInput(f.scope),
      f.scope,
    );
    claimConversationInputExecution(input);
    f.state.live = false;
    f.state.bridge = false;
    source.release();
    expect(() => source.connectionPresentation.assertCurrent()).toThrow("Bridge closed");
    await expect(source.inputSource.admitInput({ ...f.scope, inputId: "later" })).rejects.toThrow();
    expect(() => input.assertCurrent()).not.toThrow();
    await expect(
      prepareConversationReplyContext(input, { text: "Retained request" }),
    ).resolves.toMatchObject({
      Body: "Retained request",
    });
    pairing.current = false;
    expect(() => input.assertCurrent()).toThrow("admission");
  });

  it("rechecks pairing, command, assignment and original service instead of upgrading device authority", async () => {
    const f = fixture();
    const source = await preparePluginServiceNodeConversationInput(f.params);
    await expect(source.inputSource.admitInput({ ...f.scope, agentId: "other" })).rejects.toThrow(
      "admission",
    );
    f.state.assigned = false;
    expect(() => source.assertCurrent()).toThrow("Assignment revoked");
    f.state.assigned = true;
    f.config.gateway!.nodes!.commands!.deny = ["example.audio"];
    expect(() => source.assertCurrent()).toThrow("admission");
    f.config.gateway!.nodes!.commands!.deny = [];
    f.state.service = false;
    expect(() => source.assertCurrent()).toThrow("Service revoked");
    source.release();
  });
});
