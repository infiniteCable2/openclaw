import { expect, it, vi } from "vitest";
import { getCommandOwnerAuthority } from "../../auto-reply/command-owner-authority.js";
import { getRequesterProfile } from "../../auto-reply/requester-profile.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/shared-types.js";
import { readConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import {
  readSessionConversationParticipant,
  sessionParticipantInput,
} from "../../sessions/session-participant-input.js";
import { buildChannelInboundEventContext } from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import {
  consumeChannelAdmissionEvidence,
  createChannelAdmissionAudit,
  readChannelContextAdmissionEvidence as readEvidence,
  readChannelContextGatewayContextResolver,
} from "./admission-evidence.js";
import { prepareChildSessionPublication } from "./child-session-publication.js";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
} from "./host-ingress.test-support.js";
import type { ChannelParticipantInput } from "./ingress-host-owner.js";
import {
  bindPreparedChannelParticipantInputs,
  selectChannelConversationParticipant,
} from "./participant-input.js";

const recordParticipant = vi.hoisted(() => vi.fn());
const remote = { domain: "workspace-one", idKind: "user-id", id: "profile-collision" };
const identities: SessionParticipantIdentity[] = [
  { type: "remote", pluginId: "test", ...remote },
  {
    type: "observation",
    pluginId: "test",
    accountId: "local",
    senderKind: "unknown",
    id: "unknown",
  },
];
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
] as const)("binds accepted input to its current host: %s", async (scenario) => {
  recordParticipant.mockClear();
  const auditEnabled = scenario.includes("during");
  const audit = createChannelAdmissionAudit({ enabled: auditEnabled });
  const host = createHostIngressFixture("test", {}, { channelAdmissionAudit: audit });
  const key = "agent:main:test:dm:conversation";
  const resolveParticipant = vi.fn((subject: { stableId?: string | number | null }) =>
    subject.stableId === "unknown" ? undefined : { ...remote, id: String(subject.stableId) },
  );
  try {
    const sources = scenario === "mixed" ? [remote.id, "unknown"] : [remote.id];
    const ingress = [];
    const startedAt = Date.now();
    const messageFor = (id: string) => ingressMessage("test", key, id, { accountId: "local" });
    for (const sender of sources) {
      ingress.push(
        await host.ingress.resolveStable(
          ingressInput(messageFor(sender), {
            identity: { resolveParticipant },
            dmPolicy: scenario === "gateway-replaced-during-ingress" ? "pairing" : "open",
            allowFrom: scenario === "denied" ? [] : ["*"],
            readStoreAllowFrom: async () => {
              await Promise.resolve();
              if (scenario === "gateway-replaced-during-ingress") {
                host.replaceGatewayContext();
              }
              return [];
            },
          }),
        ),
      );
    }
    expect(resolveParticipant).toHaveBeenCalledTimes(sources.length);
    expect(ingress[0]?.ingress.admission).toBe(scenario === "denied" ? "drop" : "dispatch");
    if (scenario === "stale") {
      host.retire();
    }
    const context = await createHostChannelInboundEventContextBuilder(
      async (params: ReturnType<typeof ingressMessage>) => {
        await Promise.resolve();
        if (scenario === "gateway-replaced-during-context") {
          host.replaceGatewayContext();
        }
        if (scenario === "retired-during-context") {
          host.retire();
        }
        return buildChannelInboundEventContext(params);
      },
      host.owner,
    )({
      ...messageFor(sources.at(-1)!),
      route: {
        agentId: "main",
        routeSessionKey: scenario === "retargeted" ? "agent:main:other" : key,
      },
      channelIngress: ingress,
    });
    const target = { agentId: "main", sessionKey: key, storePath: "/unused" };
    recordAcceptedSessionParticipantInput({ ...context }, target);
    recordAcceptedSessionParticipantInput(context, target);
    if (scenario === "qualified" || scenario === "mixed") {
      expect(recordParticipant.mock.calls).toEqual(
        identities
          .slice(0, sources.length)
          .map((identity) => [{ ...target, identity, promptedAt: expect.any(Number) }]),
      );
      expect(recordParticipant.mock.calls[0]?.[0].promptedAt).toBeGreaterThanOrEqual(startedAt);
    } else {
      expect(recordParticipant).not.toHaveBeenCalled();
    }
    if (auditEnabled) {
      expect(consumeChannelAdmissionEvidence(readEvidence(context))).toMatchObject({
        ingressState: "unknown",
      });
      expect(readChannelContextGatewayContextResolver(context)).toBeUndefined();
    } else {
      expect(readEvidence(context)).toBeUndefined();
    }
    expect(ingress[0]).not.toHaveProperty("participant");
  } finally {
    host.retire();
    audit.close();
  }
});

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
  expect(
    Reflect.get(context, sessionParticipantInput).map(
      (fact: { identity: unknown }) => fact.identity,
    ),
  ).toEqual([remote, person]);
  const audience = readConversationPrivateAudience(context);
  expect(audience?.participant).toEqual(person);
  expect(input.identity).toEqual(remote);
  expect(context.SenderId).toBe("remote-alpha");
  expect(context.InputProvenance).toEqual({ kind: "external_user", sourceChannel: "example" });
  closeOutput();
  expect(() => audience?.assertCurrent()).toThrow("Private output closed");
  expect(selectChannelConversationParticipant(input)).toEqual(person);
  revoke();
  expect(getRequesterProfile(context)).toBeUndefined();
  expect(readSessionConversationParticipant(context)).toBeUndefined();
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
  // Native remote attribution remains, but conflicting profile assertions cannot become a person.
  expect(readSessionConversationParticipant(context)).toEqual(first.identity);
  expect(getRequesterProfile(context)).toBeUndefined();
  expect(readConversationPrivateAudience(context)).toBeUndefined();
});

it.each(["sender", "account", "channel"] as const)(
  "never binds personal or owner authority to a mismatched %s",
  (field) => {
    const { input } = privateLinkedParticipant();
    input.commandOwnerAuthority = { source: "synthetic-admin", isCurrent: () => true };
    input.commandOwnerPrincipal = input.verifiedPrincipal;
    const context: MsgContext = {
      SenderId: "remote-alpha",
      AccountId: "default",
      OriginatingChannel: "example",
    };
    if (field === "sender") context.SenderId = "another-sender";
    if (field === "account") context.AccountId = "another-account";
    if (field === "channel") context.OriginatingChannel = "another-channel";
    bindPreparedChannelParticipantInputs({
      channelId: "example",
      binding: input.binding,
      owner: input.owner,
      context,
      inputs: [input],
    });
    expect(getRequesterProfile(context)).toBeUndefined();
    expect(getCommandOwnerAuthority(context)).toBeUndefined();
    expect(readConversationPrivateAudience(context)).toBeUndefined();
  },
);

it("retains native asynchronous public-source preparation at the shared binder", async () => {
  const { input } = privateLinkedParticipant();
  input.privateAudience = undefined;
  const prepared = vi.fn();
  const prepare = vi.fn(async () => prepared);
  input.childSessionPublication = { audience: "public", assertCurrent() {}, prepare };
  const context: MsgContext = {};
  bindPreparedChannelParticipantInputs({
    channelId: "example",
    binding: input.binding,
    owner: input.owner,
    context,
    inputs: [input],
  });
  await prepareChildSessionPublication(context);
  expect(prepare).toHaveBeenCalledOnce();
  expect(prepared).toHaveBeenCalledOnce();
});

it("binds private audience through the native host builder rather than a separate speech path", async () => {
  const host = createHostIngressFixture("example");
  const message = ingressMessage("example", "agent:main:example:direct", "remote-alpha", {
    reply: { to: "remote-alpha", nativeChannelId: "private-alpha" },
  });
  try {
    const ingress = await host.ingress.resolveStable(
      ingressInput(message, {
        contextBinding: {
          agentId: "main",
          sessionKey: message.route.routeSessionKey,
          messageId: message.messageId,
          nativeChannelId: "private-alpha",
          inboundEventKind: "user_request",
        },
        identity: {
          resolveParticipant: () => ({
            domain: "example.test",
            idKind: "user-id",
            id: "remote-alpha",
          }),
        },
        privateAudience: { assertCurrent() {} },
      }),
    );
    const context = await host.buildContext({ ...message, channelIngress: ingress });
    expect(readConversationPrivateAudience(context)).toMatchObject({
      channelId: "example",
      nativeChannelId: "private-alpha",
      participant: { type: "remote", id: "remote-alpha" },
    });
    readConversationPrivateAudience(context)?.assertCurrent();
  } finally {
    host.retire();
  }
});
