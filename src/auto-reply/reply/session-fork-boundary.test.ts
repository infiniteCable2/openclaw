import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import {
  buildForkedChildTranscriptEvents,
  resolveParentForkSourceTranscript,
} from "../../config/sessions/session-accessor.sqlite-parent-fork.js";
import type { TranscriptEvent } from "../../config/sessions/session-accessor.types.js";
import { readCodexSessionContext } from "../../plugin-sdk/codex-session-transcript-runtime.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { forkSessionEntryFromParent } from "./session-fork.js";

const dirs = useSessionStoreTempDirs(afterAll, "openclaw-fork-completed-boundary-");
afterEach(() => cliBackendsTesting.resetDepsForTest());

async function seedParent(options: { pending?: boolean; totalTokens?: number } = {}) {
  const storePath = path.join(dirs.make(), "shared.sqlite");
  const parentKey = "agent:research:main";
  const childKey = "agent:research:conversation:child";
  const parentScope = { agentId: "research", sessionKey: parentKey, storePath };
  const parent = {
    sessionId: "parent",
    updatedAt: 1,
    totalTokens: options.totalTokens ?? 10,
    totalTokensFresh: true,
    totalTokensVersion: 1,
    cliSessionBindings: {
      "claude-cli": { sessionId: "provider-parent", resumeCheckpointId: "pending-checkpoint" },
    },
  };
  await replaceSessionEntry(parentScope, parent);
  const events: TranscriptEvent[] = [
    { type: "session", id: parent.sessionId, version: 3, timestamp: "2026-10-01T00:00:00Z" },
    { type: "message", id: "user", parentId: null, message: { role: "user", content: "First" } },
    {
      type: "message",
      id: "completed",
      parentId: "user",
      message: { role: "assistant", stopReason: "stop", content: "First result" },
    },
  ];
  if (options.pending !== false) {
    events.push(
      {
        type: "message",
        id: "pending-user",
        parentId: "completed",
        message: { role: "user", content: "Work still in progress" },
      },
      {
        type: "message",
        id: "progress",
        parentId: "pending-user",
        message: {
          role: "assistant",
          phase: "commentary",
          stopReason: "stop",
          content: "Checking",
        },
      },
      {
        type: "message",
        id: "tool-use",
        parentId: "progress",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
        },
      },
      {
        type: "message",
        id: "tool-result",
        parentId: "tool-use",
        message: { role: "toolResult", toolCallId: "call", content: "Tool result" },
      },
      {
        type: "message",
        id: "interrupted",
        parentId: "tool-result",
        message: { role: "assistant", stopReason: "aborted", content: "Partial result" },
      },
    );
  }
  await replaceTranscriptEvents({ ...parentScope, sessionId: parent.sessionId }, events);
  return { parentScope, childKey, parent, events };
}

function forkParams(fixture: Awaited<ReturnType<typeof seedParent>>) {
  return {
    agentId: fixture.parentScope.agentId,
    storePath: fixture.parentScope.storePath,
    parentSessionKey: fixture.parentScope.sessionKey,
    sessionKey: fixture.childKey,
    fallbackEntry: { sessionId: "", updatedAt: 2 },
  };
}

it.each([undefined, "last-completed"] as const)(
  "honors the selected entry-fork boundary through the native worker (%s)",
  async (forkFrom) => {
    const fixture = await seedParent();
    const sql = observeHostDataSql();
    let result: Awaited<ReturnType<typeof forkSessionEntryFromParent>>;
    try {
      result = await forkSessionEntryFromParent({ ...forkParams(fixture), forkFrom });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(result.status).toBe("forked");
    if (result.status !== "forked") {
      throw new Error("Expected forked entry");
    }
    const childEvents = await loadTranscriptEvents({
      ...fixture.parentScope,
      sessionKey: fixture.childKey,
      sessionId: result.sessionEntry.sessionId,
    });
    const inherited = forkFrom ? fixture.events.slice(1, 3) : fixture.events.slice(1);
    expect(childEvents.slice(1)).toEqual(inherited);
    await expect(
      loadTranscriptEvents({ ...fixture.parentScope, sessionId: fixture.parent.sessionId }),
    ).resolves.toEqual(fixture.events);
  },
);

it.each([
  { stopReason: "toolUse", content: "Tool work" },
  { stopReason: "aborted", content: "Interrupted" },
  { stopReason: "error", content: "Failed" },
  { stopReason: "stop", phase: "commentary", content: "Progress" },
  {
    stopReason: "stop",
    content: [{ type: "text", text: "Progress", textSignature: '{"v":1,"phase":"commentary"}' }],
  },
  { content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
])("does not call an in-flight assistant row completed: %j", (message) => {
  const source = resolveParentForkSourceTranscript(
    [
      { type: "session", id: "parent", version: 3, timestamp: "2026-10-01T00:00:00Z" },
      { type: "message", id: "user", parentId: null, message: { role: "user", content: "First" } },
      {
        type: "message",
        id: "in-flight",
        parentId: "user",
        message: { role: "assistant", ...message },
      },
    ],
    "last-completed",
  );
  expect(source).toMatchObject({ branchEntries: [], leafId: null, appendParentId: null });
});

it.each([undefined, "stop", "length"])(
  "retains completed and legacy assistant boundaries (%s)",
  (stopReason) => {
    const event = {
      type: "message",
      id: "completed",
      parentId: null,
      message: { role: "assistant", content: "Result", stopReason },
    };
    expect(resolveParentForkSourceTranscript([event], "last-completed")).toMatchObject({
      branchEntries: [event],
      leafId: "completed",
      appendParentId: "completed",
    });
  },
);

it("budgets the selected completed snapshot rather than the growing parent total", async () => {
  const fixture = await seedParent({ totalTokens: 200_000 });
  const result = await forkSessionEntryFromParent({
    ...forkParams(fixture),
    forkFrom: "last-completed",
    maxTokens: 1_000,
  });
  expect(result).toMatchObject({ status: "forked", decision: { maxTokens: 1_000 } });
});

it("preserves the child capacity limit instead of silently using the default cap", async () => {
  const fixture = await seedParent();
  const result = await forkSessionEntryFromParent({
    ...forkParams(fixture),
    forkFrom: "last-completed",
    maxTokens: 1,
  });
  expect(result).toMatchObject({
    status: "skipped",
    reason: "decision-skip",
    decision: { reason: "parent-too-large", maxTokens: 1 },
  });
  expect(
    loadSessionEntry({ ...fixture.parentScope, sessionKey: fixture.childKey }),
  ).toBeUndefined();
});

it.each(
  (["reset", "compaction"] as const).flatMap((type) =>
    [false, true].flatMap((pendingBefore) =>
      [false, true].map((settledAfter) => ({ type, pendingBefore, settledAfter })),
    ),
  ),
)(
  "keeps $type privacy and completion boundaries (pendingBefore=$pendingBefore, settledAfter=$settledAfter)",
  async ({ type, pendingBefore, settledAfter }) => {
    const fixture = await seedParent({ pending: false, totalTokens: 200_000 });
    const events = [
      fixture.events[0],
      {
        type: "message",
        id: "old-user",
        parentId: null,
        message: { role: "user", content: "Retired private input" },
      },
      {
        type: "message",
        id: "old-answer",
        parentId: "old-user",
        message: { role: "assistant", content: "Retired private result", stopReason: "stop" },
      },
      {
        type: "message",
        id: "safe",
        parentId: "old-answer",
        message: { role: "assistant", content: "Retained result", stopReason: "stop" },
      },
      ...(pendingBefore
        ? [
            {
              type: "message",
              id: "split-user",
              parentId: "safe",
              message: { role: "user", content: "Split turn request" },
            },
            {
              type: "message",
              id: "split-tool",
              parentId: "split-user",
              message: {
                role: "assistant",
                stopReason: "toolUse",
                content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
              },
            },
          ]
        : []),
      {
        type,
        id: "boundary",
        parentId: pendingBefore ? "split-tool" : "safe",
        timestamp: "2026-10-01T00:01:00Z",
        firstKeptEntryId: "safe",
        ...(type === "compaction"
          ? { summary: "Safe summary", tokensBefore: 200_000 }
          : { reason: "reset" }),
      },
      ...(settledAfter
        ? [
            {
              type: "message",
              id: "new-final",
              parentId: "boundary",
              message: {
                role: "assistant",
                stopReason: "stop",
                content: "Completed after boundary",
              },
            },
          ]
        : []),
      {
        type: "message",
        id: "pending",
        parentId: settledAfter ? "new-final" : "boundary",
        message: { role: "user", content: "Unfinished task" },
      },
    ];
    await replaceTranscriptEvents(
      { ...fixture.parentScope, sessionId: fixture.parent.sessionId },
      events,
    );
    const result = await forkSessionEntryFromParent({
      ...forkParams(fixture),
      forkFrom: "last-completed",
      maxTokens: 5_000,
    });
    expect(result.status).toBe("forked");
    if (result.status !== "forked") {
      throw new Error("Expected forked entry");
    }
    const childScope = {
      ...fixture.parentScope,
      sessionKey: fixture.childKey,
      sessionId: result.sessionEntry.sessionId,
    };
    const inherited = await loadTranscriptEvents(childScope);
    expect(inherited).not.toContainEqual(expect.objectContaining({ id: "pending" }));
    const context = readCodexSessionContext(childScope, (messages) => Array.from(messages));
    expect(JSON.stringify(context)).not.toContain("Retired private");
    expect(JSON.stringify(context)).not.toContain("Unfinished task");
    if (settledAfter) {
      expect(result.fork.contextStatus).toBeUndefined();
      expect(inherited).toContainEqual(expect.objectContaining({ id: "boundary", type }));
      expect(context).toContainEqual(expect.objectContaining({ content: "Retained result" }));
      expect(context).toContainEqual(
        expect.objectContaining({ content: "Completed after boundary" }),
      );
      if (type === "compaction") {
        expect(JSON.stringify(context)).toContain("Safe summary");
      }
    } else {
      expect(result.fork.contextStatus).toBe("no-completed-turn");
      expect(inherited).toHaveLength(1);
      expect(context).toEqual([]);
    }
    await expect(
      loadTranscriptEvents({ ...fixture.parentScope, sessionId: fixture.parent.sessionId }),
    ).resolves.toEqual(events);
  },
);

it("does not assume a summary-only compaction settled an unfinished parent turn", () => {
  const boundary = {
    type: "compaction",
    id: "boundary",
    parentId: null,
    timestamp: "2026-10-01T00:01:00Z",
    summary: "Settled context summary",
    tokensBefore: 100,
  };
  const source = resolveParentForkSourceTranscript([boundary], "last-completed");
  expect(source).toMatchObject({
    branchEntries: [],
    leafId: null,
    contextStatus: "no-completed-turn",
  });
  if (!source) {
    throw new Error("Expected compacted source");
  }
  expect(
    buildForkedChildTranscriptEvents({
      source,
      targetSessionId: "child",
      parentSessionFile: "parent",
    }),
  ).toHaveLength(1);
});

it.each([undefined, "last-completed"] as const)(
  "never resumes an unbounded provider checkpoint for a bounded snapshot (%s)",
  async (forkFrom) => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          pluginId: "anthropic",
          modelProvider: "anthropic",
          config: {
            command: "claude",
            forkArg: "--fork-session",
            resumeAtArg: "--resume-session-at",
          },
          bundleMcp: false,
          ownsNativeCompaction: false,
        },
      ],
      resolvePluginSetupCliBackend: () => undefined,
    });
    const fixture = await seedParent();
    const result = await forkSessionEntryFromParent({ ...forkParams(fixture), forkFrom });
    expect(result.status).toBe("forked");
    if (result.status !== "forked") {
      throw new Error("Expected forked entry");
    }
    expect(result.sessionEntry.cliSessionBindings).toEqual(
      forkFrom
        ? undefined
        : {
            "claude-cli": {
              ...fixture.parent.cliSessionBindings["claude-cli"],
              forkNextResume: true,
            },
          },
    );
    expect(loadSessionEntry(fixture.parentScope)?.cliSessionBindings).toEqual(
      fixture.parent.cliSessionBindings,
    );
  },
);
