import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSharingTarget } from "../../gateway/session-sharing-policy.js";
import { preparePersonalConversationRead } from "../../gateway/session-transcript-personal-read.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  assertConversationBranchCreation,
  assertConversationBranchCreationRoot,
  consumeConversationBranchCreation,
  prepareConversationBranchCreation,
} from "./conversation-branch-creation.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import { createSessionEntryCreationOperation } from "./session-accessor.sqlite-entry-cache.types.js";
import type { prepareSessionGenerationFacts } from "./session-delivery-generation.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import type { SessionEntryCohortResult } from "./session-entry-read.types.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import type { InternalSessionEntry } from "./types.js";

const native = vi.hoisted(() => ({ generation: vi.fn(), sharing: vi.fn() }));
// mock-isolation: Control the existing generation owner's creation receipt without workers.
vi.mock("./session-delivery-generation.js", () => ({
  prepareSessionGenerationFacts: native.generation,
}));
// mock-isolation: Supply native sharing publications while exercising real personal-read policy.
vi.mock("../../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: native.sharing,
}));

function fixture() {
  const participant = { type: "profile" as const, id: "person-a" };
  const branch: ConversationKnowledgeBranch = {
    agentId: "example",
    sessionKey: "agent:example:connection",
    sessionId: "connection-a",
    lifecycleRevision: "connection-life",
    storePath: path.resolve("build/creation-contract/example.sqlite"),
    root: {
      sessionKey: "agent:example:internal:conversation-root",
      sessionId: "root-a",
      lifecycleRevision: "root-life",
    },
  };
  const root: InternalSessionEntry = {
    sessionId: branch.root.sessionId,
    lifecycleRevision: branch.root.lifecycleRevision,
    updatedAt: 1,
    createdVia: "internal",
    createdActor: { type: "system", id: "conversation-root" },
    visibility: "draft",
    delivery: { kind: "none" },
    conversationTopology: { version: 1, role: "root" },
  };
  const entry: InternalSessionEntry = {
    sessionId: branch.sessionId,
    lifecycleRevision: branch.lifecycleRevision,
    updatedAt: 1,
    visibility: "draft",
    chatType: "direct",
    createdActor: { type: "human", source: "profile", id: participant.id },
    conversationTopology: {
      version: 1,
      role: "branch",
      rootSessionKey: branch.root.sessionKey,
      rootSessionId: branch.root.sessionId,
      rootSessionLifecycleRevision: branch.root.lifecycleRevision,
    },
  };
  const source = {
    agentId: branch.agentId,
    path: branch.storePath,
    databaseIdentity: "physical-a",
    databaseBirthtime: "birth-a",
  };
  const read: SessionEntryCohortResult = {
    kind: "session-exact-entries",
    source,
    databaseIdentity: {
      identity: "physical-a",
      incarnation: "incarnation-a",
      filename: branch.storePath,
    },
    entries: [{ sessionKey: branch.root.sessionKey, entry: root }],
    lifecycleTimestamps: {},
    members: {},
  };
  const reader: SessionEntryCohortReader = {
    sessionKey: branch.root.sessionKey,
    logicalAgentId: branch.agentId,
    storePaths: [branch.storePath],
    database: { agentId: branch.agentId, path: branch.storePath, env: {} },
    assertCurrent() {},
    async withRead(_request, assertCurrent, consume) {
      assertCurrent();
      return consume(read, assertCurrent);
    },
  };
  let current = true;
  let adopted = false;
  let config: OpenClawConfig = {
    agents: { entries: { example: { conversationMode: "branches" } } },
  };
  let publish: Parameters<
    Awaited<ReturnType<typeof prepareSessionGenerationFacts>>["bindCreation"]
  >[1];
  const generation: Awaited<ReturnType<typeof prepareSessionGenerationFacts>> = {
    assertCurrent: () => {
      if (!current) {
        throw new Error("Native generation revoked");
      }
    },
    prepareRead: () => undefined,
    readSessionSettings: () => ({}),
    release: vi.fn(),
    bindCreation: vi.fn((_operation, publishBinding) => {
      publish = publishBinding;
      return () => generation.assertCurrent();
    }),
    isCreationAdopted: () => adopted,
  };
  native.generation.mockResolvedValue(generation);
  const audience: ConversationPrivateAudience = {
    agentId: branch.agentId,
    sessionKey: branch.sessionKey,
    channelId: "example",
    accountId: "default",
    nativeChannelId: "private-a",
    participant,
    assertCurrent() {},
  };
  const params = {
    branch,
    entry,
    reader,
    audience,
    getRuntimeConfig: () => config,
    assertCurrent: (() => {}) satisfies SessionSourceAssertion,
  };
  const donorKey = "agent:example:other-connection";
  const donor: InternalSessionEntry = {
    ...entry,
    sessionId: "donor-a",
    lifecycleRevision: "donor-life",
    participantCount: 1,
    participants: [{ identity: participant }],
  };
  const rows = new Map([
    [branch.root.sessionKey, root],
    [donorKey, donor],
  ]);
  native.sharing.mockImplementation(async ({ sessionKey }: { sessionKey: string }) => ({
    readCurrent() {
      const selected = rows.get(sessionKey);
      if (!selected) {
        throw new Error("Native target absent");
      }
      const target: SessionSharingTarget = {
        agentId: branch.agentId,
        canonicalKey: sessionKey,
        storeKey: sessionKey,
        storeKeys: [sessionKey],
        storePath: branch.storePath,
        readSource: source,
        entry: selected,
      };
      return { target, membership: new Set<string>() };
    },
    release() {},
  }));
  return {
    branch,
    root,
    entry,
    source,
    reader,
    read,
    generation,
    audience,
    params,
    participant,
    rows,
    donor,
    donorKey,
    revoke() {
      current = false;
    },
    changeConfig() {
      config = { agents: { entries: { example: { conversationMode: "native" } } } };
    },
    adopt(binding = { sessionId: branch.sessionId, lifecycleRevision: branch.lifecycleRevision }) {
      adopted = true;
      publish?.(binding);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("native private conversation creation capability", () => {
  it("retains root and absence predicates without inventing an existing destination", async () => {
    const f = fixture();
    const creation = await prepareConversationBranchCreation(f.params);
    expect(native.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: f.branch.sessionKey,
        sessionId: null,
        lifecycleRevision: null,
      }),
    );
    const prepared = await creation.source.prepareSessionSource!();
    expect(prepared.checks[0]?.predicate).toMatchObject({
      sessionKey: f.branch.sessionKey,
      expected: undefined,
      members: [],
    });
    expect(prepared.checks[1]?.predicate.fields).toContain("publicShare");
    expect(prepared.checks[1]?.predicate.fields).toContain("visibility");
    expect(() =>
      assertConversationBranchCreationRoot({
        creation,
        branch: f.branch,
        source: f.source,
        rootEntry: f.root,
      }),
    ).not.toThrow();
    expect(() =>
      assertConversationBranchCreationRoot({
        creation,
        branch: f.branch,
        source: f.source,
        currentEntry: f.entry,
        rootEntry: f.root,
      }),
    ).toThrow("absent destination");
    creation.release();
  });

  it("uses normal source custody for an absent creating recipient and rejects it without the capability", async () => {
    const f = fixture();
    const creation = await prepareConversationBranchCreation(f.params);
    const request = {
      purpose: "conversation-differences" as const,
      personal: {
        originalParticipant: f.participant,
        assertCurrent: f.params.assertCurrent,
        target: f.branch,
        targetAudience: f.audience,
      },
      getRuntimeConfig: f.params.getRuntimeConfig,
      sources: [{ agentId: f.branch.agentId, sessionKey: f.donorKey }],
    };
    await expect(preparePersonalConversationRead(request)).rejects.toThrow("Native target absent");
    native.sharing.mockClear();
    const grant = await preparePersonalConversationRead({
      ...request,
      personal: { ...request.personal, targetCreation: creation },
    });
    expect(native.sharing.mock.calls.map(([scope]) => scope.sessionKey)).toEqual([
      f.branch.root.sessionKey,
      f.donorKey,
    ]);
    const prepared = await grant.assertCurrent.prepareSessionSource!();
    expect(
      prepared.checks.some(
        ({ predicate }) =>
          predicate.sessionKey === f.branch.sessionKey && predicate.expected === undefined,
      ),
    ).toBe(true);
    f.donor.participants = [{ identity: { type: "profile", id: "person-b" } }];
    expect(() => grant.assertCurrent()).toThrow("source changed");
    grant.release();
    creation.release();
  });

  it("keeps creator adoption with the native owner and refuses new grants after commit", async () => {
    const f = fixture();
    const creation = await prepareConversationBranchCreation(f.params);
    const operation = createSessionEntryCreationOperation();
    const guard = creation.bindCreation(operation);
    expect(f.generation.bindCreation).toHaveBeenCalledWith(operation, expect.any(Function));
    f.adopt();
    expect(() => {
      guard();
      creation.source();
    }).not.toThrow();
    expect(() => consumeConversationBranchCreation({ creation, branch: f.branch })).toThrow(
      "already committed",
    );
    await expect(creation.source.prepareSessionSource!()).rejects.toThrow("already committed");
    creation.release();
    expect(f.generation.release).toHaveBeenCalledOnce();
    expect(() => creation.source()).toThrow("released");
  });

  it("never reuses creation-only custody as an ordinary recipient admission", async () => {
    const f = fixture();
    const creation = await prepareConversationBranchCreation(f.params);
    const request = {
      purpose: "conversation-differences" as const,
      personal: {
        originalParticipant: f.participant,
        assertCurrent: f.params.assertCurrent,
        target: f.branch,
        targetAudience: f.audience,
      },
      getRuntimeConfig: f.params.getRuntimeConfig,
      sources: [{ agentId: f.branch.agentId, sessionKey: f.donorKey }],
    };
    const grant = await preparePersonalConversationRead({
      ...request,
      personal: { ...request.personal, targetCreation: creation },
    });
    const preparedAdmission = grant.prepareAdmission();
    grant.release();
    native.sharing.mockClear();
    try {
      await expect(
        preparePersonalConversationRead({ ...request, preparedAdmission }),
      ).rejects.toThrow("changed or expired");
      expect(native.sharing).not.toHaveBeenCalled();
      const rebound = await preparePersonalConversationRead({
        ...request,
        personal: { ...request.personal, targetCreation: creation },
        preparedAdmission,
      });
      rebound.assertCurrent();
      rebound.release();
      expect(native.sharing).not.toHaveBeenCalled();
      creation.bindCreation(createSessionEntryCreationOperation());
      f.adopt();
      f.rows.set(f.branch.sessionKey, { ...f.entry, visibility: "shared" });
      await expect(
        preparePersonalConversationRead({
          ...request,
          personal: { ...request.personal, targetCreation: creation },
          preparedAdmission,
        }),
      ).rejects.toThrow("already committed");
      // Removing the now-consumed capability must not bypass that refusal.
      await expect(
        preparePersonalConversationRead({ ...request, preparedAdmission }),
      ).rejects.toThrow("changed or expired");
      expect(native.sharing).not.toHaveBeenCalled();
      // A genuinely fresh ordinary grant must hold and check the actual target row.
      await expect(preparePersonalConversationRead(request)).rejects.toThrow(
        "visible to other Gateway readers",
      );
      expect(native.sharing).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionKey: f.branch.sessionKey }),
      );
    } finally {
      preparedAdmission.release();
      creation.release();
    }
  });

  it("rejects substituted publication, person, incarnation and final draft bytes", async () => {
    const f = fixture();
    const creation = await prepareConversationBranchCreation(f.params);
    expect(() =>
      assertConversationBranchCreation({
        creation,
        branch: f.branch,
        participant: { type: "profile", id: "person-b" },
      }),
    ).toThrow("admitted destination");
    expect(() =>
      assertConversationBranchCreation({
        creation,
        branch: { ...f.branch, sessionId: "replacement" },
      }),
    ).toThrow("admitted destination");
    expect(() => creation.assertEntry({ ...f.entry, visibility: "shared" })).toThrow(
      "proposed entry",
    );
    expect(() =>
      creation.assertEntry({
        ...f.entry,
        totalTokens: undefined,
        totalTokensFresh: false,
        cliSessionIds: undefined,
      }),
    ).not.toThrow();
    creation.bindCreation(createSessionEntryCreationOperation());
    expect(() =>
      f.adopt({ sessionId: "replacement", lifecycleRevision: "replacement-life" }),
    ).toThrow("publication differs");
    expect(() => creation.source()).toThrow("released");
    creation.release();
  });

  it("does not weaken current audience, generation or configuration checks", async () => {
    const f = fixture();
    const creation = await prepareConversationBranchCreation(f.params);
    f.changeConfig();
    expect(() => creation.source()).toThrow("configuration changed");
    creation.release();
    const next = fixture();
    const other = await prepareConversationBranchCreation(next.params);
    next.revoke();
    expect(() => other.source()).toThrow("Native generation revoked");
    other.release();
  });

  it("refuses an existing row, mixed-person roster and nonprivate prospective entry", async () => {
    const f = fixture();
    f.read.entries.push({ sessionKey: f.branch.sessionKey, entry: f.entry });
    await expect(prepareConversationBranchCreation(f.params)).rejects.toThrow("absence or root");
    expect(f.generation.release).toHaveBeenCalledOnce();
    const next = fixture();
    await expect(
      prepareConversationBranchCreation({
        ...next.params,
        entry: { ...next.entry, visibility: "shared" },
      }),
    ).rejects.toThrow("private same-person");
    await expect(
      prepareConversationBranchCreation({
        ...next.params,
        entry: {
          ...next.entry,
          participantCount: 1,
          participants: [{ identity: { type: "profile", id: "person-b" } }],
        },
      }),
    ).rejects.toThrow("private same-person");
  });

  it("does not grant personal custody when an optional copy has an unconfirmed creator", async () => {
    const f = fixture();
    await expect(
      prepareConversationBranchCreation({
        ...f.params,
        audience: {
          ...f.audience,
          participant: {
            type: "remote",
            pluginId: "example",
            domain: "example.test",
            idKind: "user-id",
            id: "remote-person",
          },
        },
      }),
    ).rejects.toThrow("private same-person");
    expect(native.generation).not.toHaveBeenCalled();
    expect(native.sharing).not.toHaveBeenCalled();
  });
});
