import { expect, it, vi } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { readConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import { readSessionConversationParticipant } from "../../sessions/session-participant-input.js";
import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextParams,
} from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import {
  consumeChannelAdmissionEvidence,
  createChannelAdmissionAudit,
  readChannelContextAdmissionEvidence,
  readChannelContextGatewayContextResolver,
} from "./admission-evidence.js";
import type { ChannelParticipantInput } from "./ingress-host-owner.js";
import {
  bindPreparedChannelParticipantInputs,
  selectChannelConversationParticipant,
} from "./participant-input.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

const recordParticipant = vi.hoisted(() => vi.fn());
vi.mock("../../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: recordParticipant,
}));

it.each([
  "qualified",
  "mixed",
  "stale",
  "retargeted",
  "denied",
  "gateway-replaced-during-ingress",
  "gateway-replaced-during-context",
  "retired-during-context",
] as const)(
  "preserves accepted product identity and exact host ownership: %s",
  async (scenario) => {
    recordParticipant.mockClear();
    let live = true;
    const auditEnabled = scenario.includes("during");
    const audit = createChannelAdmissionAudit({ enabled: auditEnabled });
    let gateway = {
      getRuntimeConfig: () => ({}),
      channelAdmissionAudit: audit,
    } as GatewayRequestContext;
    const owner = {
      channelId: "test",
      isLive: () => live,
      resolveGatewayContext: () => gateway,
    };
    const resolveIngress = createHostChannelIngressRuntime(owner).resolveStable;
    const key = "agent:main:test:dm:conversation";
    const resolveParticipant = vi.fn((subject: { stableId?: string | number | null }) =>
      subject.stableId === "unknown"
        ? undefined
        : {
            domain: "workspace-one",
            idKind: "user-id",
            id: String(subject.stableId),
          },
    );
    try {
      const sources =
        scenario === "mixed" ? ["profile-collision", "unknown"] : ["profile-collision"];
      const ingress = [];
      const startedAt = Date.now();
      for (const sender of sources) {
        ingress.push(
          await resolveIngress({
            channelId: "test",
            accountId: "local",
            identity: { resolveParticipant },
            subject: { stableId: sender },
            conversation: { kind: "direct", id: "conversation" },
            contextBinding: {
              agentId: "main",
              sessionKey: key,
              messageId: sender,
              inboundEventKind: "user_request",
            },
            dmPolicy: scenario === "gateway-replaced-during-ingress" ? "pairing" : "open",
            groupPolicy: "disabled",
            allowFrom: scenario === "denied" ? [] : ["*"],
            useDefaultPairingStore: false,
            readStoreAllowFrom: async () => {
              await Promise.resolve();
              if (scenario === "gateway-replaced-during-ingress") {
                gateway = Object.assign({}, gateway);
              }
              return [];
            },
          }),
        );
      }
      expect(resolveParticipant).toHaveBeenCalledTimes(sources.length);
      expect(ingress[0]?.ingress.admission).toBe(scenario === "denied" ? "drop" : "dispatch");
      live = scenario !== "stale";
      const context = await createHostChannelInboundEventContextBuilder(
        async (params: BuildChannelInboundEventContextParams) => {
          await Promise.resolve();
          if (scenario === "gateway-replaced-during-context") {
            gateway = Object.assign({}, gateway);
          }
          if (scenario === "retired-during-context") {
            live = false;
          }
          return buildChannelInboundEventContext(params);
        },
        owner,
      )({
        channel: "test",
        accountId: "local",
        messageId: sources.at(-1),
        from: "test:conversation",
        sender: { id: sources.at(-1) },
        conversation: { kind: "direct", id: "conversation" },
        route: {
          agentId: "main",
          routeSessionKey: scenario === "retargeted" ? "agent:main:other" : key,
        },
        reply: { to: "test:conversation" },
        message: { rawBody: "hello" },
        channelIngress: ingress,
      });
      const target = { agentId: "main", sessionKey: key, storePath: "/unused" };
      recordAcceptedSessionParticipantInput({ ...context }, target);
      recordAcceptedSessionParticipantInput(context, target);
      if (scenario === "qualified" || scenario === "mixed") {
        expect(recordParticipant).toHaveBeenCalledTimes(sources.length);
        expect(recordParticipant).toHaveBeenNthCalledWith(1, {
          ...target,
          identity: {
            type: "remote",
            pluginId: "test",
            domain: "workspace-one",
            idKind: "user-id",
            id: "profile-collision",
          },
          promptedAt: expect.any(Number),
        });
        expect(recordParticipant.mock.calls[0]?.[0].promptedAt).toBeGreaterThanOrEqual(startedAt);
        if (scenario === "mixed") {
          expect(recordParticipant).toHaveBeenNthCalledWith(2, {
            ...target,
            identity: {
              type: "observation",
              pluginId: "test",
              accountId: "local",
              senderKind: "unknown",
              id: "unknown",
            },
            promptedAt: expect.any(Number),
          });
        }
      } else {
        expect(recordParticipant).not.toHaveBeenCalled();
      }
      if (auditEnabled) {
        expect(
          consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context)),
        ).toMatchObject({ ingressState: "unknown" });
        expect(readChannelContextGatewayContextResolver(context)).toBeUndefined();
      } else {
        expect(readChannelContextAdmissionEvidence(context)).toBeUndefined();
      }
      expect(ingress[0]).not.toHaveProperty("participant");
    } finally {
      live = false;
      audit.close();
    }
  },
);

function privateLinkedParticipant() {
  let current = true;
  let outputOpen = true;
  const gateway = { getRuntimeConfig: () => ({}) } as GatewayRequestContext;
  const owner = {
    channelId: "example",
    isLive: () => true,
    resolveGatewayContext: () => gateway,
  };
  const input: ChannelParticipantInput = {
    identity: {
      type: "remote",
      pluginId: "example",
      domain: "example.test",
      idKind: "user-id",
      id: "remote-alpha",
    },
    binding: {
      agentId: "main",
      sessionKey: "agent:main:example:peer:alpha",
      nativeChannelId: "private-alpha",
      messageId: "message-alpha",
      inboundEventKind: "user_request",
    },
    verifiedPrincipal: { channelId: "example", accountId: "default", senderId: "remote-alpha" },
    requesterProfile: { id: "person-alpha", displayName: null, isCurrent: () => current },
    privateAudience: {
      assertCurrent: () => {
        if (!outputOpen) {
          throw new Error("Private output closed");
        }
      },
    },
    promptedAt: 1,
    owner,
    gatewayContext: gateway,
  };
  return {
    input,
    revoke: () => (current = false),
    closeOutput: () => (outputOpen = false),
  };
}

it.each(["shared", "unlinked", "unverified", "observation"] as const)(
  "preserves original transport participants without a private linked person: %s",
  (scenario) => {
    const { input } = privateLinkedParticipant();
    if (scenario === "shared") {
      input.privateAudience = undefined;
    } else if (scenario === "unlinked") {
      input.requesterProfile = undefined;
    } else if (scenario === "unverified") {
      input.verifiedPrincipal = undefined;
    } else {
      input.identity = {
        type: "observation",
        pluginId: "example",
        accountId: "default",
        senderKind: "unknown",
        id: "remote-alpha",
      };
    }
    expect(selectChannelConversationParticipant(input)).toBe(input.identity);
  },
);

it("uses the same current person for conversation metadata and audience without rewriting provenance", () => {
  const { input, revoke, closeOutput } = privateLinkedParticipant();
  const remote = structuredClone(input.identity);
  const context: MsgContext = {
    SenderId: "remote-alpha",
    AccountId: "default",
    OriginatingChannel: "example",
    InputProvenance: { kind: "external_user", sourceChannel: "example" },
  };
  bindPreparedChannelParticipantInputs({
    channelId: "example",
    binding: input.binding,
    owner: input.owner,
    context,
    inputs: [input],
  });
  const person = { type: "profile", id: "person-alpha" };
  expect(readSessionConversationParticipant(context)).toEqual(person);
  const audience = readConversationPrivateAudience(context);
  expect(audience?.participant).toEqual(person);
  expect(input.identity).toEqual(remote);
  expect(context.SenderId).toBe("remote-alpha");
  expect(context.InputProvenance).toEqual({ kind: "external_user", sourceChannel: "example" });
  closeOutput();
  expect(() => audience?.assertCurrent()).toThrow("Private output closed");
  expect(selectChannelConversationParticipant(input)).toEqual(person);
  revoke();
  expect(() => selectChannelConversationParticipant(input)).toThrow("profile binding");
});

it("does not combine two separately linked people into one private audience", () => {
  const { input: first } = privateLinkedParticipant();
  const second = {
    ...first,
    requesterProfile: { id: "person-beta", displayName: null, isCurrent: () => true },
  };
  const context: MsgContext = {};
  bindPreparedChannelParticipantInputs({
    channelId: "example",
    binding: first.binding,
    owner: first.owner,
    context,
    inputs: [first, second],
  });
  expect(readSessionConversationParticipant(context)).toBeUndefined();
  expect(readConversationPrivateAudience(context)).toBeUndefined();
});
