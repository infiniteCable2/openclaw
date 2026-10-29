import { describe, expect, it, vi } from "vitest";
import {
  collectConversationPrivateAudiences,
  retainConversationPrivateAudience,
  type ConversationPrivateAudience,
  type RetainedConversationPrivateAudience,
} from "./conversation-private-audience.js";

function audienceFixture() {
  let originalCurrent = true;
  let retainedCurrent = true;
  const source = Object.freeze({});
  const fields = {
    agentId: "example",
    sessionKey: "agent:example:private-chat",
    channelId: "example-chat",
    accountId: "default",
    nativeChannelId: "private-endpoint",
    participant: { type: "profile", id: "example-person" } as const,
  };
  const retainedAudience: ConversationPrivateAudience = Object.freeze({
    ...fields,
    assertCurrent() {
      if (!retainedCurrent) {
        throw new Error("Retained native source revoked");
      }
    },
  });
  const release = vi.fn(() => {
    retainedCurrent = false;
  });
  const lease: RetainedConversationPrivateAudience = {
    source,
    audience: retainedAudience,
    release,
  };
  const retain = vi.fn(() => [lease]);
  const audience: ConversationPrivateAudience = Object.freeze({
    ...fields,
    assertCurrent() {
      if (!originalCurrent) {
        throw new Error("Original turn ended");
      }
    },
    retain,
  });
  return {
    audience,
    lease,
    release,
    retain,
    endTurn() {
      originalCurrent = false;
    },
    revoke() {
      retainedCurrent = false;
    },
  };
}

describe("private conversation audience retention", () => {
  it("borrows legacy audience evidence without manufacturing an independent lifetime", () => {
    let current = true;
    const original: ConversationPrivateAudience = {
      ...audienceFixture().audience,
      retain: undefined,
      assertCurrent() {
        if (!current) {
          throw new Error("Legacy source ended");
        }
      },
    };
    const leases = retainConversationPrivateAudience(original);
    expect(leases).toHaveLength(1);
    try {
      leases[0]!.audience.assertCurrent();
      current = false;
      expect(() => leases[0]!.audience.assertCurrent()).toThrow("Legacy source ended");
    } finally {
      leases[0]!.release();
    }
  });

  it("rejects an expired original before acquiring any new native hold", () => {
    const f = audienceFixture();
    f.endTurn();
    expect(() => retainConversationPrivateAudience(f.audience)).toThrow("Original turn ended");
    expect(f.retain).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it.each([
    { agentId: "other-agent" },
    { sessionKey: "agent:example:other-chat" },
    { channelId: "other-channel" },
    { accountId: "other-account" },
    { nativeChannelId: "other-endpoint" },
    { participant: { type: "profile" as const, id: "other-person" } },
  ])(
    "rejects changed retained recipient evidence (%j) and releases every acquired hold",
    (change) => {
      const f = audienceFixture();
      const releases: string[] = [];
      const first: RetainedConversationPrivateAudience = {
        ...f.lease,
        release: () => {
          releases.push("first");
        },
      };
      const changed: RetainedConversationPrivateAudience = {
        ...f.lease,
        source: Object.freeze({}),
        audience: { ...f.lease.audience, ...change },
        release: () => {
          releases.push("changed");
        },
      };
      const last: RetainedConversationPrivateAudience = {
        ...f.lease,
        source: Object.freeze({}),
        release: () => {
          releases.push("last");
        },
      };
      expect(() =>
        retainConversationPrivateAudience({ ...f.audience, retain: () => [first, changed, last] }),
      ).toThrow();
      expect(releases).toEqual(["last", "changed", "first"]);
    },
  );

  it("releases a returned lease whose native source is already revoked", () => {
    const f = audienceFixture();
    f.revoke();
    expect(() => retainConversationPrivateAudience(f.audience)).toThrow();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("retains every collected input and never upgrades only the first child's lifetime", () => {
    const first = audienceFixture();
    const second = audienceFixture();
    const collected = collectConversationPrivateAudiences([first.audience, second.audience]);
    expect(collected).toBeDefined();
    expect(first.retain).not.toHaveBeenCalled();
    expect(second.retain).not.toHaveBeenCalled();
    const leases = retainConversationPrivateAudience(collected!);
    expect(leases.length).toBeGreaterThan(0);
    expect(first.retain).toHaveBeenCalledOnce();
    expect(second.retain).toHaveBeenCalledOnce();
    try {
      first.endTurn();
      second.endTurn();
      expect(() => collected!.assertCurrent()).toThrow();
      for (const lease of leases) {
        expect(() => lease.audience.assertCurrent()).not.toThrow();
      }
      second.revoke();
      for (const lease of leases) {
        expect(() => lease.audience.assertCurrent()).toThrow("Retained native source revoked");
      }
    } finally {
      for (const lease of leases.toReversed()) {
        lease.release();
      }
    }
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).toHaveBeenCalledOnce();
  });

  it("unwinds earlier collected holds when a later native retention fails", () => {
    const first = audienceFixture();
    const second = audienceFixture();
    second.retain.mockImplementationOnce(() => {
      throw new Error("Second native lease refused");
    });
    const collected = collectConversationPrivateAudiences([first.audience, second.audience]);
    expect(() => retainConversationPrivateAudience(collected!)).toThrow();
    expect(first.retain).toHaveBeenCalledOnce();
    expect(second.retain).toHaveBeenCalledOnce();
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).not.toHaveBeenCalled();
  });

  it("groups collected inputs from the same native endpoint without releasing one child's proof", () => {
    const first = audienceFixture();
    const second = audienceFixture();
    const shared = first.lease.source;
    second.retain.mockReturnValue([{ ...second.lease, source: shared }]);
    const collected = collectConversationPrivateAudiences([first.audience, second.audience]);
    const leases = retainConversationPrivateAudience(collected!);
    expect(leases).toHaveLength(1);
    expect(leases[0]!.source).toBe(shared);
    try {
      first.endTurn();
      second.endTurn();
      expect(() => leases[0]!.audience.assertCurrent()).not.toThrow();
      expect(first.release).not.toHaveBeenCalled();
      expect(second.release).not.toHaveBeenCalled();
    } finally {
      leases[0]!.release();
    }
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).toHaveBeenCalledOnce();
  });
});
