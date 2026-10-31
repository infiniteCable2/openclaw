import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  capturePreparedConversationContextBudget,
  createConversationContextCapacity,
} from "../../agents/embedded-agent-runner/run/prepared-conversation-context.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createReplyConversationKnowledgeTurn } from "./conversation-knowledge-turn.js";
import { lifecycleAdmissionByOperation } from "./reply-run-registry.state.js";
import { createMockFollowupRun, createMockReplyOperation } from "./test-helpers.js";

const preparation = vi.hoisted(() => ({ recipient: vi.fn(), seed: vi.fn(), branch: vi.fn() }));
// mock-isolation: Only turn-to-recipient handoff is under test; scheduling has native scenario coverage.
vi.mock("./conversation-knowledge-prefetch.js", () => ({
  prepareConversationKnowledgeRecipient: preparation.recipient,
}));
// mock-isolation: Existing enrollment is supplied without opening transcript workers.
vi.mock("../../config/sessions/conversation-knowledge-seed.js", () => ({
  ensureConversationKnowledgeSeed: preparation.seed,
}));
// mock-isolation: This fixture retains an already admitted branch, not source-storage authority.
vi.mock("../../config/sessions/conversation-knowledge-store.js", () => ({
  readConversationKnowledgeBranch: preparation.branch,
}));
// mock-isolation: Replacement returns before packet consumption; unexpected source reads must fail.
vi.mock("./conversation-knowledge.js", () => ({
  prepareReplyConversationKnowledge: () => {
    throw new Error("Replacement must not synchronously hydrate another conversation");
  },
}));
// mock-isolation: No terminal publication belongs to this request-budget handoff fixture.
vi.mock("./conversation-publication.js", () => ({
  captureReplyConversationPublication: () => undefined,
  recordReplyConversationPublication: () => {},
}));

beforeEach(() => {
  preparation.recipient.mockReset();
  preparation.seed.mockReset().mockResolvedValue({ status: "seeded" });
  preparation.branch.mockReset().mockResolvedValue({
    agentId: "example",
    sessionKey: "agent:example:branch",
    sessionId: "example-session",
    lifecycleRevision: "example-life",
    storePath: "/synthetic/agent.sqlite",
    root: { sessionKey: "agent:example:root", sessionId: "root", lifecycleRevision: "root-life" },
  });
});

async function fixture() {
  const cfg: OpenClawConfig = {
    agents: { entries: { example: { conversationMode: "branches" } } },
  };
  const participant = { type: "profile" as const, id: "example-person" };
  let hostCurrent = true;
  const audience = {
    agentId: "example",
    sessionKey: "agent:example:branch",
    channelId: "test",
    accountId: "default",
    nativeChannelId: "example-connection",
    participant,
    assertCurrent() {
      if (!hostCurrent) throw new Error("Original host audience revoked");
    },
  };
  const recipient = () => ({
    owner: { assertCurrent: vi.fn(), request: vi.fn() },
    checkpoint: { projection: () => undefined },
    retainContextBudget: vi.fn(),
  });
  const original = recipient();
  const replacement = recipient();
  preparation.recipient.mockImplementation((params) => {
    params.audience.assertCurrent();
    return preparation.recipient.mock.calls.length === 1 ? original : replacement;
  });
  const followupRun = createMockFollowupRun({
    conversationParticipant: participant,
    conversationAudience: audience,
    run: {
      agentId: "example",
      sessionKey: audience.sessionKey,
      sessionId: "example-session",
      provider: "synthetic",
      model: "example-model",
      config: cfg,
    },
  });
  const { replyOperation } = createMockReplyOperation({
    key: audience.sessionKey,
    sessionId: followupRun.run.sessionId,
  });
  const reader: SessionEntryCohortReader = {
    database: { agentId: "example", path: "/synthetic/agent.sqlite", env: {} },
    sessionKey: audience.sessionKey,
    logicalAgentId: "example",
    storePaths: ["/synthetic/agent.sqlite"],
    assertCurrent() {},
    async withRead() {
      throw new Error("Budget handoff must not read source history");
    },
  };
  lifecycleAdmissionByOperation.set(replyOperation, { reader });
  const source = vi.fn();
  const admission = prepareAgentRunAdmission({
    cfg,
    operationalRunInstance: createOperationalRunInstanceRef("example-run"),
    assertSourceCurrent: source,
    facts: {
      runId: "example-run",
      agentId: "example",
      ingress: { kind: "channel", boundary: "budget-handoff", state: "present" },
    },
  });
  const turn = createReplyConversationKnowledgeTurn({
    turn: { isHeartbeat: false, followupRun, replyOperation },
    originalSource: source,
    getRuntimeConfig: () => cfg,
  });
  if (!turn) throw new Error("Expected the original reader-bound knowledge turn");
  onTestFinished(() => {
    turn.release();
    admission.close();
    lifecycleAdmissionByOperation.delete(replyOperation);
  });
  await turn.prepare(admission, new AbortController().signal);
  await turn.prepareHistory({ ...followupRun.run, runId: "example-run", prompt: "Continue." });
  original.owner.assertCurrent.mockImplementation(() => {
    throw new Error("Original recipient retired");
  });
  return {
    cfg,
    turn,
    original,
    replacement,
    revokeHost() {
      hostCurrent = false;
    },
  };
}

it("hands the current native budget to a replacement before deferring foreground context", async () => {
  const f = await fixture();
  const canAdmit = createConversationContextCapacity({
    messages: [],
    systemPrompt: "Actual request prompt.",
    tools: [],
    contextWindow: 100_000,
    reserveTokens: 8192,
    modelIdentity: { provider: "synthetic", model: "actual-request-model" },
  });
  expect(capturePreparedConversationContextBudget(canAdmit)).toMatchObject({
    contextWindow: 100_000,
    reserveTokens: 8192,
    modelIdentity: { provider: "synthetic", model: "actual-request-model" },
  });
  expect(await f.turn.refreshPrepared({ canAdmit })).toEqual([]);
  expect(f.replacement.retainContextBudget).toHaveBeenCalledExactlyOnceWith(canAdmit, {
    provider: "synthetic",
    model: "example-model",
    config: f.cfg,
  });
  expect(f.replacement.owner.request).toHaveBeenCalledExactlyOnceWith("recipient");
  expect(f.replacement.retainContextBudget.mock.invocationCallOrder[0]).toBeLessThan(
    f.replacement.owner.request.mock.invocationCallOrder[0]!,
  );
  expect(f.original.retainContextBudget).not.toHaveBeenCalled();
});

it("does not manufacture an issued budget for an unsupported request capacity", async () => {
  const f = await fixture();
  const canAdmit = () => false;
  expect(await f.turn.refreshPrepared({ canAdmit })).toEqual([]);
  const forwarded = f.replacement.retainContextBudget.mock.calls[0]?.[0];
  expect(forwarded).toBe(canAdmit);
  expect(capturePreparedConversationContextBudget(forwarded)).toBeUndefined();
});

it("cannot revive a revoked host audience to retain a request budget", async () => {
  const f = await fixture();
  f.revokeHost();
  const canAdmit = createConversationContextCapacity({
    messages: [],
    contextWindow: 100_000,
    reserveTokens: 8192,
  });
  expect(await f.turn.refreshPrepared({ canAdmit })).toEqual([]);
  expect(preparation.recipient).toHaveBeenCalledTimes(2);
  expect(f.replacement.retainContextBudget).not.toHaveBeenCalled();
  expect(f.replacement.owner.request).not.toHaveBeenCalled();
  expect(f.original.retainContextBudget).not.toHaveBeenCalled();
});
