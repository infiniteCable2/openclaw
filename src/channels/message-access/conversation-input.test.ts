import { describe, expect, it } from "vitest";
import { getCommandOwnerAuthority } from "../../auto-reply/command-owner-authority.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { sessionParticipantInput } from "../../sessions/session-participant-input.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  prepareConversationReplyContext,
} from "../../talk/conversation-input-admission.js";
import type { ConversationInputScopeV1 } from "../../talk/conversation-input.types.js";
import {
  readConversationBindingRouteFacts,
  withConversationBindingRouteFacts,
} from "../conversation-binding-route-facts.js";
import type { ChannelIngressAdmissionScope } from "./admission-evidence-scope-key.js";
import {
  createChannelAdmissionAudit,
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
  readChannelContextGatewayContextResolver,
} from "./admission-evidence.js";
import type { ChannelConversationInputContextFacts } from "./conversation-input.types.js";
import { createHostChannelIngressRuntime, resolveStableChannelIngressPolicy } from "./runtime.js";

const input: ConversationInputScopeV1 = {
  agentId: "researcher",
  conversationId: "call-alpha",
  inputId: "utterance-alpha",
  purpose: "user",
};

async function prepareSource() {
  let ownerLive = true;
  let transportLive = true;
  const gateway = {
    getRuntimeConfig: () => ({}),
    channelAdmissionAudit: createChannelAdmissionAudit({ enabled: true }),
  } as GatewayRequestContext;
  let currentGateway: GatewayRequestContext | undefined = gateway;
  const owner = {
    channelId: "example",
    isLive: () => ownerLive,
    resolveGatewayContext: () => currentGateway,
  };
  const runtime = createHostChannelIngressRuntime(owner);
  const scope: ChannelIngressAdmissionScope = {
    channelId: "example",
    accountId: "primary",
    rawPrincipalRef: "person-alpha",
    conversation: { kind: "direct", id: "room-alpha" },
    binding: {
      agentId: input.agentId,
      sessionKey: "agent:researcher:example:peer:person-alpha",
      messageId: input.inputId,
      nativeChannelId: "room-alpha",
      inboundEventKind: "user_request",
    },
  };
  const request = {
    channelId: scope.channelId,
    accountId: scope.accountId,
    subject: { stableId: scope.rawPrincipalRef },
    conversation: scope.conversation,
    contextBinding: scope.binding,
    dmPolicy: "allowlist" as const,
    allowFrom: ["person-alpha"],
    event: { kind: "conversation" as const, authMode: "inbound" as const, mayPair: false },
    useDefaultPairingStore: false,
  };
  const route = withConversationBindingRouteFacts(
    { agentId: input.agentId, sessionKey: "agent:researcher:example:room-alpha" },
    { kind: "none" },
    input.agentId,
    { channel: "example", accountId: "primary", conversationId: "room-alpha" },
  );
  const context: ChannelConversationInputContextFacts = {
    channel: "example",
    accountId: "primary",
    from: "example:person-alpha",
    sender: { id: "person-alpha", name: "Example person" },
    conversation: { kind: "direct", id: "room-alpha", nativeChannelId: "room-alpha" },
    route: {
      ...route,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: scope.binding.sessionKey,
    },
    reply: { to: "room-alpha", nativeChannelId: "room-alpha" },
    access: { toolPolicy: { allow: ["read"] } },
  };
  const ingress = await runtime.resolveStable(request);
  expect(ingress.ingress.admission).toBe("dispatch");
  const assertCurrent = () => {
    if (!transportLive) throw new Error("Transport closed");
  };
  return {
    runtime,
    ingress,
    scope,
    request,
    context,
    owner,
    assertCurrent,
    closeTransport: () => {
      transportLive = false;
    },
    revokeOwner: () => {
      ownerLive = false;
    },
    replaceGateway: () => {
      currentGateway = { ...gateway };
    },
  };
}

describe("host channel conversation input", () => {
  it("uses real ingress admission without promoting participant identity to operator rights", async () => {
    const source = await prepareSource();
    const capability = source.runtime.conversation.admitInput({ ...source, input });
    const admitted = consumeConversationInputAdmission(capability, input);
    expect(admitted).not.toHaveProperty("prepareContext");
    expect(admitted.source).toEqual({
      channelId: "example",
      accountId: "primary",
      sessionKey: source.scope.binding.sessionKey,
      nativeChannelId: "room-alpha",
    });
    expect(admitted.participant).toMatchObject({
      identity: { type: "observation", id: "person-alpha" },
      promptedAt: expect.any(Number),
    });
    expect(admitted.principal).toBeUndefined();
    expect(admitted.requesterProfile).toBeUndefined();
    expect(admitted.operatorAuthority).toBeUndefined();
    expect(admitted.assertOwnerCurrent).toBeUndefined();
    expect(admitted).not.toHaveProperty("spawnedBy");
    expect(admitted).not.toHaveProperty("readSource");
    expect(() => source.runtime.conversation.admitInput({ ...source, input })).toThrow();
  });

  it("does not accept a policy-only result as a host capability", async () => {
    const source = await prepareSource();
    const ingress = await resolveStableChannelIngressPolicy(source.request);
    expect(ingress.ingress.admission).toBe("dispatch");
    expect(() => source.runtime.conversation.admitInput({ ...source, ingress, input })).toThrow();
    const genuine = source.runtime.conversation.admitInput({ ...source, input });
    expect(consumeConversationInputAdmission(genuine, input).scope).toEqual(input);
  });

  it("does not turn a native policy denial into a conversation input", async () => {
    const source = await prepareSource();
    const ingress = await source.runtime.resolveStable({
      ...source.request,
      allowFrom: ["another-person"],
    });
    expect(ingress.ingress.admission).not.toBe("dispatch");
    expect(() => source.runtime.conversation.admitInput({ ...source, ingress, input })).toThrow();
  });

  it("rejects copied resolver output without consuming the genuine handoff", async () => {
    const source = await prepareSource();
    expect(() =>
      source.runtime.conversation.admitInput({
        ...source,
        input,
        ingress: { ...source.ingress },
      }),
    ).toThrow();
    const genuine = source.runtime.conversation.admitInput({ ...source, input });
    expect(consumeConversationInputAdmission(genuine, input).scope).toEqual(input);
  });

  it("admits each later input through fresh native policy resolution", async () => {
    const source = await prepareSource();
    const first = source.runtime.conversation.admitInput({ ...source, input });
    consumeConversationInputAdmission(first, input);
    const next = { ...input, inputId: "utterance-beta", purpose: "steering" as const };
    expect(() => source.runtime.conversation.admitInput({ ...source, input: next })).toThrow();
    const binding = { ...source.scope.binding, messageId: next.inputId };
    const ingress = await source.runtime.resolveStable({
      ...source.request,
      contextBinding: binding,
    });
    const second = source.runtime.conversation.admitInput({
      ...source,
      scope: { ...source.scope, binding },
      ingress,
      input: next,
    });
    expect(consumeConversationInputAdmission(second, next).scope).toEqual(next);
  });

  it("refuses an input whose transport closes before consumption", async () => {
    const source = await prepareSource();
    const capability = source.runtime.conversation.admitInput({ ...source, input });
    source.closeTransport();
    expect(() => consumeConversationInputAdmission(capability, input)).toThrow("Transport closed");
  });

  it.each(["revokeOwner", "replaceGateway"] as const)(
    "retains original source authorization after audio closes and refuses %s",
    async (change) => {
      const source = await prepareSource();
      const capability = source.runtime.conversation.admitInput({ ...source, input });
      const accepted = consumeConversationInputAdmission(capability, input);
      source.closeTransport();
      expect(() => accepted.assertInputCurrent()).toThrow("Transport closed");
      expect(() => accepted.assertCurrent()).not.toThrow();
      source[change]();
      expect(() => accepted.assertCurrent()).toThrow("unavailable");
    },
  );

  it("rejects an already aborted input without admitting work", async () => {
    const source = await prepareSource();
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      source.runtime.conversation.admitInput({
        ...source,
        input,
        signal: controller.signal,
      }),
    ).toThrow();
    const genuine = source.runtime.conversation.admitInput({ ...source, input });
    expect(consumeConversationInputAdmission(genuine, input).scope).toEqual(input);
  });

  it.each([undefined, "another-utterance"])(
    "refuses missing or mismatched original message identity %s before consuming ingress",
    async (messageId) => {
      const source = await prepareSource();
      expect(() =>
        source.runtime.conversation.admitInput({
          ...source,
          scope: { ...source.scope, binding: { ...source.scope.binding, messageId } },
          input,
        }),
      ).toThrow("unavailable");
      const admitted = consumeConversationInputAdmission(
        source.runtime.conversation.admitInput({ ...source, input }),
        input,
      );
      claimConversationInputExecution(admitted);
      const context = await prepareConversationReplyContext(admitted, {
        text: "Original identity",
      });
      expect(context.MessageSid).toBe(input.inputId);
    },
  );

  it("projects actual STT once with original binding, participant time, policy and consumed evidence", async () => {
    const source = await prepareSource();
    const capability = source.runtime.conversation.admitInput({ ...source, input });
    const admitted = consumeConversationInputAdmission(capability, input);
    claimConversationInputExecution(admitted);
    source.closeTransport();
    const context = await prepareConversationReplyContext(admitted, {
      text: "Continue my request.",
    });
    expect(context).toMatchObject({
      BodyForAgent: "Continue my request.",
      AgentId: input.agentId,
      SessionKey: source.scope.binding.sessionKey,
      ChatType: "direct",
      SenderId: "person-alpha",
      ConversationToolPolicy: { allow: ["read"] },
      CommandInterpretationSuppressed: true,
      Timestamp: admitted.participant?.promptedAt,
    });
    expect(readConversationBindingRouteFacts(context)).toBe(
      readConversationBindingRouteFacts(source.context.route),
    );
    expect(Reflect.get(context, sessionParticipantInput)).toEqual([
      { ...admitted.participant, recorded: false },
    ]);
    expect(getCommandOwnerAuthority(context)).toBeUndefined();
    expect(readChannelContextGatewayContextResolver(context)).toBe(
      source.owner.resolveGatewayContext,
    );
    expect(
      consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context)),
    ).toMatchObject({
      ingressState: "present",
      decisionCoverage: "enforced",
    });
    await expect(prepareConversationReplyContext(admitted, { text: "Replay" })).rejects.toThrow(
      "unavailable",
    );
  });

  it("refuses forged, unclaimed or retargeted context projections", async () => {
    const source = await prepareSource();
    const admitted = consumeConversationInputAdmission(
      source.runtime.conversation.admitInput({ ...source, input }),
      input,
    );
    await expect(
      prepareConversationReplyContext({ ...admitted }, { text: "Forged" }),
    ).rejects.toThrow("unavailable");
    await expect(
      prepareConversationReplyContext(admitted, { text: "Not yet claimed" }),
    ).rejects.toThrow("unavailable");
    claimConversationInputExecution(admitted);
    source.context.route.dispatchSessionKey = "agent:other:private";
    const context = await prepareConversationReplyContext(admitted, { text: "Original target" });
    expect(context.SessionKey).toBe(source.scope.binding.sessionKey);
  });

  it("pins nested original policy and display facts before delayed STT projection", async () => {
    const source = await prepareSource();
    const roles = ["member"];
    const routePeer = { kind: "direct" as const, id: "person-alpha" };
    const access = {
      commands: { authorized: false },
      toolPolicy: { allow: ["read"] },
      mentions: { canDetectMention: true, wasMentioned: false, mentionedUserIds: ["bot-alpha"] },
    };
    const channelContext = { sender: { id: "person-alpha", badges: ["original"] } };
    const admitted = consumeConversationInputAdmission(
      source.runtime.conversation.admitInput({
        ...source,
        context: {
          ...source.context,
          sender: { ...source.context.sender, roles },
          conversation: { ...source.context.conversation, routePeer },
          access,
          channelContext,
        },
        input,
      }),
      input,
    );
    roles.push("administrator");
    routePeer.id = "another-person";
    access.commands.authorized = true;
    access.toolPolicy.allow.push("exec");
    access.mentions.mentionedUserIds.push("another-bot");
    channelContext.sender.badges.push("changed");
    claimConversationInputExecution(admitted);
    const context = await prepareConversationReplyContext(admitted, { text: "Original facts" });
    expect(context).toMatchObject({
      MemberRoleIds: ["member"],
      ConversationRoutePeerId: "person-alpha",
      CommandAuthorized: false,
      ConversationToolPolicy: { allow: ["read"] },
      MentionedUserIds: ["bot-alpha"],
      ChannelContext: { sender: { id: "person-alpha", badges: ["original"] } },
    });
  });

  it.each(["sender", "conversation", "route"] as const)(
    "refuses mismatched canonical %s facts before consuming ingress",
    async (field) => {
      const source = await prepareSource();
      const context = {
        ...source.context,
        [field]:
          field === "sender"
            ? { id: "another-person" }
            : field === "conversation"
              ? { ...source.context.conversation, id: "another-room" }
              : { ...source.context.route, dispatchSessionKey: "agent:other:private" },
      };
      expect(() => source.runtime.conversation.admitInput({ ...source, context, input })).toThrow(
        "unavailable",
      );
      const genuine = source.runtime.conversation.admitInput({ ...source, input });
      expect(consumeConversationInputAdmission(genuine, input).scope).toEqual(input);
    },
  );
});
