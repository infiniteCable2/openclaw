import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "../../agents/embedded-agent-runner/compact.types.js";
import type { EmbeddedAgentCompactResult } from "../../agents/embedded-agent-runner/types.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptWriterFence,
  withSessionTranscriptWriteAssertion,
} from "../../config/sessions/transcript-write-context.js";
import {
  createConversationKnowledgeMaintenance,
  resolveConversationKnowledgeContextLimits,
  withConversationKnowledgeWriter,
} from "./conversation-knowledge-maintenance.js";
import type { FollowupRun } from "./queue/types.js";

const mocks = vi.hoisted(() => ({
  compact:
    vi.fn<
      (params: CompactEmbeddedAgentSessionRuntimeParams) => Promise<EmbeddedAgentCompactResult>
    >(),
  resolve: vi.fn(),
  read: vi.fn(),
}));
// mock-isolation: Keep provider execution, plugins, and compaction workers outside this adapter test.
vi.mock("../../agents/embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: mocks.compact,
}));
// mock-isolation: Supply an exact native target without opening an agent database.
vi.mock("../../agents/run-session-target.js", () => ({
  resolveAgentRunSessionTarget: mocks.resolve,
}));
// mock-isolation: Packet visibility is supplied without opening transcript workers.
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
  mocks.read.mockReset().mockResolvedValue(new Set());
  mocks.compact.mockResolvedValue({
    ok: true,
    compacted: true,
    result: { summary: "Retained facts and decisions.", tokensBefore: 100, tokensAfter: 20 },
  });
});

describe("conversation knowledge native maintenance", () => {
  it("uses the foreground native hydration budget, not a custom catch-up cap", () => {
    expect(
      resolveConversationKnowledgeContextLimits({ ...run, contextTokenBudget: 1_000_000 }),
    ).toEqual({ maxBytes: 8_000_000, maxEvents: 10_000 });
  });

  it("counts a deferred prospective observation without adding it to the transcript", async () => {
    mocks.compact.mockResolvedValueOnce({ ok: true, compacted: false, reason: "within budget" });
    await createConversationKnowledgeMaintenance({
      run,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    })([], "Pending quoted observation.");
    expect(mocks.compact).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        budgetPreflight: { prompt: expect.stringContaining("Pending quoted observation.") },
      }),
    );
    expect(mocks.read).not.toHaveBeenCalled();
  });

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
  it("accepts the native budget owner's decision that compaction is unnecessary", async () => {
    mocks.compact.mockResolvedValueOnce({ ok: true, compacted: false, reason: "within budget" });
    await createConversationKnowledgeMaintenance({
      run,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    })();
    expect(mocks.compact).toHaveBeenCalledTimes(1);
  });

  it.each(["source", "cancel"] as const)(
    "does not reinterpret %s revocation as budget pressure",
    async (mode) => {
      const controller = new AbortController();
      let current = true;
      mocks.resolve.mockImplementationOnce(async () => {
        if (mode === "source") {
          current = false;
        } else {
          controller.abort(new Error("cancelled during read"));
        }
        return target;
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
        modelFallbacksOverride: [],
        trigger: "budget",
        budgetPreflight: { prompt: run.prompt },
        customInstructions: expect.stringContaining("not new requests"),
      }),
    );
    const request = mocks.compact.mock.calls[0]?.[0];
    expect(request).not.toHaveProperty("force");
    expect(request).not.toHaveProperty("forcePreflight");
    expect(request).not.toHaveProperty("preflightRequired");
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

  it("keeps failed native maintenance pending without retrying or inventing a byte threshold", async () => {
    mocks.compact.mockResolvedValueOnce({ ok: false, compacted: false });
    await expect(
      createConversationKnowledgeMaintenance({
        run,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      })(),
    ).resolves.toEqual({ compacted: false, complete: false, pending: "maintenance-deferred" });
    expect(mocks.compact).toHaveBeenCalledTimes(1);
  });

  it.each<EmbeddedAgentCompactResult>([
    { ok: true, compacted: false, reason: "skipped" },
    { ok: true, compacted: true, result: { kind: "server-endpoint", tokensBefore: 100 } },
  ])(
    "accepts successful native maintenance without demanding a textual summary (%j)",
    async (result) => {
      mocks.compact.mockResolvedValueOnce(result);
      await expect(
        createConversationKnowledgeMaintenance({
          run,
          signal: new AbortController().signal,
          assertCurrent: () => {},
        })(),
      ).resolves.toMatchObject({ complete: true });
      expect(mocks.compact).toHaveBeenCalledTimes(1);
    },
  );

  it.each([true, false])(
    "reports actual new-packet visibility after a native no-op (%s)",
    async (visible) => {
      mocks.compact.mockResolvedValueOnce({ ok: true, compacted: false, reason: "within budget" });
      mocks.read.mockResolvedValueOnce(new Set(visible ? ["synthetic-packet"] : []));
      const maintenance = createConversationKnowledgeMaintenance({
        run,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      await expect(maintenance(["synthetic-packet"])).resolves.toEqual({
        compacted: false,
        complete: visible,
      });
      expect(mocks.compact).toHaveBeenCalledOnce();
      expect(mocks.read).toHaveBeenCalledOnce();
    },
  );
});
