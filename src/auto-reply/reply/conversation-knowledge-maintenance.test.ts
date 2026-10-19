import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentCompactResult } from "../../agents/embedded-agent-runner/types.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptWriterFence,
  withSessionTranscriptWriteAssertion,
} from "../../config/sessions/transcript-write-context.js";
import {
  createConversationKnowledgeMaintenance,
  withConversationKnowledgeWriter,
} from "./conversation-knowledge-maintenance.js";
import type { FollowupRun } from "./queue/types.js";

const mocks = vi.hoisted(() => ({
  compact: vi.fn<() => Promise<EmbeddedAgentCompactResult>>(),
  resolve: vi.fn(),
  read: vi.fn<() => Promise<boolean>>(),
}));
// mock-isolation: Keep provider execution, plugins, and compaction workers outside this adapter test.
vi.mock("../../agents/embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: mocks.compact,
}));
// mock-isolation: Supply an exact native target without opening an agent database.
vi.mock("../../agents/run-session-target.js", () => ({
  resolveAgentRunSessionTarget: mocks.resolve,
}));
// mock-isolation: Exercise capacity decisions without starting transcript reader workers.
vi.mock("../../config/sessions/session-transcript-context-read.js", () => ({
  readSessionTranscriptModelContextAsync: mocks.read,
}));

const target = {
  agentId: "example",
  sessionKey: "agent:example:branch:chat",
  sessionId: "session-example",
  storePath: "/virtual/example/sessions.sqlite",
};
const run = {
  ...target,
  sessionFile: target.sessionKey,
  agentDir: "/virtual/example",
  workspaceDir: "/virtual/workspace",
  config: {},
  provider: "example-provider",
  model: "example-model",
  authProfileId: "example-profile",
  authProfileIdSource: "user",
  timeoutMs: 1_000,
  blockReplyBreak: "text_end",
  runId: "synthetic-maintenance-run",
  prompt: "Synthetic current request.",
  sessionTarget: {
    ...target,
    expectedWriterRunId: "synthetic-maintenance-run",
    expectedLifecycleRevision: "original",
  },
} satisfies FollowupRun["run"] &
  Parameters<typeof createConversationKnowledgeMaintenance>[0]["run"];

beforeEach(() => {
  mocks.compact.mockReset();
  mocks.resolve.mockReset().mockResolvedValue(target);
  mocks.read.mockReset().mockResolvedValueOnce(true).mockResolvedValue(false);
  mocks.compact.mockResolvedValue({
    ok: true,
    compacted: true,
    result: { summary: "Retained facts and decisions.", tokensBefore: 100, tokensAfter: 20 },
  });
});

describe("conversation knowledge native maintenance", () => {
  it("binds packet admission to the actual native claim without silently borrowing a weaker parent", async () => {
    await withConversationKnowledgeWriter({ run, assertCurrent: () => {} }, async () => {
      expect(getOwnedSessionTranscriptWriterFence({ sessionTarget: target })).toEqual({
        expectedWriterRunId: run.runId,
        expectedLifecycleRevision: "original",
      });
    });
    const copy = vi.fn(async () => {});
    await expect(
      withSessionTranscriptWriteAssertion(
        target,
        () => {},
        async () => withConversationKnowledgeWriter({ run, assertCurrent: () => {} }, copy),
      ),
    ).rejects.toThrow("writer custody changed");
    expect(copy).not.toHaveBeenCalled();
    expect(() =>
      withConversationKnowledgeWriter(
        { run: { ...run, sessionTarget: target }, assertCurrent: () => {} },
        copy,
      ),
    ).toThrow("no admitted native writer");
  });
  it("keeps complete packets that already fit without starting compaction", async () => {
    mocks.read.mockReset().mockResolvedValue(false);
    await createConversationKnowledgeMaintenance({
      run,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    })();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("compacts once when a required entry alone exceeds the conservative probe budget", async () => {
    mocks.read
      .mockReset()
      .mockRejectedValueOnce(new RangeError("oversized entry"))
      .mockResolvedValue(false);
    await createConversationKnowledgeMaintenance({
      run,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    })();
    expect(mocks.compact).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("leaves a still-oversized required entry pending after one compaction", async () => {
    mocks.read.mockReset().mockRejectedValue(new RangeError("oversized entry"));
    await expect(
      createConversationKnowledgeMaintenance({
        run,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      })(),
    ).rejects.toThrow("still exceeds safe capacity");
    expect(mocks.compact).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it.each(["source", "cancel"] as const)(
    "does not reinterpret %s revocation as budget pressure",
    async (mode) => {
      const controller = new AbortController();
      let current = true;
      mocks.read.mockReset().mockImplementationOnce(async () => {
        if (mode === "source") {
          current = false;
        } else {
          controller.abort(new Error("cancelled during read"));
        }
        throw new RangeError("oversized entry");
      });
      await expect(
        createConversationKnowledgeMaintenance({
          run,
          signal: controller.signal,
          assertCurrent: () => {
            if (!current) {
              throw new Error("source revoked during read");
            }
          },
        })(),
      ).rejects.toThrow(mode === "source" ? "source revoked" : "cancelled during read");
      expect(mocks.compact).not.toHaveBeenCalled();
    },
  );

  it("keeps the original recipient, model, auth and config while using direct budget compaction", async () => {
    const controller = new AbortController();
    await createConversationKnowledgeMaintenance({
      run,
      signal: controller.signal,
      assertCurrent: () => {},
    })();
    expect(mocks.compact).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionTarget: run.sessionTarget,
        sessionId: run.sessionId,
        provider: run.provider,
        model: run.model,
        authProfileId: run.authProfileId,
        authProfileIdSource: run.authProfileIdSource,
        config: run.config,
        abortSignal: controller.signal,
        disableTools: true,
        modelFallbacksOverride: [],
        trigger: "budget",
        forcePreflight: true,
        customInstructions: expect.stringContaining("not new requests"),
      }),
    );
  });

  it("retains both original writer authority and source revocation through native persistence", async () => {
    let sourceCurrent = true;
    let writerCurrent = true;
    mocks.compact.mockImplementationOnce(async () => {
      const assertCommit = captureOwnedTranscriptWriteAssertion(target);
      assertCommit();
      sourceCurrent = false;
      expect(assertCommit).toThrow("source revoked");
      sourceCurrent = true;
      writerCurrent = false;
      expect(assertCommit).toThrow("writer revoked");
      throw new Error("writer revoked");
    });
    await expect(
      withSessionTranscriptWriteAssertion(
        run.sessionTarget,
        () => {
          if (!writerCurrent) {
            throw new Error("writer revoked");
          }
        },
        createConversationKnowledgeMaintenance({
          run,
          signal: new AbortController().signal,
          assertCurrent: () => {
            if (!sourceCurrent) {
              throw new Error("source revoked");
            }
          },
        }),
      ),
    ).rejects.toThrow("writer revoked");
  });

  it("preserves the source's prepared storage predicates at the native commit boundary", async () => {
    const prepare = vi.fn(async () => ({ assertCurrent: () => {}, checks: [] }));
    mocks.compact.mockImplementationOnce(async () => {
      const assertCommit = captureOwnedTranscriptWriteAssertion(target);
      const prepared = await assertCommit.prepareSessionSource?.();
      expect(prepare).toHaveBeenCalledTimes(1);
      prepared?.assertCurrent();
      await prepared?.release?.();
      return {
        ok: true,
        compacted: true,
        result: { summary: "Retained facts.", tokensBefore: 100, tokensAfter: 20 },
      };
    });
    await createConversationKnowledgeMaintenance({
      run,
      signal: new AbortController().signal,
      assertCurrent: Object.assign(() => {}, { prepareSessionSource: prepare }),
    })();
  });

  it("refuses a changed recipient before compacting", async () => {
    mocks.resolve.mockResolvedValueOnce({ ...target, sessionId: "replacement" });
    await expect(
      createConversationKnowledgeMaintenance({
        run,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      })(),
    ).rejects.toThrow("recipient changed");
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("does not start maintenance after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      createConversationKnowledgeMaintenance({
        run,
        signal: controller.signal,
        assertCurrent: () => {},
      })(),
    ).rejects.toThrow("cancelled");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("does not loop when native compaction cannot restore complete bounded hydration", async () => {
    mocks.read.mockReset().mockResolvedValue(true);
    await expect(
      createConversationKnowledgeMaintenance({
        run,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      })(),
    ).rejects.toThrow("still exceeds safe capacity");
    expect(mocks.compact).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it.each<EmbeddedAgentCompactResult>([
    { ok: false, compacted: false },
    { ok: true, compacted: false, reason: "skipped" },
    { ok: true, compacted: true, result: { kind: "server-endpoint", tokensBefore: 100 } },
    { ok: true, compacted: true, result: { summary: "   ", tokensBefore: 100 } },
  ])("keeps catch-up pending without a successful native summary (%j)", async (result) => {
    mocks.compact.mockResolvedValueOnce(result);
    await expect(
      createConversationKnowledgeMaintenance({
        run,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      })(),
    ).rejects.toThrow("catch-up remains pending");
    expect(mocks.compact).toHaveBeenCalledTimes(1);
  });
});
