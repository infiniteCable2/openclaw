import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayRequestContext,
  GatewayContextResolver,
} from "../../gateway/server-methods/types.js";
import {
  buildChannelInboundEventContext,
  buildHostChannelInboundEventContext,
} from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import {
  publicResultScopeKey,
  type ChannelIngressAdmissionScope,
} from "./admission-evidence-scope-key.js";
import {
  combineChannelAdmissionEvidence as combineEvidence,
  createChannelAdmissionAudit,
  type ChannelAdmissionAudit,
  consumeChannelAdmissionEvidence as consumeEvidence,
  copyChannelParticipantAdmissionEvidence as copyEvidence,
  readChannelContextAdmissionEvidence as readEvidence,
  readChannelContextGatewayContextResolver as readResolver,
  consumeHostChannelIngressAdmission,
  prepareHostChannelContextAdmissionEvidence,
  takeChannelParticipantInput,
  type ChannelAdmissionEvidence,
} from "./admission-evidence.js";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
} from "./host-ingress.test-support.js";
import { createHostChannelIngressRuntime, resolveStableChannelIngressPolicy } from "./runtime.js";

async function resolveAdmittedHandoff(
  audit: ChannelAdmissionAudit,
  participantId: string,
  allowFrom = [participantId],
  resolveGatewayContext?: GatewayContextResolver,
  authentication?: "verified" | "asserted" | "unverified" | "mutable",
) {
  const gateway = {
    channelAdmissionAudit: audit,
    getRuntimeConfig: () => ({}),
  } as GatewayRequestContext;
  const owner = {
    channelId: "test",
    isLive: () => true,
    resolveGatewayContext: resolveGatewayContext ?? (() => gateway),
  };
  const scope: ChannelIngressAdmissionScope = {
    channelId: "test",
    accountId: "acct:primary",
    rawPrincipalRef: participantId,
    conversation: { kind: "direct", id: "dm-1" },
    binding: {
      agentId: "main",
      sessionKey: "agent:main:test:dm:dm-1",
      messageId: "msg-1",
      inboundEventKind: "user_request",
    },
  };
  const channelIngress = await createHostChannelIngressRuntime(owner).resolveStable({
    channelId: "test",
    accountId: "acct:primary",
    identity: authentication ? { authentication: "verified" } : undefined,
    subject: {
      stableId: participantId,
      ...(authentication ? { authentication: { stableId: authentication } } : {}),
    },
    conversation: { kind: "direct", id: "dm-1" },
    contextBinding: {
      agentId: "main",
      sessionKey: "agent:main:test:dm:dm-1",
      messageId: "msg-1",
      inboundEventKind: "user_request",
    },
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    ...(authentication ? { policy: { minIdentifierAuthentication: "unverified" } } : {}),
    allowFrom,
  });
  return { owner, channelIngress, scope };
}

const unknownEvidence = {
  ingressState: "unknown",
  invoker: { state: "unknown" },
  decisionCoverage: "unknown",
};
const admittedEvidence = (participant: string) => ({
  ingressState: "present",
  invoker: {
    state: "present",
    kind: "person",
    rawPrincipalRef: JSON.stringify(["test", "acct:primary", participant]),
  },
  assuranceRef: "channel-admission",
  decisionCoverage: "enforced",
  identifierAuthentication: "evaluated",
});
const audits: ChannelAdmissionAudit[] = [];
function createAudit(enabled = true) {
  const audit = createChannelAdmissionAudit({ enabled });
  audits.push(audit);
  return audit;
}
afterEach(() => {
  for (const audit of audits.splice(0)) {
    audit.close();
  }
  vi.useRealTimers();
});

function makeContext(senderId: string, messageId?: string) {
  return ingressMessage("test", "agent:main:test:dm:dm-1", senderId, {
    accountId: "acct:primary",
    messageId,
  });
}

function createOwner(audit: ChannelAdmissionAudit, resolveGatewayContext?: GatewayContextResolver) {
  const { owner } = createHostIngressFixture("test", {}, { channelAdmissionAudit: audit });
  return resolveGatewayContext ? { ...owner, resolveGatewayContext } : owner;
}

async function admittedContext(
  audit: ChannelAdmissionAudit,
  participantId: string,
  allowFrom = [participantId],
  resolveGatewayContext?: GatewayContextResolver,
) {
  const owner = createOwner(audit, resolveGatewayContext);
  const params = makeContext(participantId, "msg-1");
  const channelIngress = await createHostChannelIngressRuntime(owner).resolveStable(
    ingressInput(params, {
      subject: { stableId: participantId },
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom,
    }),
  );
  const buildContext = createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    owner,
  );
  return buildContext({ ...params, channelIngress });
}

async function evidenceFor(audit: ChannelAdmissionAudit, participantId: string) {
  return readEvidence(await admittedContext(audit, participantId));
}

function inspect(context: object) {
  return consumeEvidence(readEvidence(context));
}
function expectUnknown(evidence: ChannelAdmissionEvidence | undefined) {
  expect(consumeEvidence(evidence)).toMatchObject(unknownEvidence);
}
function unreadableAfter<T extends object>(target: T, field: PropertyKey, after = 0): T {
  let reads = 0;
  return new Proxy(target, {
    getOwnPropertyDescriptor(value, key) {
      if (key === field && reads++ >= after) {
        throw new Error("descriptor unavailable");
      }
      return Reflect.getOwnPropertyDescriptor(value, key);
    },
  });
}

it("keeps Gateway routing instance-bound when audit collection is disabled", async () => {
  const audit = createAudit(false);
  const { gateway: gatewayContext } = createHostIngressFixture("test");
  let live = true;
  const source = await admittedContext(audit, "person:42", ["person:42"], () =>
    live ? gatewayContext : undefined,
  );
  const copied = { ...source };

  copyEvidence(source, copied);

  expect(readResolver(source)?.()).toBe(gatewayContext);
  expect(readResolver(copied)?.()).toBe(gatewayContext);
  live = false;
  expect(readResolver(source)?.()).toBeUndefined();
});

it("carries the resolver participant to one run admission without route inference", async () => {
  const evidence = await evidenceFor(createAudit(), "person:42");
  const consumed = consumeEvidence(evidence);

  expect(consumed).toEqual(admittedEvidence("person:42"));
  expectUnknown(evidence);
});

it("rejects implicit context custody transfer and forged private carriers", async () => {
  const source = await admittedContext(createAudit(), "person-a");
  const copiedDescriptors = Object.defineProperties({}, Object.getOwnPropertyDescriptors(source));
  const forged = { ...source };
  const forgedResolver = vi.fn();
  for (const key of Object.getOwnPropertySymbols(source)) {
    Object.defineProperty(forged, key, {
      value: {
        context: forged,
        resolver: forgedResolver,
        evidence: { kind: "channel-admission-evidence" },
      },
      configurable: true,
    });
  }
  for (const candidate of [{ ...source }, Object.create(source), copiedDescriptors, forged]) {
    expect(readResolver(candidate)).toBeUndefined();
    expect(inspect(candidate)).toMatchObject(unknownEvidence);
  }
  expect(inspect(source)).toMatchObject({ ingressState: "present" });
});

it("cannot bootstrap evidence through the public copy helper", () => {
  const source = { OriginatingChannel: "test", AccountId: "default", SenderId: "person-a" };
  const target = { ...source };

  copyEvidence(source, target);

  expect(readEvidence(target)).toBeUndefined();
});

it.each([
  ["unchanged", {}],
  ["unreadable", {}],
  ["consumed", {}],
  ["participant", { SenderId: "person-b" }],
  ["route", { SessionKey: "agent:other:test:dm:dm-1" }],
  ["thread", { MessageThreadId: "thread-2" }],
  ["native channel", { NativeChannelId: "native-2" }],
  ["message", { MessageSid: "msg-2", MessageSidFull: "msg-2" }],
])("copies admission only to a readable, unchanged, unconsumed scope: %s", async (kind, patch) => {
  const source = await admittedContext(createAudit(), "person-a");
  if (kind === "consumed") {
    expect(inspect(source)).toMatchObject({ ingressState: "present" });
  }
  const copy = { ...source, ...patch };
  const target = kind === "unreadable" ? unreadableAfter(copy, "NativeDirectUserId") : copy;
  copyEvidence(source, target);
  expect(inspect(target)).toMatchObject(
    kind === "unchanged"
      ? { ingressState: "present", invoker: { state: "present", kind: "person" } }
      : unknownEvidence,
  );
  if (kind === "unreadable") {
    expect(readResolver(target)).toBeUndefined();
  }
});

it("rejects an event whose symbol descriptor becomes unreadable without throwing", async () => {
  const result = await resolveStableChannelIngressPolicy(ingressInput(makeContext("person-1")));
  const key = Symbol("unreadable-event-field");
  result.state.event = unreadableAfter({ ...result.state.event, [key]: true }, key, 1);
  expect(publicResultScopeKey(result)).toBeUndefined();
});

it("reports same-participant collection while mixed participants fail closed", async () => {
  const audit = createAudit();
  const combined = async (...participants: string[]) =>
    combineEvidence(await Promise.all(participants.map((id) => evidenceFor(audit, id))));
  expect(consumeEvidence(await combined("c", "c"))).toEqual(admittedEvidence("c"));
  expectUnknown(await combined("c", "b:c"));
});

it("keeps wildcard admission attribution-only because identity did not affect the outcome", async () => {
  const context = await admittedContext(createAudit(), "person-42", ["*"]);
  expect(inspect(context)).toMatchObject({
    ingressState: "present",
    invoker: { state: "present", kind: "person" },
    decisionCoverage: "attribution-only",
  });
});

it("rejects forged and prior-lifecycle carriers and stays empty when collection is disabled", async () => {
  const audit = createAudit();
  const stale = await evidenceFor(audit, "person-1");
  audit.close();

  const nextAudit = createAudit();
  expectUnknown(stale);
  expectUnknown({ kind: "channel-admission-evidence" } as ChannelAdmissionEvidence);
  expect(inspect(await admittedContext(nextAudit, "person-1"))).toMatchObject({
    ingressState: "present",
  });

  expect(await evidenceFor(audit, "person-1")).toBeUndefined();
});

it.each(["unsupported", "omitted", "fake", "public", "ownerless"] as const)(
  "keeps %s adapter handoffs non-authoritative",
  async (kind) => {
    const owner = createOwner(createAudit());
    const base = makeContext("person-1", "msg-1");
    const ingress = await createHostChannelIngressRuntime(owner).resolveStable(ingressInput(base));
    const handoffs = {
      unsupported: "unsupported" as const,
      omitted: undefined,
      fake: { ...ingress },
      public: ingress,
      ownerless: ingress,
    };
    const build =
      kind === "public" ? buildChannelInboundEventContext : buildHostChannelInboundEventContext;
    const context = build({ ...base, channelIngress: handoffs[kind] });
    if (kind === "public") {
      expect(readEvidence(context)).toBeUndefined();
    } else {
      expect(inspect(context)).toMatchObject(
        kind === "unsupported"
          ? { ingressState: "unsupported", decisionCoverage: "unsupported" }
          : unknownEvidence,
      );
    }
  },
);

it("expires a carrier at the bounded retention edge", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const audit = createAudit();
  const evidence = await evidenceFor(audit, "person-1");
  vi.setSystemTime(1_000 + 30 * 24 * 60 * 60_000 + 1);
  expectUnknown(evidence);
});

it("bounds aggregate fan-in and participant material", async () => {
  const audit = createAudit();
  const oversizedParticipant = await evidenceFor(audit, "x".repeat(4_097));
  expectUnknown(oversizedParticipant);

  const sources = await Promise.all(
    Array.from({ length: 17 }, (_, index) => evidenceFor(audit, `person-${index}`)),
  );
  expectUnknown(combineEvidence(sources));
});

describe("original text-free participant custody", () => {
  it.each([true, false])(
    "consumes a text-free host handoff once with audit collection %s",
    async (enabled) => {
      const audit = createChannelAdmissionAudit({ enabled });
      try {
        const {
          owner,
          channelIngress: ingress,
          scope,
        } = await resolveAdmittedHandoff(audit, "person-a");
        const accepted = consumeHostChannelIngressAdmission({ owner, ingress, scope });
        expect(accepted.accepted).toBe(true);
        expect(consumeEvidence(accepted.evidence)).toMatchObject({
          ingressState: enabled ? "present" : "unknown",
        });
        if (!enabled) {
          expect(accepted.evidence).toBeUndefined();
        }
        expect(accepted.resolver).toBe(owner.resolveGatewayContext);
        expect(accepted.participantInput).toMatchObject({ owner, binding: scope.binding });
        expect(takeChannelParticipantInput(ingress)).toBeUndefined();
        expect(consumeHostChannelIngressAdmission({ owner, ingress, scope })).toMatchObject({
          accepted: false,
          resolver: undefined,
          participantInput: undefined,
        });
      } finally {
        audit.close();
      }
    },
  );

  it.each([
    "channel",
    "account",
    "principal",
    "conversation",
    "parent",
    "thread",
    "agent",
    "session",
    "message",
    "native",
    "event",
    "accessor",
    "mutation",
    "copy",
    "owner",
    "closed",
    "gateway",
  ] as const)(
    "rejects and spends a text-free resolver handoff with changed %s custody",
    async (change) => {
      const audit = createChannelAdmissionAudit({ enabled: true });
      try {
        const fixture = await resolveAdmittedHandoff(audit, "person-a");
        const { channelIngress: ingress, scope } = fixture;
        let owner = fixture.owner;
        const changed = {
          ...scope,
          conversation: { ...scope.conversation },
          binding: { ...scope.binding },
        };
        if (change === "channel") {
          changed.channelId = "other";
        }
        if (change === "account") {
          changed.accountId = "other";
        }
        if (change === "principal") {
          changed.rawPrincipalRef = "person-b";
        }
        if (change === "conversation") {
          changed.conversation.id = "other";
        }
        if (change === "parent") {
          changed.conversation.parentId = "other";
        }
        if (change === "thread") {
          changed.conversation.threadId = "other";
        }
        if (change === "agent") {
          changed.binding.agentId = "other";
        }
        if (change === "session") {
          changed.binding.sessionKey = "other";
        }
        if (change === "message") {
          changed.binding.messageId = "other";
        }
        if (change === "native") {
          changed.binding.nativeChannelId = "dm-1";
        }
        if (change === "event") {
          changed.binding.inboundEventKind = "room_event";
        }
        const accessor = vi.fn(() => "msg-1");
        if (change === "accessor") {
          Object.defineProperty(changed.binding, "messageId", { get: accessor });
        }
        if (change === "mutation") {
          ingress.state.accountId = "other";
        }
        if (change === "owner") {
          owner = { ...owner };
        }
        if (change === "closed") {
          owner.isLive = () => false;
        }
        if (change === "gateway") {
          owner.resolveGatewayContext = () => undefined;
        }
        const consumed = consumeHostChannelIngressAdmission({
          owner,
          ingress: change === "copy" ? { ...ingress } : ingress,
          scope: changed,
        });
        expect(consumed.accepted).toBe(false);
        expect(consumed.resolver).toBeUndefined();
        expect(consumed.participantInput).toBeUndefined();
        expect(accessor).not.toHaveBeenCalled();
        expect(consumeEvidence(consumed.evidence)).toMatchObject({
          ingressState: "unknown",
        });
        if (change !== "copy") {
          expect(
            consumeHostChannelIngressAdmission({ owner: fixture.owner, ingress, scope }).accepted,
          ).toBe(false);
        } else {
          expect(consumeHostChannelIngressAdmission({ owner, ingress, scope }).accepted).toBe(true);
        }
      } finally {
        audit.close();
      }
    },
  );

  it("preserves final-message-only batch admission while rejecting single-result reuse", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const first = await resolveAdmittedHandoff(audit, "person-a");
      const second = await createHostChannelIngressRuntime(first.owner).resolveStable({
        channelId: first.scope.channelId,
        accountId: first.scope.accountId ?? "default",
        subject: { stableId: "person-b" },
        conversation: first.scope.conversation,
        contextBinding: { ...first.scope.binding, messageId: "msg-2" },
        dmPolicy: "open",
        allowFrom: ["person-b"],
      });
      expect(first.channelIngress.ingress.admission).toBe("dispatch");
      expect(second.ingress.admission).toBe("dispatch");
      prepareHostChannelContextAdmissionEvidence({
        owner: first.owner,
        channelId: first.scope.channelId,
        accountId: first.scope.accountId,
        rawPrincipalRef: "person-b",
        ingress: [first.channelIngress, second],
        contextParams: {
          messageId: "msg-2",
          conversation: first.scope.conversation,
          route: { agentId: "main", routeSessionKey: first.scope.binding.sessionKey },
          reply: { nativeChannelId: "dm-1" },
          message: {},
        },
      });
      expect(takeChannelParticipantInput(first.channelIngress)).toBeDefined();
      expect(takeChannelParticipantInput(second)).toBeDefined();
      expect(
        consumeHostChannelIngressAdmission({
          owner: first.owner,
          ingress: first.channelIngress,
          scope: first.scope,
        }).accepted,
      ).toBe(false);
    } finally {
      audit.close();
    }
  });

  it.each([
    { source: undefined, changed: null },
    { source: null, changed: "" },
    { source: "", changed: undefined },
    { source: 42, changed: "42" },
  ])(
    "keeps the original primitive raw principal $source distinct from $changed",
    async ({ source, changed }) => {
      const audit = createChannelAdmissionAudit({ enabled: false });
      try {
        const { owner, scope } = await resolveAdmittedHandoff(audit, "person-a");
        const resolve = () =>
          createHostChannelIngressRuntime(owner).resolveStable({
            channelId: scope.channelId,
            accountId: scope.accountId ?? "default",
            subject: { stableId: source },
            identity: {
              resolveParticipant: () => ({
                domain: "test-workspace",
                idKind: "test-user",
                id: "participant",
              }),
            },
            conversation: scope.conversation,
            contextBinding: scope.binding,
            dmPolicy: "open",
            allowFrom: ["*"],
          });
        const mismatched = await resolve();
        expect(mismatched.ingress.admission).toBe("dispatch");
        const rejected = consumeHostChannelIngressAdmission({
          owner,
          ingress: mismatched,
          scope: { ...scope, rawPrincipalRef: changed },
        });
        expect(rejected.accepted).toBe(false);
        expect(rejected.participantInput).toBeUndefined();
        const exact = await resolve();
        expect(exact.ingress.admission).toBe("dispatch");
        expect(
          consumeHostChannelIngressAdmission({
            owner,
            ingress: exact,
            scope: { ...scope, rawPrincipalRef: source },
          }),
        ).toMatchObject({ accepted: true, participantInput: { owner } });
      } finally {
        audit.close();
      }
    },
  );

  it("does not use the bounded audit identifier as the text-free admission authority", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const {
        owner,
        channelIngress: ingress,
        scope,
      } = await resolveAdmittedHandoff(audit, "x".repeat(4_097));
      expect(ingress.ingress.admission).toBe("dispatch");
      const admitted = consumeHostChannelIngressAdmission({ owner, ingress, scope });
      expect(admitted.accepted).toBe(true);
      expect(admitted.participantInput).toBeDefined();
      expect(consumeEvidence(admitted.evidence)).toMatchObject({
        ingressState: "unknown",
      });
    } finally {
      audit.close();
    }
  });

  it.each(["duplicate", "wrong-final-message"])(
    "rejects the entire %s context batch and spends its handoffs",
    async (change) => {
      const audit = createChannelAdmissionAudit({ enabled: false });
      try {
        const {
          owner,
          channelIngress: ingress,
          scope,
        } = await resolveAdmittedHandoff(audit, "person-a");
        prepareHostChannelContextAdmissionEvidence({
          owner,
          channelId: scope.channelId,
          accountId: scope.accountId,
          rawPrincipalRef: scope.rawPrincipalRef,
          ingress: change === "duplicate" ? [ingress, ingress] : ingress,
          contextParams: {
            messageId: change === "duplicate" ? "msg-1" : "msg-other",
            conversation: scope.conversation,
            route: { agentId: scope.binding.agentId, routeSessionKey: scope.binding.sessionKey },
            reply: {},
            message: {},
          },
        });
        expect(takeChannelParticipantInput(ingress)).toBeUndefined();
        expect(consumeHostChannelIngressAdmission({ owner, ingress, scope }).accepted).toBe(false);
      } finally {
        audit.close();
      }
    },
  );
});
