import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeKnowledgeRootEvidence } from "../config/sessions/conversation-knowledge-store.js";
import {
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReference,
} from "../config/sessions/conversation-knowledge.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import { prepareSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import {
  PersonalConversationReadRefusedError,
  preparePersonalConversationContributionGroup,
  type PersonalConversationReadParams,
} from "./session-transcript-personal-read.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  anchors: vi.fn(),
  root: vi.fn(),
  groupPrepare: vi.fn(),
  groupAssert: vi.fn(),
}));
// mock-isolation: Exercise the actual native read API without starting a database worker or Gateway.
vi.mock("./session-sharing-preparation.js", () => ({ prepareSessionMutationFacts: mocks.prepare }));
// mock-isolation: Supply exact synthetic root membership to exercise real personal grants and COMMIT predicates without opening native root storage.
vi.mock("../config/sessions/conversation-knowledge-store.js", () => ({
  assertNativeKnowledgeRootContribution: mocks.root,
  prepareNativeKnowledgeRootContributionGroup: mocks.groupPrepare,
  assertNativeKnowledgeRootContributionGroup: mocks.groupAssert,
}));
// mock-isolation: Control exact anchor/prefix revisions and count batching calls without spawning native transcript readers.
vi.mock("../config/sessions/session-transcript-anchor-read.js", () => ({
  readSessionTranscriptAnchorsAsync: mocks.anchors,
}));
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
    // The native Gateway retains its logical selector beside the physical source.
    storePath: "/example/agents/example/sessions/sessions.json",
    readSource: { ...readSource },
    entry: {
      sessionId,
      lifecycleRevision,
      updatedAt: 1,
      chatType: "direct",
      visibility: "draft",
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
    participant,
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
  mocks.root.mockReset();
  mocks.anchors.mockReset();
  mocks.groupPrepare.mockReset();
  mocks.groupAssert.mockReset();
});

describe("same-person conversation differences on native transcript read owner", () => {
  it("refuses another profile's draft even when its recorded participant matches", async () => {
    const f = fixture();
    f.recipient.entry.createdActor = { type: "human", source: "profile", id: "person-b" };
    const denied = prepareTranscriptReadAuthority(f.params);
    await expect(denied).rejects.toBeInstanceOf(PersonalConversationReadRefusedError);
    await expect(denied).rejects.toThrow("another Gateway profile creator");
    f.recipient.entry.createdActor.id = "person-a";
    const grant = await prepareTranscriptReadAuthority(f.params);
    grant.release();
  });
  it("preserves a transient facts failure and allows a fresh native read after recovery", async () => {
    const f = fixture();
    const failure = new Error("Synthetic facts worker unavailable");
    mocks.prepare.mockImplementationOnce(f.prepare).mockRejectedValueOnce(failure);
    await expect(prepareTranscriptReadAuthority(f.params)).rejects.toBe(failure);
    expect(failure).not.toBeInstanceOf(PersonalConversationReadRefusedError);
    expect(f.releases).toHaveLength(1);
    expect(f.releases[0]).toHaveBeenCalledOnce();
    const grant = await prepareTranscriptReadAuthority(f.params);
    expect(grant.sources).toHaveLength(1);
    grant.release();
    expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });
  it.each(["profile", "remote"] as const)(
    "refuses shared and default-shared %s destinations even with original private ingress",
    async (kind) => {
      for (const visibility of ["shared", undefined] as const) {
        const f = fixture();
        const participant: SessionParticipantIdentity =
          kind === "profile"
            ? f.params.personal.originalParticipant
            : {
                type: "remote",
                pluginId: "matrix",
                domain: "example.test",
                idKind: "user-id",
                id: "@person-a:example.test",
              };
        f.params.personal.originalParticipant = participant;
        f.recipient.entry.participants = [{ identity: participant }];
        f.source.entry.participants = [{ identity: participant }];
        f.recipient.entry.visibility = visibility;
        f.params.personal.targetAudience = {
          agentId: f.params.personal.target.agentId,
          sessionKey: f.recipient.canonicalKey,
          channelId: kind === "remote" ? "matrix" : "webchat",
          accountId: "default",
          nativeChannelId: "private-conversation",
          participant,
          assertCurrent() {},
        };
        await expect(prepareTranscriptReadAuthority(f.params)).rejects.toThrow(
          "destination is visible to other Gateway readers",
        );
        expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
      }
    },
  );

  it("retains private Matrix destinations and fences sharing changes at COMMIT", async () => {
    const f = fixture();
    const participant: SessionParticipantIdentity = {
      type: "remote",
      pluginId: "matrix",
      domain: "example.test",
      idKind: "user-id",
      id: "@person-a:example.test",
    };
    f.params.personal.originalParticipant = participant;
    f.recipient.entry.participants = [{ identity: participant }];
    f.source.entry.participants = [{ identity: participant }];
    f.params.personal.targetAudience = {
      agentId: f.params.personal.target.agentId,
      sessionKey: f.recipient.canonicalKey,
      channelId: "matrix",
      accountId: "default",
      nativeChannelId: "private-conversation",
      participant,
      assertCurrent() {},
    };
    const grant = await prepareTranscriptReadAuthority(f.params);
    try {
      const prepared = await prepareSessionSourceAuthority(grant.assertCurrent);
      try {
        const destination = prepared.checks.find(
          ({ predicate }) => predicate.sessionKey === f.recipient.storeKey,
        );
        expect(destination?.predicate.fields).toContain("visibility");
        expect(destination?.predicate.expected?.visibility).toBe("draft");
        f.recipient.entry.visibility = "shared";
        expect(() => grant.assertCurrent()).toThrow("changed after admission");
        expect(() => destination?.refuse({ entry: f.recipient.entry })).toThrow();
      } finally {
        await prepared.release?.();
      }
    } finally {
      grant.release();
    }
  });

  it("allows exact private sibling reads without any operator authority and retains all native predicates", async () => {
    const f = fixture();
    f.members.get(f.recipient.canonicalKey)!.add("person-a");
    f.members.get(f.source.canonicalKey)!.add("person-a");
    f.source.storeKey = "agent:example:actual-source-row";
    const grant = await prepareTranscriptReadAuthority(f.params);
    expect(grant.sources).toMatchObject([
      {
        canonicalKey: f.source.canonicalKey,
        sessionId: "source-a",
        storePath: f.params.personal.target.storePath,
      },
    ]);
    const prepared = await prepareSessionSourceAuthority(grant.assertCurrent);
    expect(prepared.checks).toHaveLength(3);
    expect(
      prepared.checks.every(
        (check) => check.predicate.source.path === f.params.personal.target.storePath,
      ),
    ).toBe(true);
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
    "destination-as-source",
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
      f.source.readSource = { ...f.source.readSource!, path: "/example/other.sqlite" };
    }
    if (change === "root-source") {
      f.params.sources[0]!.sessionKey = f.rootRow.canonicalKey;
    }
    if (change === "destination-as-source") {
      f.params.sources[0]!.sessionKey = f.recipient.canonicalKey;
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

  it.each(["person", "observation", "agent"] as const)(
    "rechecks a fresh %s actor change between source assertion and COMMIT preparation",
    async (kind) => {
      const f = fixture();
      f.params.personal.targetAudience = {
        agentId: f.params.personal.target.agentId,
        sessionKey: f.recipient.canonicalKey,
        channelId: "example-channel",
        accountId: "default",
        nativeChannelId: "private-room",
        participant: f.params.personal.originalParticipant,
        assertCurrent() {},
      };
      let armed = false;
      let recipientReads = 0;
      const addition: SessionParticipantIdentity =
        kind === "person"
          ? { type: "profile", id: "another-person" }
          : kind === "agent"
            ? { type: "agent", id: "internal-helper" }
            : {
                type: "observation",
                pluginId: "example-channel",
                accountId: "default",
                senderKind: "unknown",
                id: "unknown-device",
              };
      mocks.prepare.mockImplementation(async (request: { sessionKey: string }) => {
        const held = await f.prepare(request);
        return {
          ...held,
          readCurrent() {
            // The first recipient read belongs to assertCurrent(). The second
            // refreshes its native COMMIT predicate; simulate a foreign commit
            // at that precise read boundary, not an earlier revoked assertion.
            if (
              armed &&
              request.sessionKey === f.recipient.canonicalKey &&
              ++recipientReads === 2
            ) {
              f.recipient.entry.participants!.push({ identity: addition });
              f.recipient.entry.participantCount = f.recipient.entry.participants!.length;
            }
            return held.readCurrent();
          },
        };
      });
      const grant = await prepareTranscriptReadAuthority(f.params);
      try {
        armed = true;
        const prepared = prepareSessionSourceAuthority(grant.assertCurrent);
        if (kind === "agent") {
          const accepted = await prepared;
          try {
            expect(accepted.checks[0]?.predicate).toMatchObject({
              fields: expect.arrayContaining(["participants", "participantCount"]),
              expected: {
                participantCount: 2,
                participants: f.recipient.entry.participants,
              },
            });
          } finally {
            await accepted.release?.();
          }
        } else {
          await expect(prepared).rejects.toThrow("recipients changed during source preparation");
          expect(() => grant.assertCurrent()).toThrow();
        }
        expect(recipientReads).toBe(2);
      } finally {
        grant.release();
      }
      expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    },
  );

  it.each([
    "source-incarnation",
    "participant",
    "input-revocation",
    "mode-revocation",
    "membership",
    "logical-selector",
    "physical-identity",
    "physical-birthtime",
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
    if (change === "logical-selector") {
      f.source.storePath = "/example/other-selector.json";
    }
    if (change === "physical-identity") {
      f.source.readSource = { ...f.source.readSource!, databaseIdentity: "replacement-database" };
    }
    if (change === "physical-birthtime") {
      f.source.readSource = { ...f.source.readSource!, databaseBirthtime: "replacement-birthtime" };
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

function historicalFixture(count = 2, own = false) {
  const f = fixture();
  const source = own ? f.recipient : f.source;
  const historicalReferences: ConversationKnowledgeReference[] = Array.from(
    { length: count },
    (_, index) => {
      const original = {
        agentId: f.params.personal.target.agentId,
        sessionKey: source.canonicalKey,
        sessionId: source.entry.sessionId,
        lifecycleRevision: "before-reset",
      };
      const anchor = {
        ...original,
        storePath: f.params.personal.target.storePath,
        generation: "original-generation",
        entryId: `entry-${index}`,
        rawSeq: index + 1,
        activeMessagePosition: index + 1,
        effectiveParentId: index ? `entry-${index - 1}` : null,
      };
      return {
        version: 1,
        kind: "utterance-observation",
        role: "user",
        sourceMode: "branches",
        source: original,
        origin: conversationKnowledgeOrigin(original, "utterance-observation"),
        through: anchor,
        privateAudience: { participant: f.participant, admission: anchor },
      };
    },
  );
  const evidence = {} as NativeKnowledgeRootEvidence;
  mocks.root.mockImplementation((value, _target, reference) => {
    if (
      value !== evidence ||
      !historicalReferences.some((item) => JSON.stringify(item) === JSON.stringify(reference))
    ) {
      throw new Error("No exact native root evidence");
    }
  });
  mocks.groupPrepare.mockImplementation((value, target, groupReferences) => {
    for (const reference of groupReferences) {
      mocks.root(value, target, reference);
    }
    return Object.freeze({ evidence: value, root: JSON.stringify(target.root) });
  });
  mocks.groupAssert.mockImplementation((value, target, proof) => {
    if (value !== proof.evidence || JSON.stringify(target.root) !== proof.root) {
      throw new Error("Prepared root group scope changed");
    }
  });
  const anchors = historicalReferences.map((reference) => ({ ...reference.through }));
  mocks.anchors.mockImplementation(async (_scope, selection) => {
    if (
      selection.contextValidation &&
      anchors.some(
        (anchor, index) =>
          JSON.stringify(anchor) !== JSON.stringify(historicalReferences[index]!.through),
      )
    ) {
      throw new Error("Native prefix changed");
    }
    return {
      anchors: anchors.filter((anchor) => selection.entryIds.includes(anchor.entryId)),
      session: {
        sessionId: source.entry.sessionId,
        lifecycleRevision: source.entry.lifecycleRevision,
      },
      contextVersion: { generation: "original-generation", rawSeq: count + 2, updatedAt: 2 },
      ...(selection.contextValidation ? { contextValidated: true } : {}),
    };
  });
  const params = {
    ...f.params,
    sources: [{ agentId: f.params.personal.target.agentId, sessionKey: source.canonicalKey }],
    personal: { ...f.params.personal, rootEvidence: evidence },
  };
  return {
    ...f,
    selectedSource: source,
    references: historicalReferences,
    anchors,
    params,
    create: () =>
      preparePersonalConversationContributionGroup({
        ...params,
        personal: { ...params.personal, contributions: historicalReferences },
      }),
  };
}

describe("exact historical contribution groups", () => {
  it("rebinds one native custody per group, keeps original provenance, and fences the current lifecycle at COMMIT", async () => {
    const f = historicalFixture();
    const group = await f.create();
    expect(mocks.prepare).toHaveBeenCalledTimes(3);
    expect(mocks.anchors).toHaveBeenCalledTimes(1);
    const verifiedReferences = mocks.root.mock.calls.length;
    const grant = await prepareTranscriptReadAuthority({
      ...f.params,
      personal: { ...f.params.personal, contributionGroup: group },
    });
    try {
      expect(mocks.prepare).toHaveBeenCalledTimes(3);
      expect(mocks.anchors).toHaveBeenCalledTimes(2);
      expect(mocks.anchors.mock.calls[1]![1].entryIds).toEqual([]);
      expect(mocks.root).toHaveBeenCalledTimes(verifiedReferences);
      const before = mocks.root.mock.calls.length;
      for (const reference of f.references) {
        expect(grant.selectContribution(reference)).toMatchObject({
          origin: reference.origin,
          originalLifecycleRevision: "before-reset",
          currentLifecycleRevision: f.source.entry.lifecycleRevision,
          through: reference.through,
        });
      }
      expect(mocks.root).toHaveBeenCalledTimes(before);
      const prepared = await prepareSessionSourceAuthority(grant.assertCurrent);
      try {
        expect(
          prepared.checks.find(({ predicate }) => predicate.sessionKey === f.source.canonicalKey)
            ?.predicate,
        ).toMatchObject({
          expected: { lifecycleRevision: f.source.entry.lifecycleRevision },
          transcript: {
            sessionId: f.source.entry.sessionId,
            consistency: "prefix",
            version: { generation: "original-generation" },
          },
        });
        f.source.entry.lifecycleRevision = "another-reset";
        expect(() => grant.assertCurrent()).toThrow("changed after admission");
      } finally {
        await prepared.release?.();
      }
    } finally {
      grant.release();
      group.release();
    }
  });

  it.each([
    "unknown",
    "another-person",
    "shared",
    "replacement",
    "root",
    "incomplete",
    "two-people",
  ] as const)("refuses historical continuity with %s current facts", async (change) => {
    const f = historicalFixture();
    if (change === "unknown") {
      f.source.entry.participantCount = 0;
      f.source.entry.participants = [];
    }
    if (change === "another-person") {
      f.source.entry.participants = [{ identity: { type: "profile", id: "person-b" } }];
    }
    if (change === "shared") {
      f.source.entry.chatType = "group";
    }
    if (change === "replacement") {
      f.source.entry.sessionId = "replacement-id";
    }
    if (change === "root" && f.source.entry.conversationTopology?.role === "branch") {
      f.source.entry.conversationTopology.rootSessionId = "other-root";
    }
    if (change === "incomplete") {
      f.source.entry.participantCount = 2;
    }
    if (change === "two-people") {
      f.source.entry.participantCount = 2;
      f.source.entry.participants!.push({ identity: { type: "profile", id: "person-b" } });
    }
    await expect(f.create()).rejects.toBeInstanceOf(PersonalConversationReadRefusedError);
    expect(mocks.anchors).not.toHaveBeenCalled();
  });

  it("accepts a complete current person roster with known internal agent actors", async () => {
    const f = historicalFixture();
    f.source.entry.participants!.push({ identity: { type: "agent", id: "internal-worker" } });
    f.source.entry.participantCount = 2;
    const group = await f.create();
    group.release();
  });

  it("rejects changed native points, forged handles and range expansion", async () => {
    const f = historicalFixture();
    const group = await f.create();
    const request = { ...f.params, personal: { ...f.params.personal, contributionGroup: group } };
    try {
      await expect(
        prepareTranscriptReadAuthority({
          ...request,
          personal: { ...request.personal, rootEvidence: {} as NativeKnowledgeRootEvidence },
        }),
      ).rejects.toThrow("Prepared root group scope changed");
      await expect(
        prepareTranscriptReadAuthority({
          ...request,
          personal: { ...request.personal, contributionGroup: structuredClone(group) },
        }),
      ).rejects.toThrow("changed or expired");
      const grant = await prepareTranscriptReadAuthority(request);
      try {
        const changed = {
          ...f.references[0]!,
          through: { ...f.references[0]!.through, rawSeq: 99 },
        };
        expect(grant.selectContribution(changed)).toBeUndefined();
        const admission = grant.prepareAdmission();
        try {
          await expect(
            prepareTranscriptReadAuthority({
              ...f.params,
              preparedAdmission: admission,
              personal: { ...f.params.personal, contribution: f.references[0] },
            }),
          ).rejects.toThrow("changed or expired");
        } finally {
          admission.release();
        }
      } finally {
        grant.release();
      }
      f.anchors[0]!.effectiveParentId = "rewritten-parent";
      await expect(prepareTranscriptReadAuthority(request)).rejects.toThrow(
        "Native prefix changed",
      );
    } finally {
      group.release();
    }
    await expect(prepareTranscriptReadAuthority(request)).rejects.toThrow("changed or expired");
  });

  it("keeps native anchor queries within their cohort budget and fixes one prefix across pages", async () => {
    const f = historicalFixture(70);
    const group = await f.create();
    try {
      expect(mocks.anchors).toHaveBeenCalledTimes(2);
      expect(mocks.anchors.mock.calls[0]![1].entryIds).toHaveLength(63);
      expect(mocks.anchors.mock.calls[1]![1]).toMatchObject({
        contextValidation: { version: { rawSeq: 72 } },
      });
      const grant = await prepareTranscriptReadAuthority({
        ...f.params,
        personal: { ...f.params.personal, contributionGroup: group },
      });
      try {
        expect(mocks.anchors).toHaveBeenCalledTimes(3);
        expect(mocks.anchors.mock.calls[2]![1].entryIds).toEqual([]);
      } finally {
        grant.release();
      }
    } finally {
      group.release();
    }
  });

  it("permits old own-reset history but never creates a current self grant", async () => {
    const f = historicalFixture(1, true);
    const group = await f.create();
    try {
      const grant = await prepareTranscriptReadAuthority({
        ...f.params,
        personal: { ...f.params.personal, contributionGroup: group },
      });
      try {
        expect(grant.selectContribution(f.references[0]!)).toMatchObject({
          originalLifecycleRevision: "before-reset",
        });
      } finally {
        grant.release();
      }
    } finally {
      group.release();
    }
    f.references[0]!.source.lifecycleRevision = f.recipient.entry.lifecycleRevision!;
    await expect(f.create()).rejects.toThrow("original same-person branch source");
  });
});
