import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntryCohortResult } from "../../config/sessions/session-entry-read.types.js";
import { prepareTranscriptReadAuthority } from "../../gateway/session-transcript-read-authority.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { loadAgentEntryReadOperations } from "../../state/openclaw-agent-execution-operations.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState, resolveReplySessionPreprocessingState } from "./session.js";

let state: OpenClawTestState;
let nextId = 0;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "reply-initial-context" });
});
afterAll(async () => {
  await state.cleanup();
});

async function fixture() {
  const id = ++nextId;
  const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
  const source = {
    agentId: "main",
    storePath,
    sessionKey: `agent:main:source-${id}`,
    sessionId: `source-${id}`,
  };
  const target = {
    ...source,
    sessionKey: `agent:main:matrix:direct:peer-${id}`,
    sessionId: `target-${id}`,
  };
  await upsertSessionEntryCore(source, {
    sessionId: source.sessionId,
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: "source-owner" },
    permissionMode: "full",
  });
  await appendTranscriptMessage(source, {
    message: { role: "assistant", stopReason: "stop", content: "A completed source answer." },
  });
  const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  const operations = await loadAgentEntryReadOperations();
  const cohort: SessionEntryCohortResult = operations["session.entry.read"](
    {
      sessionKeys: [source.sessionKey],
      initialContext: { sessionKey: source.sessionKey, targetSessionId: target.sessionId },
    },
    {
      open: () => database,
      options: { agentId: "main", path: database.path, env: state.env },
      admit: () => {},
      writeTransaction: () => {
        throw new Error("Synthetic context preparation cannot write");
      },
    },
  );
  if (cohort.initialContext?.status !== "prepared") {
    throw new Error("Synthetic source context was not prepared");
  }
  const context = cohort.initialContext.context;
  const cfg = {
    agents: { defaults: { workspace: state.workspaceDir } },
    session: { store: storePath, dmScope: "per-channel-peer" as const },
  };
  const ctx = finalizeInboundContext({
    Body: "A new request",
    RawBody: "A new request",
    ChatType: "direct",
    SessionKey: target.sessionKey,
    Provider: "matrix",
    Surface: "matrix",
    From: `matrix:peer-${id}`,
    To: `room:example-${id}`,
    SessionCreation: {
      via: "operator",
      actor: { type: "human", source: "profile", id: "target-owner" },
      sandbox: "required",
    },
  });
  return { source, target, cfg, ctx, context };
}

describe("reply initialization with native copied context", () => {
  it("protects a retained headless root from external input after opting out of branches", async () => {
    const f = await fixture();
    const root = { ...f.target, sessionKey: "agent:main:main" };
    await upsertSessionEntryCore(root, {
      sessionId: root.sessionId,
      updatedAt: 1,
      conversationTopology: { version: 1, role: "root" },
      delivery: { kind: "none" },
    });
    await appendTranscriptMessage(root, {
      message: { role: "assistant", content: "Retained consolidation context." },
    });
    const ctx = finalizeInboundContext({ ...f.ctx, SessionKey: root.sessionKey });
    const before = loadSessionEntry(root);
    const events = await loadTranscriptEvents(root);
    await expect(resolveReplySessionPreprocessingState({ cfg: f.cfg, ctx })).rejects.toThrow(
      "Explicitly migrate",
    );
    await expect(initSessionState({ cfg: f.cfg, ctx, commandAuthorized: true })).rejects.toThrow(
      "Explicitly migrate",
    );
    expect(loadSessionEntry(root)).toEqual(before);
    expect(await loadTranscriptEvents(root)).toEqual(events);
  });
  it("rejects a direct external root before initialization effects in branch mode", async () => {
    const f = await fixture();
    const cfg = {
      ...f.cfg,
      agents: { ...f.cfg.agents, entries: { main: { conversationMode: "branches" as const } } },
    };
    const ctx = finalizeInboundContext({
      ...f.ctx,
      SessionKey: "agent:main:internal:conversation-root",
    });
    const root = { ...f.target, sessionKey: "agent:main:internal:conversation-root" };
    const before = loadSessionEntry(root);
    const events = await loadTranscriptEvents(root);
    await expect(initSessionState({ cfg, ctx, commandAuthorized: true })).rejects.toThrow(
      "reserves its internal root for consolidation",
    );
    expect(loadSessionEntry(root)).toEqual(before);
    expect(await loadTranscriptEvents(root)).toEqual(events);
  });
  it("uses the real ingress row and one prospective identity without a task-parent edge", async () => {
    const f = await fixture();
    const grant = await prepareTranscriptReadAuthority({
      authority: createAdmittedRunOperatorAuthority({
        profileId: GATEWAY_OWNER_PROFILE_ID,
        scopes: ["operator.admin"],
        assertCurrent: () => {},
        readCurrentRoleAssignment: () => null,
      }),
      getRuntimeConfig: () => f.cfg,
      sources: [f.source],
    });
    try {
      const result = await initSessionState({
        cfg: f.cfg,
        ctx: f.ctx,
        commandAuthorized: true,
        initialSessionContext: {
          agentId: "main",
          sessionKey: f.target.sessionKey,
          context: f.context,
          assertCurrent: grant.assertCurrent,
        },
      });
      expect(result.sessionId).toBe(f.target.sessionId);
      expect(result.sessionEntry).toMatchObject({
        sessionId: f.target.sessionId,
        createdActor: { type: "human", id: "target-owner" },
        sandbox: "required",
        forkSource: {
          sessionKey: f.source.sessionKey,
          sessionId: f.source.sessionId,
          entryId: f.context.sourceThrough?.entryId,
        },
        totalTokensFresh: false,
      });
      expect(result.sessionEntry.spawnedBy).toBeUndefined();
      expect(result.sessionEntry.parentSessionKey).toBeUndefined();
      expect(result.sessionEntry.permissionMode).not.toBe("full");
      expect(JSON.stringify(await loadTranscriptEvents(f.target))).toContain(
        "A completed source answer.",
      );
      const next = await initSessionState({ cfg: f.cfg, ctx: f.ctx, commandAuthorized: true });
      expect(next.sessionId).toBe(f.target.sessionId);
      expect(
        (await loadTranscriptEvents(f.target)).filter((event) =>
          JSON.stringify(event).includes("A completed source answer."),
        ),
      ).toHaveLength(1);
    } finally {
      grant.release();
    }
  });

  it("preserves an already-created destination instead of applying a stale host seed", async () => {
    const f = await fixture();
    await upsertSessionEntryCore(f.target, { sessionId: "competing", updatedAt: Date.now() });
    await expect(
      initSessionState({
        cfg: f.cfg,
        ctx: f.ctx,
        commandAuthorized: true,
        initialSessionContext: {
          agentId: "main",
          sessionKey: f.target.sessionKey,
          context: f.context,
          assertCurrent: () => {},
        },
      }),
    ).rejects.toThrow("admitted new conversation");
    expect(loadSessionEntry(f.target)?.sessionId).toBe("competing");
    expect(await loadTranscriptEvents(f.target)).toEqual([]);
  });
});
