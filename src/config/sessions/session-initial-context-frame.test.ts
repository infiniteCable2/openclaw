import { beforeEach, expect, it, vi } from "vitest";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { PreparedConversationBranchCreation } from "./conversation-branch-creation.js";
import { issuePersonalConversationContributionRange } from "./conversation-knowledge-source-custody.js";
import type {
  ConversationKnowledgeBranch,
  NativeKnowledgeRootEvidence,
} from "./conversation-knowledge-store.js";
import {
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReference,
} from "./conversation-knowledge.js";
import {
  borrowPreparedConversationKnowledgeInitialFrame,
  prepareConversationKnowledgeInitialFrame,
  type PreparedConversationKnowledgeInitialFrame,
} from "./session-initial-context-frame.js";
import { assertInitialSessionContextReadSource } from "./session-initial-context.js";
import {
  prepareSessionSourceAuthority,
  type SessionSourcePredicate,
} from "./session-source-authority.js";

const native = vi.hoisted(() => ({ evidence: {}, original: vi.fn(), creation: vi.fn() }));
// mock-isolation: Native root admission is independently covered by storage scenarios; this suite owns frame sealing.
vi.mock("./conversation-knowledge-store.js", () => ({
  assertNativeKnowledgeRootContribution(evidence: unknown) {
    if (evidence !== native.evidence) {
      throw new Error("Native root evidence refused");
    }
  },
}));
// mock-isolation: Separate fresh native destination checks from retained broker/donor frame custody.
vi.mock("./conversation-branch-creation.js", () => ({
  assertConversationBranchCreation: (params: unknown) => native.creation(params),
  consumeConversationBranchCreation: (params: unknown) => native.creation(params),
}));

beforeEach(() => vi.clearAllMocks());

function fixture() {
  const participant = { type: "profile" as const, id: "person-example" };
  const branch: ConversationKnowledgeBranch = {
    agentId: "example",
    storePath: "/synthetic/frame.sqlite",
    sessionKey: "agent:example:broker",
    sessionId: "broker",
    lifecycleRevision: "broker-life",
    root: {
      sessionKey: "agent:example:internal:conversation-root",
      sessionId: "root",
      lifecycleRevision: "root-life",
    },
  };
  const physical = {
    agentId: branch.agentId,
    path: branch.storePath,
    databaseIdentity: "physical",
  };
  const audience: ConversationPrivateAudience = {
    ...branch,
    channelId: "example",
    accountId: "default",
    nativeChannelId: "private",
    participant,
    assertCurrent() {},
  };
  let active = true;
  let config: OpenClawConfig = {
    agents: { entries: { example: { conversationMode: "branches" } } },
  };
  const check = () => {
    if (!active) {
      throw new Error("Original broker revoked");
    }
  };
  const through = {
    ...branch,
    generation: "donor-generation",
    rawSeq: 1,
    entryId: "original",
    activeMessagePosition: 0,
    effectiveParentId: null,
  };
  const reference: ConversationKnowledgeReference = {
    version: 1,
    kind: "utterance-observation",
    role: "user",
    sourceMode: "branches",
    source: branch,
    origin: conversationKnowledgeOrigin(branch, "utterance-observation"),
    through,
    privateAudience: { participant, admission: through },
  };
  const version = { generation: "donor-generation", rawSeq: 1, updatedAt: 1 };
  const predicate: SessionSourcePredicate = {
    source: physical,
    sessionKey: branch.sessionKey,
    fields: ["sessionId", "lifecycleRevision", "visibility"],
    expected: {
      sessionId: branch.sessionId,
      lifecycleRevision: branch.lifecycleRevision,
      visibility: "draft",
    },
    members: [],
    transcript: { sessionId: branch.sessionId, version, consistency: "prefix" },
  };
  const rootPredicate: SessionSourcePredicate = {
    source: physical,
    sessionKey: branch.root.sessionKey,
    fields: ["sessionId", "lifecycleRevision", "createdActor", "visibility", "incognito"],
    expected: {
      sessionId: branch.root.sessionId,
      lifecycleRevision: branch.root.lifecycleRevision,
      visibility: "draft",
      createdActor: { type: "system", id: "conversation-root" },
    },
  };
  const release = vi.fn();
  const prepare = vi.fn(async () => {
    check();
    return {
      assertCurrent: check,
      assertPreparedCurrent: check,
      release,
      checks: [predicate, rootPredicate].map((selected) => ({
        predicate: selected,
        refuse: (): never => {
          throw new Error("Source changed");
        },
      })),
    };
  });
  const source = Object.assign(check, { prepareSessionSource: prepare });
  const claim = {
    reference,
    predicate,
    sessionId: branch.sessionId,
    version,
    through,
    from: through,
  };
  const range = issuePersonalConversationContributionRange({
    reference,
    target: branch,
    source,
    range: {
      origin: reference.origin,
      originalLifecycleRevision: branch.lifecycleRevision,
      currentLifecycleRevision: branch.lifecycleRevision,
      through,
      from: through,
      version,
    },
  });
  const packetText = JSON.stringify({
    source: reference.origin,
    sourceSessionKey: reference.source.sessionKey,
    throughEntryId: reference.through.entryId,
    observations: [{ speaker: "user", text: "A genuine prepared original." }],
  });
  const params = {
    context: {
      source: physical,
      sourceSessionKey: branch.root.sessionKey,
      sourceEntry: {
        sessionId: branch.root.sessionId,
        lifecycleRevision: branch.root.lifecycleRevision,
      },
      sourceVersion: { generation: "root-generation", rawSeq: 2, updatedAt: 2 },
      projection: {
        branch,
        claims: [claim],
        packets: [
          {
            receipt: reference,
            text: packetText,
            offset: 0,
            nextOffset: packetText.length,
            complete: true,
            sourceClaim: 0,
          },
        ],
      },
    },
    evidence: native.evidence as NativeKnowledgeRootEvidence,
    ranges: [range],
    participant,
    audience,
    source,
    getRuntimeConfig: () => config,
  };
  native.creation.mockImplementation(
    ({ creation }: { creation: PreparedConversationBranchCreation }) => {
      creation.source();
      return physical;
    },
  );
  function destination(id: string, targetParticipant = participant) {
    let alive = true;
    const target = {
      ...branch,
      sessionKey: `agent:example:${id}`,
      sessionId: id,
      lifecycleRevision: `${id}-life`,
    };
    const creation = {
      branch: target,
      participant: targetParticipant,
      source: Object.assign(
        () => {
          if (!alive) {
            throw new Error("Destination revoked");
          }
        },
        { prepareSessionSource: async () => ({ assertCurrent() {}, checks: [] }) },
      ),
    } as unknown as PreparedConversationBranchCreation;
    return {
      creation,
      audience: { ...audience, sessionKey: target.sessionKey, participant: targetParticipant },
      assertCurrent() {},
      revoke() {
        alive = false;
      },
    };
  }
  return {
    params,
    prepare,
    release,
    destination,
    revoke() {
      active = false;
    },
    changeConfig() {
      config = {};
    },
  };
}

it("requires real root evidence and a branded selected range before issuing a frame", async () => {
  const f = fixture();
  await expect(
    prepareConversationKnowledgeInitialFrame({
      ...f.params,
      evidence: {} as NativeKnowledgeRootEvidence,
    }),
  ).rejects.toThrow("Native root evidence refused");
  await expect(
    prepareConversationKnowledgeInitialFrame({
      ...f.params,
      ranges: [structuredClone(f.params.ranges[0]!)],
    }),
  ).rejects.toThrow("custody changed");
});

it("borrows independently for two destinations without preparing donor authority again", async () => {
  const f = fixture();
  const frame = await prepareConversationKnowledgeInitialFrame(f.params);
  const firstTarget = f.destination("first");
  const secondTarget = f.destination("second");
  const first = await borrowPreparedConversationKnowledgeInitialFrame({ frame, ...firstTarget });
  const second = await borrowPreparedConversationKnowledgeInitialFrame({ frame, ...secondTarget });
  const firstSource = await prepareSessionSourceAuthority(first.source);
  const secondSource = await prepareSessionSourceAuthority(second.source);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(first.context.targetSessionId).toBe("first");
  expect(second.context.targetSessionId).toBe("second");
  expect(first.context.projection.claims).toEqual(second.context.projection.claims);
  expect(() =>
    assertInitialSessionContextReadSource(
      structuredClone(first.context),
      firstSource.checks.map((c) => c.predicate),
    ),
  ).not.toThrow();
  expect(() =>
    assertInitialSessionContextReadSource(
      first.context,
      secondSource.checks.map((c) => c.predicate),
    ),
  ).toThrow("retained native frame");
  firstTarget.revoke();
  expect(() => first.source()).toThrow("Destination revoked");
  expect(() => second.source()).not.toThrow();
  await frame.release();
  await frame.release();
  expect(f.release).toHaveBeenCalledOnce();
});

it("rejects a forged frame, changed payload and cloned predicate seal", async () => {
  const f = fixture();
  await expect(
    borrowPreparedConversationKnowledgeInitialFrame({
      frame: {} as PreparedConversationKnowledgeInitialFrame,
      ...f.destination("target"),
    }),
  ).rejects.toThrow("native issuer");
  const frame = await prepareConversationKnowledgeInitialFrame(f.params);
  const prepared = await borrowPreparedConversationKnowledgeInitialFrame({
    frame,
    ...f.destination("target"),
  });
  const source = await prepareSessionSourceAuthority(prepared.source);
  const predicates = source.checks.map((c) => c.predicate);
  const changed = structuredClone(prepared.context);
  changed.projection.packets[0]!.text = "Injected substitute";
  expect(() => assertInitialSessionContextReadSource(changed, predicates)).toThrow(
    "retained native frame",
  );
  expect(() =>
    assertInitialSessionContextReadSource(prepared.context, structuredClone(predicates)),
  ).toThrow("retained native frame");
  await frame.release();
});

it("refuses another person, a revoked original broker and configuration replacement", async () => {
  const f = fixture();
  const frame = await prepareConversationKnowledgeInitialFrame(f.params);
  await expect(
    borrowPreparedConversationKnowledgeInitialFrame({
      frame,
      ...f.destination("other", { type: "profile", id: "another-person" }),
    }),
  ).rejects.toThrow("creating destination");
  const prepared = await borrowPreparedConversationKnowledgeInitialFrame({
    frame,
    ...f.destination("valid"),
  });
  f.revoke();
  expect(() => prepared.source()).toThrow("Original broker revoked");
  await frame.release();
  const next = fixture();
  const nextFrame = await prepareConversationKnowledgeInitialFrame(next.params);
  next.changeConfig();
  expect(() => nextFrame.assertCurrent()).toThrow("configuration changed");
  await nextFrame.release();
});
