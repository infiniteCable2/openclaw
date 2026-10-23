import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  conversationKnowledgeOrigin,
} from "../../config/sessions/conversation-knowledge.js";
import { captureConversationPublication } from "../../config/sessions/conversation-publication-context.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { SettledAgentTurn } from "./agent-runner-execution.types.js";
import { lifecycleAdmissionByOperation } from "./reply-run-registry.state.js";
import { createMockFollowupRun, createMockReplyOperation } from "./test-helpers.js";

const source = vi.hoisted(() => ({
  branch: vi.fn(),
  root: vi.fn(),
  facts: vi.fn(),
  history: vi.fn(),
  context: vi.fn(),
  record: vi.fn(),
  startPublication: vi.fn(),
  drain: vi.fn(),
  seed: vi.fn(),
}));
// mock-isolation: Seed persistence has real worker coverage; this fixture tests disclosure and turn custody.
vi.mock("../../config/sessions/conversation-knowledge-seed.js", () => ({
  ensureConversationKnowledgeSeed: source.seed,
}));
// mock-isolation: Capability absence must not open source history or transcript workers.
vi.mock("../../config/sessions/conversation-knowledge-store.js", () => ({
  readConversationKnowledgeBranch: source.branch,
  readConversationKnowledgeRoot: source.root,
  recordConversationKnowledgeTurn: source.record,
}));
// mock-isolation: Verify exact durable acceptance without opening journal workers or background jobs.
vi.mock("../../config/sessions/conversation-publication.js", () => ({
  openConversationPublicationStore: () => ({ accept: source.record }),
}));
// mock-isolation: A publication wakeup must not start database work in this custody fixture.
vi.mock("../../config/sessions/conversation-publication-reconcile.js", () => ({
  startConversationKnowledgePublication: source.startPublication,
}));
// mock-isolation: Select audience facts without opening the sharing/profile storage owner.
vi.mock("./conversation-knowledge-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./conversation-knowledge-authority.js")>()),
  prepareConversationKnowledgeBranchFacts: source.facts,
}));
// mock-isolation: A separately permitted read is deliberately insufficient to prove same-person disclosure.
vi.mock("../../gateway/session-transcript-read-authority.js", () => ({
  prepareTranscriptReadAuthority: source.history,
}));
// mock-isolation: The privacy boundary must refuse before any transcript worker is invoked.
vi.mock("../../config/sessions/session-transcript-context-read.js", () => ({
  readSessionTranscriptModelContextAsync: source.context,
}));
// mock-isolation: The actual native admission is retained, but terminal writer I/O is not started.
vi.mock("../../infra/agent-run-terminal-writes.js", () => ({
  drainAgentRunTerminalWrites: source.drain,
}));

import {
  createReplyConversationKnowledgeTurn,
  prepareReplyConversationKnowledge,
} from "./conversation-knowledge.js";

beforeEach(() => {
  for (const mock of Object.values(source)) {
    mock.mockReset();
  }
  source.seed.mockResolvedValue({ status: "seeded", recorded: 0, skipped: 0 });
  source.branch.mockResolvedValue({
    agentId: "example",
    sessionKey: "agent:example:branch",
    sessionId: "source-session",
    lifecycleRevision: "source-life",
    storePath: "/synthetic/agent.sqlite",
    root: { sessionKey: "agent:example:root", sessionId: "root", lifecycleRevision: "root-life" },
  });
});

async function nativeTurn(admin = false, conversationMode: "native" | "branches" = "branches") {
  const cfg = { agents: { entries: { example: { conversationMode } } } };
  const operatorAuthority = admin
    ? createAdmittedRunOperatorAuthority({
        profileId: "example-admin",
        scopes: ["operator.admin"],
        gatewayAccessGrant: null,
        assertCurrent() {},
      })
    : undefined;
  const followupRun = createMockFollowupRun({
    operatorAuthority,
    run: {
      agentId: "example",
      sessionKey: "agent:example:branch",
      sessionId: "source-session",
      config: cfg,
    },
  });
  const { replyOperation } = createMockReplyOperation({ sessionId: "source-session" });
  lifecycleAdmissionByOperation.set(replyOperation, { reader: unusedReader() });
  onTestFinished(() => {
    lifecycleAdmissionByOperation.delete(replyOperation);
  });
  const originalSource = vi.fn();
  const admission = prepareAgentRunAdmission({
    cfg,
    operatorAuthority,
    operationalRunInstance: createOperationalRunInstanceRef("source-run"),
    assertSourceCurrent: originalSource,
    facts: {
      runId: "source-run",
      agentId: "example",
      ingress: { kind: "channel", boundary: "knowledge-fixture", state: "present" },
    },
  });
  const owner = createReplyConversationKnowledgeTurn({
    turn: { isHeartbeat: false, followupRun, replyOperation },
    originalSource,
    getRuntimeConfig: () => cfg,
  });
  if (!owner) {
    throw new Error("Expected the actual native reader-bound knowledge owner");
  }
  onTestFinished(() => {
    owner.release();
    admission.close();
  });
  const abort = new AbortController();
  await owner.prepare(admission, abort.signal);
  const route = { provider: "example-provider", model: "example-model" };
  const result: SettledAgentTurn = {
    kind: "settled",
    status: "ok",
    resolved: route,
    fallback: { exhausted: false, attempts: [] },
    autoCompactionCount: 0,
    didLogHeartbeatStrip: false,
    result: {
      payloads: [{ text: "Completed answer." }],
      meta: {
        durationMs: 0,
        agentMeta: {
          sessionId: followupRun.run.sessionId,
          ...route,
          terminalReceipt: {
            runId: "source-run",
            sessionId: followupRun.run.sessionId,
            turnId: "native-turn",
            requested: route,
            effective: {
              ...route,
              responseModel: route.model,
            },
            successfulToolNames: [],
            rerouted: false,
            assistantTranscriptIdempotencyKey: "native-terminal-occurrence",
          },
        },
      },
    },
  };
  return { owner, result, abort, admission, originalSource, run: followupRun.run };
}

describe("actual native-turn knowledge ownership", () => {
  it("continues a pending turn without injecting status or changing existing context", async () => {
    source.seed.mockResolvedValue({
      status: "pending",
      reason: "source-capacity",
      recorded: 1,
      skipped: 0,
    });
    const f = await nativeTurn();
    expect(f.owner.fragments).toEqual([]);
    expect(await f.owner.prepareSnapshot()).toEqual(f.owner.fragments);
    const run = {
      ...f.run,
      runId: "source-run",
      prompt: "Continue this conversation.",
      runtimeContextFragments: [{ kind: "conversation-data" as const, text: "Existing context." }],
    };
    expect(await f.owner.prepareHistory(run)).toEqual(run.runtimeContextFragments);
    expect(await f.owner.prepareHistory(run)).toEqual(run.runtimeContextFragments);
    await f.owner.record(f.result);
    expect(f.result.status).toBe("ok");
    expect(source.root).not.toHaveBeenCalled();
    expect(source.context).not.toHaveBeenCalled();
    expect(source.history).not.toHaveBeenCalled();
    expect(source.record).not.toHaveBeenCalled();
    f.abort.abort(new Error("Pending turn retired"));
    await expect(f.owner.prepareSnapshot()).rejects.toThrow("Pending turn retired");
  });

  it("does not convert seed authority failure into a capacity notice", async () => {
    source.seed.mockRejectedValue(new Error("Seed source revoked"));
    await expect(nativeTurn()).rejects.toThrow("Seed source revoked");
    expect(source.record).not.toHaveBeenCalled();
  });

  it("drains terminal writes before durable acceptance, then wakes independent publication", async () => {
    const f = await nativeTurn();
    source.record.mockResolvedValue(true);
    await f.owner.record(f.result);
    expect(source.drain).toHaveBeenCalledWith(f.admission.operationalRunInstance);
    expect(source.record).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "source-run",
        sessionId: "source-session",
        idempotencyKey: "native-terminal-occurrence",
      }),
    );
    expect(source.drain.mock.invocationCallOrder[0]).toBeLessThan(
      source.record.mock.invocationCallOrder[0]!,
    );
    expect(source.startPublication).toHaveBeenCalledWith({
      agentId: "example",
      path: "/synthetic/agent.sqlite",
      env: {},
    });
    expect(source.record.mock.invocationCallOrder[0]).toBeLessThan(
      source.startPublication.mock.invocationCallOrder[0]!,
    );
    f.owner.release();
    expect(() => f.owner.assertCurrent()).toThrow("released");
  });

  it("rejects unrelated terminal metadata and aborted work before any report", async () => {
    const f = await nativeTurn();
    const terminal = f.result.result.meta.agentMeta?.terminalReceipt;
    if (!terminal) {
      throw new Error("Fixture terminal was not prepared");
    }
    terminal.runId = "other-run";
    await f.owner.record(f.result);
    terminal.runId = "source-run";
    terminal.sessionId = "other-session";
    await f.owner.record(f.result);
    await f.owner.record({ kind: "aborted", reason: "user" });
    expect(source.drain).not.toHaveBeenCalled();
    expect(source.record).not.toHaveBeenCalled();
  });

  it("reports the native committed entry without requiring a keyed assistant append", async () => {
    const f = await nativeTurn();
    const terminal = f.result.result.meta.agentMeta?.terminalReceipt;
    if (!terminal) {
      throw new Error("Fixture terminal was not prepared");
    }
    delete terminal.assistantTranscriptIdempotencyKey;
    terminal.assistantTranscriptEntryId = "native-saved-entry";
    await f.owner.record(f.result);
    expect(source.drain).toHaveBeenCalledWith(f.admission.operationalRunInstance);
    expect(source.record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: terminal.runId,
        entryId: "native-saved-entry",
        idempotencyKey: undefined,
      }),
    );
  });

  it("passively reports completed native work only for a previously enrolled conversation", async () => {
    const f = await nativeTurn(false, "native");
    const original = f.owner.withPublication(() =>
      captureConversationPublication(
        { agentId: "example", sessionKey: "agent:example:branch", sessionId: "source-session" },
        { role: "assistant", stopReason: "stop", __openclaw: { runId: "source-run" } },
      ),
    );
    expect(original?.intent).toMatchObject({
      kind: "completed-turn",
      sourceMode: "native",
      runId: "source-run",
      source: { lifecycleRevision: "source-life" },
    });
    await f.owner.record(f.result);
    expect(source.record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: "source-run" }),
    );
    expect(source.history).not.toHaveBeenCalled();
  });

  it("does not start reporting or add context for an ordinary unenrolled native conversation", async () => {
    source.branch.mockResolvedValue(undefined);
    const f = await nativeTurn(false, "native");
    expect(f.owner.fragments).toEqual([]);
    await f.owner.record(f.result);
    expect(source.branch).toHaveBeenCalledOnce();
    expect(source.root).not.toHaveBeenCalled();
    expect(source.history).not.toHaveBeenCalled();
    expect(source.record).not.toHaveBeenCalled();
    expect(source.drain).not.toHaveBeenCalled();
  });

  it("does not fail or retry completed work when durable acceptance is unconfirmed", async () => {
    const f = await nativeTurn();
    source.record.mockRejectedValue(new Error("Acceptance unavailable"));
    await expect(f.owner.record(f.result)).resolves.toBeUndefined();
    expect(source.record).toHaveBeenCalledOnce();
    expect(source.startPublication).not.toHaveBeenCalled();
    expect(f.result.status).toBe("ok");
  });
});

function unusedReader(): SessionEntryCohortReader {
  return {
    database: { agentId: "example", path: "/synthetic/agent.sqlite", env: {} },
    sessionKey: "agent:example:branch",
    logicalAgentId: "example",
    storePaths: ["/synthetic/agent.sqlite"],
    assertCurrent() {},
    async withRead() {
      throw new Error("Missing authority cannot request a source read");
    },
  };
}

describe("conversation knowledge capability absence", () => {
  it("keeps missing original participant evidence out of model input without reading metadata", async () => {
    const assertCurrent = vi.fn();
    const prepared = await prepareReplyConversationKnowledge({
      reader: unusedReader(),
      sessionId: "synthetic-current-session",
      assertCurrent,
      getRuntimeConfig: () => ({}),
    });
    expect(prepared?.fragments).toEqual([]);
    expect(source.branch).not.toHaveBeenCalled();
    expect(source.facts).not.toHaveBeenCalled();
    expect(source.history).not.toHaveBeenCalled();
    prepared?.assertCurrent();
    expect(assertCurrent).toHaveBeenCalled();
    prepared?.release();
    expect(() => prepared?.assertCurrent()).toThrow("released");
  });

  it("keeps capability custody bound to the original input abort", async () => {
    const abort = new AbortController();
    const prepared = await prepareReplyConversationKnowledge({
      reader: unusedReader(),
      sessionId: "synthetic-current-session",
      assertCurrent() {},
      getRuntimeConfig: () => ({}),
      signal: abort.signal,
    });
    abort.abort(new Error("Original input retired"));
    expect(() => prepared?.assertCurrent()).toThrow("Original input retired");
    prepared?.release();
  });

  it("refuses startup disclosure when the actual recipient differs from the stored target person", async () => {
    source.branch.mockResolvedValue({
      agentId: "example",
      sessionKey: "agent:example:target",
      sessionId: "target-session",
      lifecycleRevision: "original",
      storePath: "/synthetic/agent.sqlite",
      root: { sessionKey: "agent:example:main", sessionId: "root", lifecycleRevision: "original" },
    });
    const release = vi.fn();
    source.facts.mockResolvedValue({
      audience: "private-direct",
      audienceIdentity: "stored-person",
      assertCurrent() {},
      release,
    });
    const prepared = await prepareReplyConversationKnowledge({
      reader: unusedReader(),
      sessionId: "target-session",
      assertCurrent() {},
      originalParticipant: { type: "profile", id: "actual-person" },
      expectedAudienceIdentity: "actual-person",
      getRuntimeConfig: () => ({}),
    });
    expect(prepared?.fragments).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
    expect(source.root).not.toHaveBeenCalled();
    expect(source.history).not.toHaveBeenCalled();
    expect(source.context).not.toHaveBeenCalled();
    prepared?.release();
  });

  it("does not copy another person's data even after a separate native read was permitted", async () => {
    const originalParticipant = { type: "profile" as const, id: "native-person-a" };
    const branch = {
      agentId: "example",
      sessionKey: "agent:example:current",
      sessionId: "current-session",
      lifecycleRevision: "original",
      storePath: "/synthetic/agent.sqlite",
      root: { sessionKey: "agent:example:main", sessionId: "root", lifecycleRevision: "original" },
    };
    const sibling = {
      agentId: branch.agentId,
      sessionKey: "agent:example:sibling",
      sessionId: "sibling-session",
      lifecycleRevision: "original",
    };
    source.branch.mockResolvedValue(branch);
    source.root.mockResolvedValue([
      {
        type: "custom_message",
        customType: CONVERSATION_KNOWLEDGE_REPORT,
        details: {
          version: 1,
          sourceMode: "branches",
          origin: conversationKnowledgeOrigin(sibling),
          source: sibling,
          runId: "completed-sibling-run",
          through: {
            ...sibling,
            storePath: branch.storePath,
            generation: "generation-original",
            entryId: "completed-assistant-entry",
            rawSeq: 2,
            activeMessagePosition: 1,
            effectiveParentId: "original-user-entry",
          },
        },
      },
    ]);
    const targetRelease = vi.fn();
    const sourceRelease = vi.fn();
    source.facts.mockResolvedValueOnce({
      audience: "private-direct",
      audienceIdentity: conversationKnowledgeParticipantIdentity(originalParticipant),
      assertCurrent() {},
      release: targetRelease,
    });
    source.facts.mockResolvedValueOnce({
      audience: "private-direct",
      audienceIdentity: "native-person-b",
      assertCurrent() {},
      release: sourceRelease,
    });
    const grantRelease = vi.fn();
    source.history.mockResolvedValue({
      sources: [{ ...sibling, canonicalKey: sibling.sessionKey, storePath: branch.storePath }],
      assertCurrent() {},
      release: grantRelease,
    });
    const prepared = await prepareReplyConversationKnowledge({
      reader: unusedReader(),
      sessionId: branch.sessionId,
      assertCurrent() {},
      originalParticipant,
      getRuntimeConfig: () => ({}),
    });
    expect(source.history).toHaveBeenCalledOnce();
    expect(source.context).not.toHaveBeenCalled();
    expect(prepared?.fragments).toEqual([]);
    expect(sourceRelease).toHaveBeenCalledOnce();
    expect(grantRelease).toHaveBeenCalledOnce();
    prepared?.release();
    expect(targetRelease).toHaveBeenCalledOnce();
  });
});

function personalFixture(sourceMode: "native" | "branches" = "branches") {
  const participant = { type: "profile" as const, id: "example-person" };
  const branch = {
    agentId: "example",
    sessionKey: "agent:example:current",
    sessionId: "current-session",
    lifecycleRevision: "original",
    storePath: "/synthetic/agent.sqlite",
    root: { sessionKey: "agent:example:main", sessionId: "root", lifecycleRevision: "original" },
  };
  const sibling = {
    agentId: branch.agentId,
    sessionKey: "agent:example:sibling",
    sessionId: "sibling-session",
    lifecycleRevision: "original",
  };
  const factsRelease = vi.fn();
  const grantRelease = vi.fn();
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("Original participant source revoked");
    }
  };
  const facts = {
    audience: "private-direct",
    audienceIdentity: conversationKnowledgeParticipantIdentity(participant),
    assertCurrent,
    release: factsRelease,
  };
  source.branch.mockResolvedValue(branch);
  source.facts.mockResolvedValue(facts);
  const contribution = {
    version: 1,
    sourceMode,
    origin: conversationKnowledgeOrigin(sibling),
    source: sibling,
    runId: "sibling-run",
    through: {
      agentId: sibling.agentId,
      sessionKey: sibling.sessionKey,
      sessionId: sibling.sessionId,
      storePath: branch.storePath,
      generation: "original",
      entryId: "answer",
      rawSeq: 2,
      activeMessagePosition: 1,
      effectiveParentId: "question",
    },
  };
  source.root.mockResolvedValue([
    {
      type: "custom_message",
      customType: CONVERSATION_KNOWLEDGE_REPORT,
      details: contribution,
    },
  ]);
  source.history.mockResolvedValue({
    sources: [{ ...sibling, canonicalKey: sibling.sessionKey, storePath: branch.storePath }],
    assertCurrent,
    release: grantRelease,
  });
  const events = [
    { type: "message", id: "question", message: { role: "user", content: "The example is blue." } },
    {
      type: "message",
      id: "answer",
      message: {
        role: "assistant",
        content: "Agreed, blue.",
        stopReason: "stop",
        __openclaw: { runId: "sibling-run" },
      },
    },
  ];
  source.context.mockImplementation(
    async (_target: unknown, consume: (value: { events: typeof events }) => unknown) =>
      consume({ events }),
  );
  return {
    participant,
    contribution,
    branch,
    facts,
    factsRelease,
    grantRelease,
    assertCurrent,
    revoke: () => {
      current = false;
    },
    params: {
      reader: unusedReader(),
      sessionId: branch.sessionId,
      assertCurrent,
      originalParticipant: participant,
      getRuntimeConfig: () => ({
        agents: { entries: { example: { conversationMode: "branches" as const } } },
      }),
    },
  };
}

describe("native personal difference-context integration", () => {
  it.each(["native", "branches"] as const)(
    "native enrolled consumers accept only branch-origin context (source %s)",
    async (sourceMode) => {
      const f = personalFixture(sourceMode);
      const prepared = await prepareReplyConversationKnowledge({
        ...f.params,
        getRuntimeConfig: () => ({
          agents: { entries: { example: { conversationMode: "native" } } },
        }),
      });
      if (sourceMode === "branches") {
        expect(source.history).toHaveBeenCalledOnce();
        expect(prepared?.fragments[0]?.text).toContain("Agreed, blue.");
      } else {
        expect(source.history).not.toHaveBeenCalled();
        expect(source.context).not.toHaveBeenCalled();
        expect(prepared?.fragments).toEqual([]);
      }
      prepared?.release();
    },
  );

  it("uses the narrow native personal purpose without operator scope and retains its original custody", async () => {
    const f = personalFixture();
    source.branch.mockImplementationOnce(async () => {
      f.participant.id = "caller-mutated-after-submit";
      return f.branch;
    });
    const prepared = await prepareReplyConversationKnowledge(f.params);
    expect(source.history).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        purpose: "conversation-differences",
        personal: {
          originalParticipant: { type: "profile", id: "example-person" },
          assertCurrent: expect.any(Function),
          target: f.branch,
          contribution: f.contribution,
          rootEvidence: undefined,
          targetAudience: undefined,
        },
      }),
    );
    expect(source.history.mock.calls[0]?.[0]).not.toHaveProperty("authority");
    expect(prepared?.fragments[0]?.text).toContain("Agreed, blue.");
    expect(f.grantRelease).not.toHaveBeenCalled();
    f.revoke();
    expect(() => prepared?.assertCurrent()).toThrow("revoked");
    prepared?.release();
    expect(f.grantRelease).toHaveBeenCalledOnce();
    expect(f.factsRelease).toHaveBeenCalledTimes(2);
  });

  it("does not turn an observation or a stored row into personal authority", async () => {
    const f = personalFixture();
    const prepared = await prepareReplyConversationKnowledge({
      ...f.params,
      originalParticipant: {
        type: "observation",
        pluginId: "example",
        accountId: null,
        senderKind: "unknown",
        id: "example-person",
      },
    });
    expect(prepared?.fragments).toEqual([]);
    expect(source.branch).not.toHaveBeenCalled();
    expect(source.history).not.toHaveBeenCalled();
    prepared?.release();
  });

  it("checks the actual original person against the held target before reading root references", async () => {
    const f = personalFixture();
    source.facts.mockResolvedValue({ ...f.facts, audienceIdentity: "another-person" });
    const prepared = await prepareReplyConversationKnowledge(f.params);
    expect(prepared?.fragments).toEqual([]);
    expect(source.root).not.toHaveBeenCalled();
    expect(source.history).not.toHaveBeenCalled();
    expect(f.factsRelease).toHaveBeenCalledOnce();
    prepared?.release();
  });

  it("does not treat a real admitted administrator as the original conversation person", async () => {
    const f = await nativeTurn(true);
    // Preparing publication reads only this turn's own enrollment. Operator
    // authority must not grant a subsequent read of root or other-branch context.
    expect(source.branch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "source-session" }),
    );
    await f.owner.prepareSnapshot();
    expect(f.owner.fragments).toEqual([]);
    expect(source.branch).toHaveBeenCalledOnce();
    expect(source.root).not.toHaveBeenCalled();
    expect(source.history).not.toHaveBeenCalled();
    expect(source.context).not.toHaveBeenCalled();
  });

  it("never retries a refused personal source through a broader history path", async () => {
    const f = personalFixture();
    source.history.mockRejectedValue(new Error("Personal source is not private"));
    const prepared = await prepareReplyConversationKnowledge(f.params);
    expect(source.history).toHaveBeenCalledOnce();
    expect(source.history.mock.calls[0]?.[0]).toHaveProperty("purpose", "conversation-differences");
    expect(source.context).not.toHaveBeenCalled();
    expect(prepared?.fragments).toEqual([]);
    prepared?.release();
  });
});
