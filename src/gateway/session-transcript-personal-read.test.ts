import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import { prepareSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import type { PersonalConversationReadParams } from "./session-transcript-personal-read.js";

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
// mock-isolation: Exercise the actual native read API without starting a database worker or Gateway.
vi.mock("./session-sharing-preparation.js", () => ({ prepareSessionMutationFacts: mocks.prepare }));
import { prepareTranscriptReadAuthority } from "./session-transcript-read-authority.js";

function fixture() {
  const agentId = "example";
  const root = {
    sessionKey: "agent:example:main",
    sessionId: "root-a",
    lifecycleRevision: "root-life-a",
  };
  const target = {
    agentId,
    sessionKey: "agent:example:target",
    sessionId: "target-a",
    lifecycleRevision: "target-life-a",
    storePath: "/example/store.sqlite",
    root,
  };
  const participant = { type: "profile" as const, id: "person-a" };
  const membership = {
    version: 1 as const,
    role: "branch" as const,
    rootSessionKey: root.sessionKey,
    rootSessionId: root.sessionId,
    rootSessionLifecycleRevision: root.lifecycleRevision,
  };
  const readSource = {
    agentId,
    path: target.storePath,
    databaseIdentity: "database-a",
    databaseBirthtime: "birth-a",
  };
  const row = (
    key: string,
    sessionId: string,
    lifecycleRevision: string,
  ): SessionSharingTarget => ({
    agentId,
    canonicalKey: key,
    storeKey: key,
    storeKeys: [key],
    storePath: target.storePath,
    readSource: { ...readSource },
    entry: {
      sessionId,
      lifecycleRevision,
      updatedAt: 1,
      chatType: "direct",
      conversationTopology: { ...membership },
      participantCount: 1,
      participants: [{ identity: participant }],
    },
  });
  const recipient = row(target.sessionKey, target.sessionId, target.lifecycleRevision);
  const source = row("agent:example:source", "source-a", "source-life-a");
  const rootRow = row(root.sessionKey, root.sessionId, root.lifecycleRevision);
  rootRow.entry = {
    sessionId: root.sessionId,
    lifecycleRevision: root.lifecycleRevision,
    updatedAt: 1,
    conversationTopology: { version: 1, role: "root" },
    createdVia: "internal",
    createdActor: { type: "system", id: "conversation-root" },
    visibility: "draft",
    delivery: { kind: "none" },
  };
  const rows = new Map([recipient, source, rootRow].map((value) => [value.canonicalKey, value]));
  const members = new Map([...rows.keys()].map((key) => [key, new Set<string>()]));
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const prepare = async ({ sessionKey }: { sessionKey: string }) => {
    const release = vi.fn();
    releases.push(release);
    return {
      readCurrent: () => {
        const selected = rows.get(sessionKey);
        if (!selected) {
          throw new Error("Native row removed");
        }
        return { target: selected, membership: members.get(sessionKey)! };
      },
      release,
    };
  };
  mocks.prepare.mockImplementation(prepare);
  let current = true;
  let config: OpenClawConfig = {
    agents: { entries: { example: { conversationMode: "branches" } } },
  };
  const assertCurrent = vi.fn(() => {
    if (!current) {
      throw new Error("Original input source revoked");
    }
  });
  const params: PersonalConversationReadParams = {
    purpose: "conversation-differences" as const,
    personal: { originalParticipant: participant, assertCurrent, target },
    getRuntimeConfig: () => config,
    sources: [{ agentId, sessionKey: source.canonicalKey }],
  };
  return {
    params,
    recipient,
    source,
    rootRow,
    rows,
    members,
    releases,
    prepare,
    setConfig: (value: OpenClawConfig) => {
      config = value;
    },
    revoke: () => {
      current = false;
    },
  };
}

beforeEach(() => {
  mocks.prepare.mockReset();
});

describe("same-person conversation differences on native transcript read owner", () => {
  it("allows exact private sibling reads without any operator authority and retains all native predicates", async () => {
    const f = fixture();
    f.members.get(f.recipient.canonicalKey)!.add("person-a");
    f.members.get(f.source.canonicalKey)!.add("person-a");
    f.source.storeKey = "agent:example:actual-source-row";
    const grant = await prepareTranscriptReadAuthority(f.params);
    expect(grant.sources).toMatchObject([
      { canonicalKey: f.source.canonicalKey, sessionId: "source-a" },
    ]);
    const prepared = await prepareSessionSourceAuthority(grant.assertCurrent);
    expect(prepared.checks).toHaveLength(3);
    expect(prepared.checks.map((check) => check.predicate.sessionKey)).toEqual([
      f.recipient.storeKey,
      f.rootRow.storeKey,
      f.source.storeKey,
    ]);
    for (const check of prepared.checks) {
      expect(check.predicate.fields).toEqual(
        expect.arrayContaining([
          "conversationTopology",
          "participants",
          "participantCount",
          "chatType",
          "incognito",
        ]),
      );
    }
    expect(f.releases.every((release) => release.mock.calls.length === 0)).toBe(true);
    await prepared.release?.();
    grant.release();
    grant.release();
    expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(() => grant.assertCurrent()).toThrow("released");
  });

  it.each([
    "other-person",
    "group",
    "mixed",
    "unconfirmed",
    "incognito",
    "different-root",
    "different-store",
    "root-source",
    "unknown-participant",
    "foreign-target-member",
    "foreign-source-member",
  ] as const)("refuses %s without an operator or fallback grant", async (change) => {
    const f = fixture();
    if (change === "other-person") {
      f.source.entry.participants = [{ identity: { type: "profile", id: "other-person" } }];
    }
    if (change === "group") {
      f.source.entry.chatType = "group";
    }
    if (change === "mixed") {
      f.source.entry.participantCount = 2;
    }
    if (change === "unconfirmed") {
      f.source.entry.participantCount = 0;
      f.source.entry.participants = [];
    }
    if (change === "incognito") {
      f.source.entry.incognito = true;
    }
    if (change === "different-root") {
      f.source.entry.conversationTopology = {
        version: 1,
        role: "branch",
        rootSessionKey: "agent:example:other-root",
        rootSessionId: "other-root",
        rootSessionLifecycleRevision: "other-life",
      };
    }
    if (change === "different-store") {
      f.source.storePath = "/example/other.sqlite";
    }
    if (change === "root-source") {
      f.params.sources[0]!.sessionKey = f.rootRow.canonicalKey;
    }
    if (change === "unknown-participant") {
      f.params.personal.originalParticipant = {
        type: "observation",
        pluginId: "example-channel",
        accountId: null,
        senderKind: "unknown",
        id: "device-a",
      } satisfies SessionParticipantIdentity;
    }
    if (change === "foreign-target-member") {
      f.members.get(f.recipient.canonicalKey)!.add("person-b");
    }
    if (change === "foreign-source-member") {
      f.members.get(f.source.canonicalKey)!.add("person-b");
    }
    await expect(prepareTranscriptReadAuthority(f.params)).rejects.toThrow();
    expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it.each([
    "unenrolled-target",
    "unenrolled-source",
    "cross-agent",
    "root-incarnation",
    "root-physical-generation",
    "target-incarnation",
  ] as const)("does not admit %s", async (change) => {
    const f = fixture();
    if (change === "unenrolled-target") {
      delete f.recipient.entry.conversationTopology;
    }
    if (change === "unenrolled-source") {
      delete f.source.entry.conversationTopology;
    }
    if (change === "cross-agent") {
      f.params.sources[0]!.agentId = "other-agent";
    }
    if (change === "root-incarnation") {
      f.rootRow.entry.sessionId = "replacement-root";
    }
    if (change === "root-physical-generation") {
      f.rootRow.readSource = { ...f.rootRow.readSource!, databaseIdentity: "different-generation" };
    }
    if (change === "target-incarnation") {
      f.recipient.entry.sessionId = "replacement-target";
    }
    await expect(prepareTranscriptReadAuthority(f.params)).rejects.toThrow();
    expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it("retains exact same-person read authority for enrolled sessions after returning to native mode", async () => {
    const f = fixture();
    f.setConfig({ agents: { entries: { example: { conversationMode: "native" } } } });
    const grant = await prepareTranscriptReadAuthority(f.params);
    try {
      expect(grant.sources).toMatchObject([
        { canonicalKey: f.source.canonicalKey, sessionId: "source-a" },
      ]);
      expect(() => grant.assertCurrent()).not.toThrow();
      f.setConfig({ agents: { entries: { example: { conversationMode: "branches" } } } });
      expect(() => grant.assertCurrent()).toThrow("mode changed");
    } finally {
      grant.release();
    }
    expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it("rechecks the original target after each awaited source preparation", async () => {
    const f = fixture();
    mocks.prepare.mockImplementation(async (request) => {
      const held = await f.prepare(request);
      if (request.sessionKey === f.source.canonicalKey) {
        f.recipient.entry.chatType = "channel";
      }
      return held;
    });
    await expect(prepareTranscriptReadAuthority(f.params)).rejects.toThrow("changed");
    expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it.each([
    "source-incarnation",
    "participant",
    "input-revocation",
    "mode-revocation",
    "membership",
  ] as const)("revokes a retained purpose after %s", async (change) => {
    const f = fixture();
    const grant = await prepareTranscriptReadAuthority(f.params);
    const prepared = await prepareSessionSourceAuthority(grant.assertCurrent);
    if (change === "source-incarnation") {
      f.source.entry.lifecycleRevision = "replacement-source";
    }
    if (change === "participant") {
      f.source.entry.participantCount = 2;
    }
    if (change === "input-revocation") {
      f.revoke();
    }
    if (change === "mode-revocation") {
      f.setConfig({});
    }
    if (change === "membership") {
      f.members.get(f.source.canonicalKey)!.add("person-b");
    }
    expect(() => grant.assertCurrent()).toThrow();
    expect(() => prepared.checks.at(-1)!.refuse({ entry: f.source.entry })).toThrow();
    await prepared.release?.();
    grant.release();
  });

  it("keeps ordinary transcript history on the unchanged operator-required route", async () => {
    const f = fixture();
    await expect(
      prepareTranscriptReadAuthority({
        authority: undefined!,
        getRuntimeConfig: () => f.params.getRuntimeConfig(),
        sources: f.params.sources,
      }),
    ).rejects.toThrow();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
