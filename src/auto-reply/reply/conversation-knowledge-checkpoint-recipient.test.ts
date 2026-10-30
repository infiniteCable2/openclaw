import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import {
  createConversationKnowledgeCheckpoint,
  prepareConversationKnowledgeCheckpointCoverage,
} from "../../config/sessions/conversation-knowledge-checkpoint.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import {
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReference,
} from "../../config/sessions/conversation-knowledge.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  admitRecipientConversationCheckpoint,
  prepareRecipientConversationProjection,
  prepareRecipientConversationCheckpoint,
} from "./conversation-knowledge-checkpoint-recipient.js";
import {
  createConversationKnowledgeSourceCache,
  type PreparedConversationKnowledgePacket,
} from "./conversation-knowledge-source-cache.js";
import type { ReplyConversationKnowledgeParams } from "./conversation-knowledge.types.js";

const native = vi.hoisted(() => ({
  target: vi.fn(),
  rebind: vi.fn(),
  evidence: vi.fn(),
  seal: vi.fn(),
  validate: vi.fn(),
  select: vi.fn(),
  take: vi.fn(),
  retain: vi.fn(),
  releaseTarget: vi.fn(),
  releaseSource: vi.fn(),
  checkSource: vi.fn(),
  scan: vi.fn(),
  bootstrap: vi.fn(),
  creation: vi.fn(),
  advance: vi.fn(),
  issue: vi.fn(),
  group: vi.fn(),
  groupRead: vi.fn(),
  releaseGroup: vi.fn(),
  inputs: vi.fn(),
  publish: vi.fn(),
}));
// mock-isolation: Exact native grouped range/ACL validation is covered by personal-read integration tests.
vi.mock("../../gateway/session-transcript-personal-read.js", () => ({
  preparePersonalConversationContributionGroup: native.group,
}));
// mock-isolation: Supply revocable grouped grants for recipient cleanup races without acquiring native sharing/database custody.
vi.mock("../../gateway/session-transcript-read-authority.js", () => ({
  prepareTranscriptReadAuthority: native.groupRead,
}));
// mock-isolation: Native SQL transaction/version races are covered by checkpoint-admission.test.ts.
vi.mock("../../config/sessions/conversation-knowledge-checkpoint-admission.js", () => ({
  prepareConversationKnowledgeBootstrap: native.bootstrap,
  prepareNewConversationKnowledgeBootstrap: native.creation,
  prepareConversationKnowledgeCheckpointSelection: native.seal,
  advanceConversationKnowledgeBootstrapInput: native.advance,
  retainConversationKnowledgeCheckpoint: native.retain,
}));
// mock-isolation: Check that the live boundary uses only prepared root evidence, never source hydration.
vi.mock("../../config/sessions/conversation-knowledge-store.js", () => ({
  readPreparedConversationKnowledgeRoot: native.rebind,
  readPreparedConversationKnowledgeRootEvidence: native.evidence,
  readConversationKnowledgeRoot: native.scan,
  issuePreparedKnowledgeRootCandidates: native.issue,
}));
// mock-isolation: Revocable donor grants exercise orchestration; native authorization has integration tests.
vi.mock("./conversation-knowledge-source-reader.js", () => ({
  prepareConversationKnowledgeTarget: native.target,
  readConversationKnowledgeInputs: native.inputs,
  publishPreparedConversationKnowledgeRoot: native.publish,
  createConversationKnowledgeSourceReader: (params: { reads: unknown[] }) => ({
    take: async (reference: ConversationKnowledgeReference) => {
      const allowed = await native.take();
      if (!allowed) {
        return {};
      }
      const read = {
        grant: {
          assertCurrent: native.checkSource,
          release: native.releaseSource,
          prepareAdmission: () => ({ synthetic: true }),
        },
      };
      params.reads.push(read);
      return {
        source: {
          read,
          grant: read.grant,
          through: reference.through,
          from: reference.privateAudience?.admission,
        },
      };
    },
  }),
}));

const person = { type: "profile", id: "example-person" } as const;
const branch = {
  agentId: "example",
  storePath: "/synthetic/agent.sqlite",
  sessionKey: "agent:example:recipient",
  sessionId: "recipient",
  lifecycleRevision: "recipient-life",
  root: { sessionKey: "agent:example:root", sessionId: "root", lifecycleRevision: "root-life" },
};
const source = {
  agentId: "example",
  sessionKey: "agent:example:donor",
  sessionId: "donor",
  lifecycleRevision: "donor-life",
};
const anchor = {
  agentId: source.agentId,
  sessionKey: source.sessionKey,
  sessionId: source.sessionId,
  storePath: branch.storePath,
  generation: "generation",
  rawSeq: 1,
  entryId: "one",
  activeMessagePosition: 1,
  effectiveParentId: null,
};
const reference: ConversationKnowledgeReference = {
  version: 1,
  sourceMode: "branches",
  source,
  through: anchor,
  origin: conversationKnowledgeOrigin(source, "utterance-observation"),
  kind: "utterance-observation",
  role: "user",
  privateAudience: { participant: person, admission: anchor },
};
const preparedRootEvidence = Object.freeze({ syntheticSelectedEvidence: true });
function fixture(references = [reference]) {
  const checkpoint = createConversationKnowledgeCheckpoint({
    branch,
    audienceKey: conversationKnowledgeParticipantIdentity(person)!,
    covered: references,
    summary: "The synthetic color is blue.",
  });
  const coverage = prepareConversationKnowledgeCheckpointCoverage({
    checkpoint,
    records: [checkpoint],
    assertCurrent() {},
  });
  const candidate = {
    checkpoint,
    coverage,
    manifest: { synthetic: true, byteLength: 10, ownedByteLength: 10 },
    bootstrap: { synthetic: true },
    selection: { checkpoint, validate: native.validate },
    groups: [
      {
        source: { agentId: source.agentId, sessionKey: source.sessionKey },
        admission: { release: native.releaseGroup, byteLength: 100, ownedByteLength: 100 },
      },
    ],
  };
  const cache = {
    preparedCheckpoint: candidate,
    clearCheckpoint: vi.fn(),
    retainCleanup: vi.fn(),
    forgetCleanup: vi.fn(),
    consumeCheckpoint: vi.fn(),
  };
  const onPacket = vi.fn();
  const canAdmitPacket = vi.fn(() => true);
  const params = {
    reader: { database: { env: {} } },
    sessionId: branch.sessionId,
    assertCurrent() {},
    originalParticipant: person,
    getRuntimeConfig: () => ({}),
    sourceCache: cache,
    readyOnly: true,
    retainInHistory: { writeTarget: branch },
    canAdmitPacket,
    onPacket,
  } as unknown as ReplyConversationKnowledgeParams;
  return { candidate, cache, params, canAdmitPacket, onPacket };
}
beforeEach(() => {
  for (const mock of Object.values(native)) {
    mock.mockReset();
  }
  native.target.mockResolvedValue({
    kind: "ready",
    branch,
    targetFacts: { assertCurrent() {}, release: native.releaseTarget },
  });
  native.rebind.mockResolvedValue(
    Object.assign(
      [
        {
          type: "custom_message",
          customType: "openclaw.conversation-utterance.v1",
          details: reference,
        },
      ],
      { evidence: preparedRootEvidence },
    ),
  );
  native.take.mockResolvedValue(true);
  native.retain.mockImplementation(async ({ source: check }) => {
    check();
    return { accepted: true, appended: true };
  });
  native.scan.mockImplementation(() => native.rebind());
  native.inputs.mockImplementation(async () => ({
    events: await native.scan(),
    retained: new Map(),
  }));
  native.publish.mockImplementation(({ evidence, receipts, cache }) => {
    cache.setPreparedRoot(native.issue(evidence, receipts));
  });
  native.issue.mockReturnValue({ syntheticManifest: true });
  native.evidence.mockResolvedValue({ syntheticEvidence: true });
  native.seal.mockImplementation(({ checkpoint }) => ({ checkpoint, validate: native.validate }));
  native.select.mockImplementation((selected: ConversationKnowledgeReference) => ({
    through: selected.readRange?.through ?? selected.through,
    from: selected.readRange?.admission ?? selected.privateAudience?.admission,
  }));
  native.group.mockResolvedValue({
    release: native.releaseGroup,
    byteLength: 100,
    ownedByteLength: 100,
  });
  native.groupRead.mockResolvedValue({
    assertCurrent: native.checkSource,
    release: native.releaseSource,
    selectContribution: native.select,
  });
});

describe("ready checkpoint recipient", () => {
  it("preserves a ready checkpoint while an awaited replacement cannot prove bootstrap eligibility", async () => {
    const f = fixture();
    const cache = createConversationKnowledgeSourceCache();
    const candidate = f.candidate as unknown as Parameters<typeof cache.stageCheckpoint>[0];
    expect(cache.stageCheckpoint(candidate)).toBe(true);
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    native.bootstrap.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return undefined;
    });
    const pending = prepareRecipientConversationCheckpoint(
      {
        ...f.params,
        sourceCache: cache,
        expectedAudienceIdentity: conversationKnowledgeParticipantIdentity(person),
      },
      f.candidate,
    );
    try {
      await entered.promise;
      expect(cache.preparedCheckpoint).toBe(candidate);
      expect(native.releaseGroup).not.toHaveBeenCalled();
      resume.resolve();
      await pending;
      expect(cache.preparedCheckpoint).toBe(candidate);
      expect(native.releaseGroup).not.toHaveBeenCalled();
      expect(native.releaseTarget).toHaveBeenCalledOnce();
      expect(native.group).not.toHaveBeenCalled();
      expect(native.groupRead).not.toHaveBeenCalled();
      expect(native.releaseSource).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      try {
        await pending;
      } finally {
        cache.clear();
      }
    }
    expect(cache.preparedCheckpoint).toBeUndefined();
    expect(native.releaseGroup).toHaveBeenCalledOnce();
  });
  it("keeps a newer background candidate when an older awaited foreground rebind fails", async () => {
    const f = fixture();
    const cache = createConversationKnowledgeSourceCache();
    const old = f.candidate as unknown as Parameters<typeof cache.stageCheckpoint>[0];
    const releaseNew = vi.fn();
    const replacement = {
      ...old,
      groups: [
        {
          source: { agentId: source.agentId, sessionKey: source.sessionKey },
          admission: { ...f.candidate.groups[0]!.admission, release: releaseNew },
        },
      ],
    } as unknown as typeof old;
    expect(cache.stageCheckpoint(old)).toBe(true);
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    native.evidence.mockImplementation(async () => {
      entered.resolve();
      await resume.promise;
      throw new SessionTranscriptReadFenceError("Old source no longer current");
    });
    const pending = admitRecipientConversationCheckpoint({ ...f.params, sourceCache: cache });
    await entered.promise;
    expect(cache.stageCheckpoint(replacement)).toBe(true);
    resume.resolve();
    expect(await pending).toBeUndefined();
    expect(cache.preparedCheckpoint).toBe(replacement);
    expect(releaseNew).not.toHaveBeenCalled();
    cache.retryCleanup();
    expect(native.releaseGroup).toHaveBeenCalledOnce();
    expect(releaseNew).not.toHaveBeenCalled();
    cache.clearCheckpoint(replacement);
    expect(releaseNew).toHaveBeenCalledOnce();
  });
  it("rechecks only bounded cold initialization after native SDK metadata advanced the proof", async () => {
    const f = fixture();
    native.advance.mockResolvedValue(undefined);
    native.creation.mockResolvedValue(f.candidate.bootstrap);
    const initialization = {
      provider: "synthetic",
      modelId: "example-model",
      thinkingLevel: "off",
    };
    const result = await admitRecipientConversationCheckpoint({
      ...f.params,
      bootstrapInput: { ...anchor, logicalTurnId: "turn", role: "user" },
      bootstrapInitialization: initialization,
    });
    expect(result).toBeDefined();
    expect(native.creation).toHaveBeenCalledWith(expect.objectContaining({ initialization }));
    expect(native.bootstrap).not.toHaveBeenCalled();
    result!.release();
  });
  it("rebinds one source group for many exact summary contributions", async () => {
    const references = Array.from({ length: 40 }, (_, index) => {
      const through = {
        ...anchor,
        rawSeq: index + 1,
        entryId: index ? `entry-${index}` : anchor.entryId,
        activeMessagePosition: index + 1,
      };
      return {
        ...reference,
        through,
        privateAudience: { participant: person, admission: through },
      };
    });
    const f = fixture(references);
    native.rebind.mockResolvedValue(
      references.map((details) => ({
        type: "custom_message",
        customType: "openclaw.conversation-utterance.v1",
        details,
      })),
    );
    const result = await admitRecipientConversationCheckpoint(f.params);
    expect(result).toBeDefined();
    expect(native.groupRead).toHaveBeenCalledOnce();
    expect(native.take).not.toHaveBeenCalled();
    expect(native.select).not.toHaveBeenCalled();
    expect(native.rebind).not.toHaveBeenCalled();
    expect(native.validate).toHaveBeenCalledOnce();
    result!.release();
    expect(native.releaseSource).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    "transfers native group cleanup only when staging succeeds: %s",
    async (accepted) => {
      const f = fixture();
      const cleanups = new Set<() => void>();
      const cache = {
        ...f.cache,
        maxPreparedRootBytes: 4_000_000,
        retainCleanup: (release: () => void) => cleanups.add(release),
        forgetCleanup: (release: () => void) => cleanups.delete(release),
        retryCleanup: () => {
          for (const release of cleanups) {
            release();
            cleanups.delete(release);
          }
        },
        stageCheckpoint: vi.fn(() => accepted),
      };
      await prepareRecipientConversationCheckpoint(
        {
          ...f.params,
          expectedAudienceIdentity: conversationKnowledgeParticipantIdentity(person),
          sourceCache: cache as unknown as ReplyConversationKnowledgeParams["sourceCache"],
        },
        f.candidate,
        f.candidate.bootstrap as unknown as Parameters<
          typeof prepareRecipientConversationCheckpoint
        >[2],
      );
      expect(native.group).toHaveBeenCalledOnce();
      expect(native.group).toHaveBeenCalledWith(
        expect.objectContaining({
          personal: expect.objectContaining({ rootEvidence: preparedRootEvidence }),
        }),
      );
      expect(native.groupRead).toHaveBeenCalledOnce();
      expect(native.groupRead).toHaveBeenCalledWith(
        expect.objectContaining({
          personal: expect.objectContaining({ rootEvidence: preparedRootEvidence }),
        }),
      );
      expect(cache.stageCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          groups: [
            expect.objectContaining({
              source: { agentId: source.agentId, sessionKey: source.sessionKey },
            }),
          ],
        }),
      );
      expect(cleanups.size).toBe(0);
      expect(native.releaseGroup).toHaveBeenCalledTimes(accepted ? 0 : 1);
      expect(native.releaseSource).toHaveBeenCalledOnce();
    },
  );
  it("refuses a range removed or changed after summary preparation", async () => {
    const f = fixture();
    native.groupRead.mockRejectedValue(
      new SessionTranscriptReadFenceError("Native prepared prefix changed"),
    );
    expect(await admitRecipientConversationCheckpoint(f.params)).toBeUndefined();
    expect(native.retain).not.toHaveBeenCalled();
    expect(native.releaseTarget).toHaveBeenCalledOnce();
  });
  it.each([undefined, { existingPartialManifest: true }])(
    "fills shared originals even when a partial recipient manifest already exists (%j)",
    async (manifest) => {
      const f = fixture();
      const cache = {
        preparedRoot: manifest,
        consumptionRevision: 0,
        retainContributions: vi.fn(),
        retainCleanup: vi.fn(),
        forgetCleanup: vi.fn(),
        maxPreparedRootBytes: 4_000_000,
        preparedAdmission: vi.fn(),
        retainAdmission: vi.fn(() => true),
        stage: vi.fn(() => true),
        setPreparedRoot: vi.fn(),
        peek: vi.fn(),
      };
      const packet = {
        through: anchor,
        from: anchor,
        version: { generation: "generation", rawSeq: 1, updatedAt: 1 },
        part: { complete: true },
      } as PreparedConversationKnowledgePacket;
      const complete = await prepareRecipientConversationProjection(
        {
          ...f.params,
          sourceCache: cache as unknown as ReplyConversationKnowledgeParams["sourceCache"],
          expectedAudienceIdentity: conversationKnowledgeParticipantIdentity(person),
        },
        [{ reference, packet }],
      );
      expect(complete).toBe(true);
      expect(native.scan).toHaveBeenCalledOnce();
      expect(cache.stage).toHaveBeenCalledWith(expect.any(String), 0, packet);
      expect(cache.setPreparedRoot).toHaveBeenCalledWith({ syntheticManifest: true });
      expect(native.releaseSource).toHaveBeenCalledOnce();
      expect(native.retain).not.toHaveBeenCalled();
      expect(native.bootstrap).not.toHaveBeenCalled();
    },
  );
  it("keeps staged siblings in canonical root order while extending a partial manifest", async () => {
    const f = fixture();
    const secondAnchor = { ...anchor, entryId: "two", rawSeq: 2 };
    const second = {
      ...reference,
      through: secondAnchor,
      privateAudience: { participant: person, admission: secondAnchor },
    };
    native.rebind.mockResolvedValue(
      Object.assign(
        [reference, second].map((value) => ({
          type: "custom_message",
          customType: "openclaw.conversation-utterance.v1",
          details: value,
        })),
        { evidence: preparedRootEvidence },
      ),
    );
    const packet = {
      through: anchor,
      from: anchor,
      version: { generation: "generation", rawSeq: 1, updatedAt: 1 },
      part: { complete: true },
    } as PreparedConversationKnowledgePacket;
    const laterId = conversationKnowledgeContributionId(second);
    const cache = {
      consumptionRevision: 0,
      retainContributions: vi.fn(),
      preparedRoot: { oldPartial: true },
      retainCleanup: vi.fn(),
      forgetCleanup: vi.fn(),
      preparedAdmission: vi.fn(() => ({ synthetic: true })),
      retainAdmission: vi.fn(() => true),
      stage: vi.fn(() => true),
      setPreparedRoot: vi.fn(),
      peek: vi.fn((id) => (id === laterId ? { part: { complete: true } } : undefined)),
    };
    expect(
      await prepareRecipientConversationProjection(
        {
          ...f.params,
          sourceCache: cache as unknown as ReplyConversationKnowledgeParams["sourceCache"],
          expectedAudienceIdentity: conversationKnowledgeParticipantIdentity(person),
        },
        [{ reference, packet }],
      ),
    ).toBe(true);
    expect(native.take).toHaveBeenCalledOnce();
    expect(cache.stage).toHaveBeenCalledWith(
      conversationKnowledgeContributionId(reference),
      0,
      packet,
    );
    expect(native.publish).toHaveBeenCalledWith(
      expect.objectContaining({ receipts: [reference, second] }),
    );
  });
  it("does not restage originals already represented in durable recipient history", async () => {
    const f = fixture();
    const id = conversationKnowledgeContributionId(reference);
    native.inputs.mockImplementation(async () => ({
      events: await native.scan(),
      retained: new Map([[id, { complete: true }]]),
    }));
    const cache = {
      consumptionRevision: 0,
      retainContributions: vi.fn(),
      hasContribution: vi.fn(() => true),
      invalidateContribution: vi.fn(),
      retainCleanup: vi.fn(),
      forgetCleanup: vi.fn(),
      setPreparedRoot: vi.fn(),
    };
    expect(
      await prepareRecipientConversationProjection(
        {
          ...f.params,
          sourceCache: cache as unknown as ReplyConversationKnowledgeParams["sourceCache"],
          expectedAudienceIdentity: conversationKnowledgeParticipantIdentity(person),
        },
        [],
      ),
    ).toBe(true);
    expect(cache.invalidateContribution).toHaveBeenCalledWith(id);
    expect(native.take).not.toHaveBeenCalled();
  });
  it("does not restage an original when a foreground commit advances during preparation", async () => {
    const f = fixture();
    const entered = createDeferredCore();
    const taken = createDeferredCore<boolean>();
    native.take.mockImplementationOnce(() => {
      entered.resolve();
      return taken.promise;
    });
    const cache = {
      consumptionRevision: 0,
      retainContributions: vi.fn(),
      retainCleanup: vi.fn(),
      forgetCleanup: vi.fn(),
      peek: vi.fn(),
      stage: vi.fn(),
    };
    const packet = {
      through: anchor,
      from: anchor,
      part: {},
    } as PreparedConversationKnowledgePacket;
    const pending = prepareRecipientConversationProjection(
      {
        ...f.params,
        sourceCache: cache as unknown as ReplyConversationKnowledgeParams["sourceCache"],
        expectedAudienceIdentity: conversationKnowledgeParticipantIdentity(person),
      },
      [{ reference, packet }],
    );
    await entered.promise;
    cache.consumptionRevision++;
    taken.resolve(true);
    expect(await pending).toBe(false);
    expect(cache.stage).not.toHaveBeenCalled();
    expect(native.publish).not.toHaveBeenCalled();
    expect(native.releaseSource).toHaveBeenCalledOnce();
  });
  it("retains a summary only with fresh donor grants and native prospective capacity", async () => {
    const f = fixture();
    const result = await admitRecipientConversationCheckpoint(f.params);
    expect(result).toBeDefined();
    expect(native.groupRead).toHaveBeenCalledOnce();
    expect(native.take).not.toHaveBeenCalled();
    expect(f.canAdmitPacket).toHaveBeenCalledOnce();
    expect(native.retain).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrap: f.candidate.bootstrap }),
    );
    expect(f.cache.consumeCheckpoint).toHaveBeenCalledWith(f.candidate);
    expect(f.onPacket).toHaveBeenCalledOnce();
    expect(native.releaseSource).not.toHaveBeenCalled();
    result!.assertCurrent();
    result!.release();
    expect(native.releaseSource).toHaveBeenCalledOnce();
    expect(native.releaseTarget).toHaveBeenCalledOnce();
    expect(native.scan).not.toHaveBeenCalled();
    expect(native.bootstrap).not.toHaveBeenCalled();
  });
  it.each(["missing-grant", "capacity", "missing-reference"])(
    "does not acknowledge or publish %s",
    async (reason) => {
      const f = fixture();
      if (reason === "missing-grant") {
        native.groupRead.mockRejectedValue(new SessionTranscriptReadFenceError("changed source"));
      }
      if (reason === "capacity") {
        f.canAdmitPacket.mockReturnValue(false);
      }
      if (reason === "missing-reference") {
        native.validate.mockImplementation(() => {
          throw new SessionTranscriptReadFenceError("Native selection changed");
        });
      }
      expect(await admitRecipientConversationCheckpoint(f.params)).toBeUndefined();
      expect(native.retain).not.toHaveBeenCalled();
      expect(f.cache.consumeCheckpoint).not.toHaveBeenCalled();
      expect(f.onPacket).not.toHaveBeenCalled();
      expect(native.releaseTarget).toHaveBeenCalledOnce();
    },
  );
  it("defers a changed recipient version without blocking ordinary ready packets", async () => {
    const f = fixture();
    native.retain.mockRejectedValue(new SessionTranscriptReadFenceError("changed"));
    expect(await admitRecipientConversationCheckpoint(f.params)).toBeUndefined();
    expect(f.cache.clearCheckpoint).toHaveBeenCalledOnce();
    expect(f.cache.consumeCheckpoint).not.toHaveBeenCalled();
    expect(native.releaseSource).toHaveBeenCalledOnce();
  });
  it("retains failed cleanup handles, still releases the target, and retries only unfinished cleanup", async () => {
    const f = fixture();
    const result = await admitRecipientConversationCheckpoint(f.params);
    native.releaseSource.mockImplementationOnce(() => {
      throw new Error("temporary cleanup failure");
    });
    expect(() => result!.release()).toThrow("cleanup remains pending");
    expect(native.releaseTarget).toHaveBeenCalledOnce();
    expect(f.cache.retainCleanup).toHaveBeenCalledWith(result!.release);
    result!.release();
    expect(native.releaseSource).toHaveBeenCalledTimes(2);
    expect(native.releaseTarget).toHaveBeenCalledOnce();
    expect(f.cache.forgetCleanup).toHaveBeenCalledWith(result!.release);
  });
});
