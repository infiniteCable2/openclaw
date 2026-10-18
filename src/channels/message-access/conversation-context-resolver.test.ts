import { describe, expect, it } from "vitest";
import { buildHostChannelInboundEventContext } from "../inbound-event/context.js";
import {
  bindHostConversationContextGatewayResolver,
  consumeChannelAdmissionEvidence,
  copyChannelParticipantAdmissionEvidence,
  readChannelContextAdmissionEvidence,
  readChannelContextGatewayContextResolver,
} from "./admission-evidence.js";

function context(ingress?: "unsupported") {
  return buildHostChannelInboundEventContext({
    channel: "example-device",
    accountId: "device",
    channelIngress: ingress,
    from: "device:room",
    sender: { id: "unknown-speaker" },
    conversation: { kind: "group", id: "room" },
    route: { agentId: "example", routeSessionKey: "agent:example:example-device:group:room" },
    messageId: "input",
    message: { rawBody: "Hello" },
    reply: { to: "device:room" },
  });
}

describe("original non-channel conversation Gateway context", () => {
  it.each([undefined, "unsupported"] as const)(
    "retains exact host routing without upgrading %s evidence",
    (ingress) => {
      const source = context(ingress);
      const gateway = {} as never;
      const state = { current: true };
      bindHostConversationContextGatewayResolver({
        context: source,
        resolveGatewayContext: () => gateway,
        assertCurrent() {
          if (!state.current) {
            throw new Error("Original host revoked");
          }
        },
      });
      const copied = { ...source };
      copyChannelParticipantAdmissionEvidence(source, copied);
      expect(readChannelContextGatewayContextResolver(source)?.()).toBe(gateway);
      expect(readChannelContextGatewayContextResolver(copied)?.()).toBe(gateway);
      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(copied)),
      ).toMatchObject({
        ingressState: ingress ?? "unknown",
        invoker: { state: "unknown" },
      });
      state.current = false;
      expect(() => readChannelContextGatewayContextResolver(source)?.()).toThrow(
        "Original host revoked",
      );
      expect(() => readChannelContextGatewayContextResolver(copied)?.()).toThrow(
        "Original host revoked",
      );
    },
  );

  it("rejects unbound/changed scopes and never replaces an existing routing owner", () => {
    const gateway = {} as never;
    const source = context("unsupported");
    const bind = (target: object) =>
      bindHostConversationContextGatewayResolver({
        context: target,
        resolveGatewayContext: () => gateway,
        assertCurrent() {},
      });
    expect(() => bind({ ...source })).toThrow("routing owner");
    const changed = context("unsupported");
    changed.SenderId = "different";
    expect(() => bind(changed)).toThrow("routing owner");
    bind(source);
    expect(() => bind(source)).toThrow("routing owner");
    const retargeted = { ...source, SessionKey: "agent:other:main" };
    copyChannelParticipantAdmissionEvidence(source, retargeted);
    expect(readChannelContextGatewayContextResolver(retargeted)).toBeUndefined();
  });
});
