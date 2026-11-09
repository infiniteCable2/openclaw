import { expect, it, vi } from "vitest";
import { projectCompactionAccountingPatch } from "../../config/sessions/session-entry-projection.js";
import {
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry,
} from "../../config/sessions/types.js";
import { runMemoryFlushIfNeeded, runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";

const { compact, account, readSnapshot } = vi.hoisted(() => ({
  compact: vi.fn(),
  account: vi.fn(),
  readSnapshot: vi.fn(),
}));

// mock-isolation: Exercise preflight admission without starting a model runtime.
vi.mock("../../agents/embedded-agent.js", () => ({ compactEmbeddedAgentSession: compact }));
// mock-isolation: This preflight never dispatches a memory-flush model turn.
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({}));
// mock-isolation: Keep byte-pressure admission independent of token estimates and database workers.
vi.mock("./agent-runner-memory-transcript-context.js", () => ({
  estimateContextTokensFromSessionTranscript: async () => undefined,
  readSessionLogSnapshot: async () => ({}),
}));
// mock-isolation: Supply raw accounting at the transcript reader boundary.
vi.mock("../../gateway/session-transcript-readers.js", () => ({
  readSessionTranscriptAccountingAsync: readSnapshot,
}));
// mock-isolation: Observe admission accounting without starting database workers.
vi.mock("./session-updates.js", () => ({ incrementCompactionCount: account }));

it.each([
  { runtime: "openclaw", ok: false, compacted: false },
  { runtime: "openclaw", ok: true, compacted: true },
])(
  "continues built-in byte preflight with bounded context (ok=$ok, compacted=$compacted)",
  async ({ runtime, ok, compacted }) => {
    readSnapshot.mockReset().mockResolvedValue({ byteSize: 102_400 });
    compact.mockReset().mockResolvedValue({ ok, compacted, reason: "fixture declines compaction" });
    account
      .mockReset()
      .mockImplementation(
        async (
          params: Parameters<typeof import("./session-updates.js").incrementCompactionCount>[0],
        ) => {
          const entry = params.expectedSession;
          if (!entry || !params.sessionStore || !params.sessionKey) {
            throw new Error("Missing compaction accounting target");
          }
          const current: InternalSessionEntry = { ...entry, updatedAt: 1 };
          const updated: InternalSessionEntry = {
            ...current,
            ...projectCompactionAccountingPatch(current, params),
          };
          params.sessionStore[params.sessionKey] = updated;
          return params.amount ?? 1;
        },
      );
    const followupRun = createTestFollowupRun({ provider: "openai", model: "gpt-5.5" });
    const notice = vi.fn();
    const params: Parameters<typeof runSessionCompactionIfNeeded>[0] = {
      cfg: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: "32kb" } } } },
      followupRun,
      defaultModel: "gpt-5.5",
      sessionKey: "main",
      sessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        totalTokens: 100,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      },
      agentHarnessId: runtime,

      onCompactionNotice: notice,
    };
    const entry = await runSessionCompactionIfNeeded(params);

    expect(entry).toMatchObject({
      sessionId: "session",
      compactionCount: compacted ? 1 : 0,
      transcriptByteCompactionLatch: {
        activeBytes: 102_400,
        maxBytes: 32_768,
        sessionId: "session",
      },
    });
    expect(notice.mock.calls.map(([phase]) => phase)).toContain("context_bounded");
    notice.mockClear().mockRejectedValueOnce(new Error("fixture notice delivery failed"));
    await runSessionCompactionIfNeeded({
      ...params,
      sessionEntry: { ...params.sessionEntry!, ...entry },
    });
    expect(compact).toHaveBeenCalledOnce();
    expect(notice.mock.calls.map(([phase]) => phase)).toContain("context_bounded");
  },
);

it.each(["before-preflight", "during-transcript-read"] as const)(
  "refuses an unavailable guest source %s before compaction model or accounting",
  async (refusalPoint) => {
    compact.mockReset();
    account.mockReset();
    let available = refusalPoint !== "before-preflight";
    readSnapshot.mockReset().mockImplementation(async () => {
      available = false;
      return { byteSize: 102_400 };
    });
    const followupRun = createTestFollowupRun({ provider: "openai", model: "gpt-5.5" });
    followupRun.assertSourceCurrent = () => {
      if (!available) {
        throw new Error("guest source unavailable");
      }
    };
    const sessionEntry: InternalSessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      totalTokens: 100,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    };
    await expect(
      runSessionCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: "32kb" } } } },
        followupRun,
        defaultModel: "gpt-5.5",
        sessionKey: "main",
        sessionEntry,
        agentHarnessId: "openclaw",
        isHeartbeat: false,
      }),
    ).rejects.toThrow("guest source unavailable");
    expect(readSnapshot).toHaveBeenCalledTimes(refusalPoint === "before-preflight" ? 0 : 1);
    expect(compact).not.toHaveBeenCalled();
    expect(account).not.toHaveBeenCalled();
    expect(sessionEntry).toEqual({
      sessionId: "session",
      updatedAt: 1,
      totalTokens: 100,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    });
  },
);

it("refuses an unavailable guest before memory-flush preparation", async () => {
  readSnapshot.mockReset();
  const followupRun = createTestFollowupRun();
  followupRun.assertSourceCurrent = () => {
    throw new Error("guest source unavailable");
  };
  await expect(
    runMemoryFlushIfNeeded({
      cfg: {},
      followupRun,
      defaultModel: "gpt-test",
      resolvedVerboseLevel: "off",
      isHeartbeat: false,
    }),
  ).rejects.toThrow("guest source unavailable");
  expect(readSnapshot).not.toHaveBeenCalled();
});
