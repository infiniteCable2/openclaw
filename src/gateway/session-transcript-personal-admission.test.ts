import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import {
  preparePersonalConversationRead,
  type PersonalConversationReadParams,
  type PreparedPersonalConversationAdmission,
} from "./session-transcript-personal-read.js";

const native = vi.hoisted(() => ({ prepare: vi.fn() }));
// mock-isolation: Test native custody ownership and policy without starting storage workers.
vi.mock("./session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: native.prepare,
}));

function fixture() {
  const participant = { type: "profile" as const, id: "person-a" };
  const root = {
    sessionKey: "agent:example:root",
    sessionId: "root-a",
    lifecycleRevision: "root-life",
  };
  const target = {
    agentId: "example",
    sessionKey: "agent:example:target",
    sessionId: "target-a",
    lifecycleRevision: "target-life",
    storePath: "/example/store.sqlite",
    root,
  };
  const row = (sessionKey: string, sessionId: string): SessionSharingTarget => ({
    agentId: target.agentId,
    canonicalKey: sessionKey,
    storeKey: sessionKey,
    storeKeys: [sessionKey],
    storePath: target.storePath,
    readSource: {
      agentId: target.agentId,
      path: target.storePath,
      databaseIdentity: "physical-a",
      databaseBirthtime: "birth-a",
    },
    entry: {
      sessionId,
      lifecycleRevision: `${sessionId}-life`,
      updatedAt: 1,
      visibility: "draft",
      chatType: "direct",
      participantCount: 1,
      participants: [{ identity: participant }],
      conversationTopology: {
        version: 1,
        role: "branch",
        rootSessionKey: root.sessionKey,
        rootSessionId: root.sessionId,
        rootSessionLifecycleRevision: root.lifecycleRevision,
      },
    },
  });
  const recipient = row(target.sessionKey, target.sessionId);
  recipient.entry.lifecycleRevision = target.lifecycleRevision;
  const source = row("agent:example:source", "source-a");
  const rootRow = row(root.sessionKey, root.sessionId);
  rootRow.entry = {
    sessionId: root.sessionId,
    lifecycleRevision: root.lifecycleRevision,
    updatedAt: 1,
    visibility: "draft",
    createdVia: "internal",
    createdActor: { type: "system", id: "conversation-root" },
    delivery: { kind: "none" },
    conversationTopology: { version: 1, role: "root" },
  };
  const rows = new Map(
    [recipient, source, rootRow].map((selected) => [selected.canonicalKey, selected]),
  );
  const members = new Map([...rows.keys()].map((key) => [key, new Set<string>()]));
  const releases: ReturnType<typeof vi.fn>[] = [];
  native.prepare.mockImplementation(async ({ sessionKey }: { sessionKey: string }) => {
    let active = true;
    const release = vi.fn(() => {
      active = false;
    });
    releases.push(release);
    return {
      readCurrent() {
        if (!active) {
          throw new Error("Native custody released");
        }
        return { target: rows.get(sessionKey)!, membership: members.get(sessionKey)! };
      },
      release,
    };
  });
  let config: OpenClawConfig = {
    agents: { entries: { example: { conversationMode: "branches" } } },
  };
  let originalCurrent = true;
  let endpointCurrent = true;
  const fresh = (
    preparedAdmission?: PreparedPersonalConversationAdmission,
  ): PersonalConversationReadParams => ({
    purpose: "conversation-differences",
    preparedAdmission,
    personal: {
      originalParticipant: participant,
      target,
      assertCurrent() {
        if (!endpointCurrent) {
          throw new Error("Current endpoint revoked");
        }
      },
      targetAudience: {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        channelId: "example",
        accountId: "default",
        nativeChannelId: "private-destination",
        participant,
        assertCurrent() {
          if (!endpointCurrent) {
            throw new Error("Current endpoint revoked");
          }
        },
      },
    },
    getRuntimeConfig: () => config,
    sources: [{ agentId: target.agentId, sessionKey: source.canonicalKey }],
  });
  const original = fresh();
  original.personal.assertCurrent = () => {
    if (!originalCurrent) {
      throw new Error("Original execution ended");
    }
  };
  original.personal.targetAudience = {
    ...original.personal.targetAudience!,
    assertCurrent: original.personal.assertCurrent,
  };
  return {
    original,
    fresh,
    recipient,
    source,
    rootRow,
    members,
    releases,
    endOriginal: () => {
      originalCurrent = false;
    },
    revokeEndpoint: () => {
      endpointCurrent = false;
    },
    changeMode: () => {
      config = { agents: { entries: { example: { conversationMode: "native" } } } };
    },
  };
}

beforeEach(() => {
  native.prepare.mockReset();
});

describe("prepared native personal admission custody", () => {
  it.each(["grant", "descriptor"] as const)(
    "retries failed terminal %s cleanup without reviving its authority or repeating successful releases",
    async (kind) => {
      const f = fixture();
      const grant = await preparePersonalConversationRead(f.original);
      const descriptor = kind === "descriptor" ? grant.prepareAdmission() : undefined;
      if (descriptor) {
        grant.release();
      }
      const view = descriptor ?? grant;
      const failure = new Error("Synthetic native cleanup failure");
      const failingRelease = f.releases[0]!;
      failingRelease.mockImplementationOnce(() => {
        throw failure;
      });
      expect(() => view.release()).toThrow();
      expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
      if (descriptor) {
        await expect(preparePersonalConversationRead(f.fresh(descriptor))).rejects.toThrow(
          "changed or expired",
        );
      } else {
        expect(() => grant.assertCurrent()).toThrow("released");
      }
      view.release();
      view.release();
      expect(failingRelease).toHaveBeenCalledTimes(2);
      expect(f.releases.slice(1).every((release) => release.mock.calls.length === 1)).toBe(true);
      expect(native.prepare).toHaveBeenCalledTimes(3);
    },
  );

  it("rebinds after its background execution ends without discovery or losing commit predicates", async () => {
    const f = fixture();
    const original = await preparePersonalConversationRead(f.original);
    const descriptor = original.prepareAdmission();
    expect(descriptor.byteLength).toBeGreaterThan(0);
    original.release();
    f.endOriginal();
    f.recipient.entry.participants!.push({ identity: { type: "agent", id: "internal-helper" } });
    f.recipient.entry.participantCount = 2;
    const rebound = await preparePersonalConversationRead(f.fresh(descriptor));
    try {
      expect(native.prepare).toHaveBeenCalledTimes(3);
      expect(rebound.audience).toBe("private-direct");
      expect(rebound.audienceIdentity).toBe(original.audienceIdentity);
      expect(rebound.sources).toEqual(original.sources);
      const predicates = await prepareSessionSourceAuthority(rebound.assertCurrent);
      expect(predicates.checks.map(({ predicate }) => predicate.sessionKey)).toEqual([
        f.recipient.storeKey,
        f.rootRow.storeKey,
        f.source.storeKey,
      ]);
      expect(
        predicates.checks.every(({ predicate }) => predicate.fields.includes("visibility")),
      ).toBe(true);
      expect(predicates.checks[0]?.predicate.expected?.participants).toEqual(
        f.recipient.entry.participants,
      );
      descriptor.release();
      descriptor.release();
      expect(f.releases.every((release) => release.mock.calls.length === 0)).toBe(true);
      rebound.assertCurrent();
      await predicates.release?.();
    } finally {
      descriptor.release();
      rebound.release();
      rebound.release();
    }
    expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it("keeps independently disposable descriptors alive until their final view closes", async () => {
    const f = fixture();
    const original = await preparePersonalConversationRead(f.original);
    const first = original.prepareAdmission();
    const second = original.prepareAdmission();
    original.release();
    first.release();
    await expect(preparePersonalConversationRead(f.fresh(first))).rejects.toThrow(
      "changed or expired",
    );
    const rebound = await preparePersonalConversationRead(f.fresh(second));
    second.release();
    expect(f.releases.every((release) => release.mock.calls.length === 0)).toBe(true);
    rebound.release();
    expect(native.prepare).toHaveBeenCalledTimes(3);
    expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it.each(["target", "participant", "source", "mode", "endpoint", "forged"] as const)(
    "refuses changed %s without falling back to native discovery",
    async (change) => {
      const f = fixture();
      const original = await preparePersonalConversationRead(f.original);
      const descriptor = original.prepareAdmission();
      original.release();
      const request = f.fresh(descriptor);
      if (change === "target") {
        request.personal.target = { ...request.personal.target, lifecycleRevision: "replacement" };
      }
      if (change === "participant") {
        request.personal.originalParticipant = { type: "profile", id: "person-b" };
      }
      if (change === "source") {
        request.sources = [{ agentId: "example", sessionKey: "agent:example:other" }];
      }
      if (change === "mode") {
        f.changeMode();
      }
      if (change === "endpoint") {
        f.revokeEndpoint();
      }
      if (change === "forged") {
        request.preparedAdmission = structuredClone(descriptor);
      }
      try {
        await expect(preparePersonalConversationRead(request)).rejects.toThrow();
        expect(native.prepare).toHaveBeenCalledTimes(3);
      } finally {
        descriptor.release();
      }
      expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    },
  );

  it.each([
    "source-incarnation",
    "root-incarnation",
    "physical-store",
    "shared-reader",
    "visibility",
    "public-share",
  ] as const)("rechecks retained native facts after %s changes", async (change) => {
    const f = fixture();
    const original = await preparePersonalConversationRead(f.original);
    const descriptor = original.prepareAdmission();
    original.release();
    if (change === "source-incarnation") {
      f.source.entry.lifecycleRevision = "replacement";
    }
    if (change === "root-incarnation") {
      f.rootRow.entry.lifecycleRevision = "replacement";
    }
    if (change === "physical-store") {
      f.source.readSource = { ...f.source.readSource!, databaseIdentity: "replacement" };
    }
    if (change === "shared-reader") {
      f.members.get(f.source.canonicalKey)!.add("person-b");
    }
    if (change === "visibility") {
      f.recipient.entry.visibility = "shared";
    }
    if (change === "public-share") {
      f.recipient.entry.publicShare = {
        id: "synthetic",
        sessionId: f.recipient.entry.sessionId,
        createdAt: 1,
      };
    }
    try {
      await expect(preparePersonalConversationRead(f.fresh(descriptor))).rejects.toThrow();
      expect(native.prepare).toHaveBeenCalledTimes(3);
    } finally {
      descriptor.release();
    }
    expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });
});
