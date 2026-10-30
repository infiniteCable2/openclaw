import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  recordInboundSessionMeta,
  updateSessionLastRoute,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { ensureAgentConversationRoot } from "../../config/sessions/session-conversation-root.js";
import type { SessionEntryCohortResult } from "../../config/sessions/session-entry-read.types.js";
import { prepareTranscriptReadAuthority } from "../../gateway/session-transcript-read-authority.js";
import { bindConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
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

async function fixture(agentId = "main") {
  const id = ++nextId;
  const storePath = state.statePath("agents", agentId, "sessions", "sessions.json");
  const source = {
    agentId,
    storePath,
    sessionKey: `agent:${agentId}:source-${id}`,
    sessionId: `source-${id}`,
  };
  const target = {
    ...source,
    sessionKey: `agent:${agentId}:matrix:direct:peer-${id}`,
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
  const database = openOpenClawAgentDatabase({ agentId, env: state.env });
  const operations = await loadAgentEntryReadOperations();
  const cohort: SessionEntryCohortResult = operations["session.entry.read"](
    {
      sessionKeys: [source.sessionKey],
      initialContext: { sessionKey: source.sessionKey, targetSessionId: target.sessionId },
    },
    {
      open: () => database,
      options: { agentId, path: database.path, env: state.env },
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
    agents: { defaults: { workspace: state.workspaceDir }, entries: { [agentId]: {} } },
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
  it.each(["native", "branches"] as const)(
    "initializes first ingress generations and preserves them until reset in %s mode",
    async (conversationMode) => {
      for (const produce of [recordInboundSessionMeta, updateSessionLastRoute]) {
        const f = await fixture("ingress-init");
        const cfg = {
          ...f.cfg,
          agents: {
            ...f.cfg.agents,
            entries: { [f.target.agentId]: { conversationMode } },
          },
        };
        if (conversationMode === "branches") {
          await ensureAgentConversationRoot({
            cfg,
            agentId: f.target.agentId,
            env: state.env,
            getConfig: () => cfg,
          });
        }
        const created = await produce({
          storePath: f.target.storePath,
          sessionKey: f.target.sessionKey,
          ctx: f.ctx,
        });
        expect(created?.lifecycleRevision).toEqual(expect.any(String));
        const first = await initSessionState({ cfg, ctx: f.ctx, commandAuthorized: true });
        expect(first.sessionEntry).toMatchObject({
          sessionId: created?.sessionId,
          lifecycleRevision: created?.lifecycleRevision,
        });
        expect(first.sessionEntry.conversationTopology?.role).toBe(
          conversationMode === "branches" ? "branch" : undefined,
        );
        await appendTranscriptMessage(
          { ...f.target, sessionId: first.sessionId },
          {
            message: { role: "user", content: "Preserve the original ingress history." },
          },
        );
        const history = await loadTranscriptEvents({ ...f.target, sessionId: first.sessionId });
        const reused = await initSessionState({ cfg, ctx: f.ctx, commandAuthorized: true });
        expect(reused.sessionEntry.lifecycleRevision).toBe(first.sessionEntry.lifecycleRevision);
        expect(await loadTranscriptEvents({ ...f.target, sessionId: first.sessionId })).toEqual(
          history,
        );
        const reset = await initSessionState({
          cfg,
          ctx: finalizeInboundContext(
            { ...f.ctx, Body: "/new", RawBody: "/new" },
            { forceBodyForAgent: true, forceBodyForCommands: true },
          ),
          commandAuthorized: true,
        });
        expect(reset.sessionEntry.lifecycleRevision).not.toBe(first.sessionEntry.lifecycleRevision);
        expect(reset.sessionEntry.conversationTopology).toEqual(
          first.sessionEntry.conversationTopology,
        );
      }
    },
  );

  it.each(["native", "branches"] as const)(
    "keeps confirmed new private conversations private through /new and mode changes from %s",
    async (conversationMode) => {
      const f = await fixture("private-init");
      const cfg = {
        ...f.cfg,
        agents: {
          ...f.cfg.agents,
          entries: { [f.target.agentId]: { conversationMode } },
        },
      };
      if (conversationMode === "branches") {
        await ensureAgentConversationRoot({
          cfg,
          agentId: f.target.agentId,
          env: state.env,
          getConfig: () => cfg,
        });
      }
      const audience = {
        agentId: f.target.agentId,
        sessionKey: f.target.sessionKey,
        channelId: "matrix",
        accountId: "default",
        nativeChannelId: "!private:example.test",
        participant: {
          type: "remote" as const,
          pluginId: "matrix",
          domain: "example.test",
          idKind: "user-id" as const,
          id: "@person:example.test",
        },
        assertCurrent() {},
      };
      bindConversationPrivateAudience(f.ctx, audience);
      const first = await initSessionState({ cfg, ctx: f.ctx, commandAuthorized: true });
      expect(loadSessionEntry(f.target)?.visibility).toBe("draft");
      const reset = await initSessionState({
        cfg,
        ctx: finalizeInboundContext(
          { ...f.ctx, Body: "/new", RawBody: "/new" },
          { forceBodyForAgent: true, forceBodyForCommands: true },
        ),
        commandAuthorized: true,
      });
      expect(reset).toMatchObject({ resetTriggered: true, isNewSession: true });
      expect(reset.sessionId).toBe(first.sessionId);
      expect(reset.sessionEntry.lifecycleRevision).not.toBe(first.sessionEntry.lifecycleRevision);
      expect(loadSessionEntry(f.target)?.visibility).toBe("draft");

      await appendTranscriptMessage(f.target, {
        message: { role: "user", content: "Keep this conversation through mode changes." },
      });
      const beforeModes = loadSessionEntry(f.target)!;
      const history = await loadTranscriptEvents(f.target);
      for (const mode of ["native", "branches", "native", "branches"] as const) {
        cfg.agents.entries[f.target.agentId]!.conversationMode = mode;
        if (mode === "branches") {
          await ensureAgentConversationRoot({
            cfg,
            agentId: f.target.agentId,
            env: state.env,
            getConfig: () => cfg,
          });
        }
        await initSessionState({ cfg, ctx: f.ctx, commandAuthorized: true });
        expect(loadSessionEntry(f.target)).toMatchObject({
          sessionId: beforeModes.sessionId,
          lifecycleRevision: beforeModes.lifecycleRevision,
          visibility: "draft",
        });
        expect(await loadTranscriptEvents(f.target)).toEqual(history);
      }

      // Current transport evidence cannot relabel an already shared history.
      for (const visibility of ["shared", undefined] as const) {
        await upsertSessionEntryCore(f.target, {
          ...loadSessionEntry(f.target)!,
          visibility,
        });
        await initSessionState({ cfg, ctx: f.ctx, commandAuthorized: true });
        expect(loadSessionEntry(f.target)?.visibility).toBe(visibility);
      }
    },
  );

  it.each(["native", "branches"] as const)(
    "rechecks private creation evidence at the native commit boundary in %s mode",
    async (conversationMode) => {
      const f = await fixture("private-init");
      const cfg = {
        ...f.cfg,
        agents: {
          ...f.cfg.agents,
          entries: { [f.target.agentId]: { conversationMode } },
        },
      };
      if (conversationMode === "branches") {
        await ensureAgentConversationRoot({
          cfg,
          agentId: f.target.agentId,
          env: state.env,
          getConfig: () => cfg,
        });
      }
      let checks = 0;
      bindConversationPrivateAudience(f.ctx, {
        agentId: f.target.agentId,
        sessionKey: f.target.sessionKey,
        channelId: "matrix",
        accountId: "default",
        nativeChannelId: "!private:example.test",
        participant: { type: "profile", id: "target-owner" },
        assertCurrent() {
          if (++checks > 1) {
            throw new Error("Original private audience revoked");
          }
        },
      });
      await expect(initSessionState({ cfg, ctx: f.ctx, commandAuthorized: true })).rejects.toThrow(
        "Original private audience revoked",
      );
      expect(loadSessionEntry(f.target)).toBeUndefined();
    },
  );
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
  it.each([false, true])(
    "uses the real ingress row without a task-parent edge (retained root: %s)",
    async (retainedRoot) => {
      const f = await fixture(retainedRoot ? "retained-copy" : "main");
      if (retainedRoot) {
        const branchConfig = {
          ...f.cfg,
          agents: {
            ...f.cfg.agents,
            entries: { [f.target.agentId]: { conversationMode: "branches" as const } },
          },
        };
        await ensureAgentConversationRoot({
          cfg: branchConfig,
          agentId: f.target.agentId,
          env: state.env,
          getConfig: () => branchConfig,
        });
      }
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
            agentId: f.target.agentId,
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
        const beforeNext = loadSessionEntry(f.target)!;
        const historyBeforeNext = await loadTranscriptEvents(f.target);
        const next = await initSessionState({ cfg: f.cfg, ctx: f.ctx, commandAuthorized: true });
        expect(next.sessionId).toBe(f.target.sessionId);
        expect(next.sessionEntry.lifecycleRevision).toBe(beforeNext.lifecycleRevision);
        expect(next.sessionEntry.forkSource).toEqual(beforeNext.forkSource);
        expect(next.sessionEntry.visibility).toBe(beforeNext.visibility);
        expect(next.sessionEntry.createdActor).toEqual(beforeNext.createdActor);
        expect(next.sessionEntry.parentSessionKey).toBeUndefined();
        expect(next.sessionEntry.spawnedBy).toBeUndefined();
        expect(await loadTranscriptEvents(f.target)).toEqual(historyBeforeNext);
        if (retainedRoot) {
          expect(loadSessionEntry(f.target)).toMatchObject({
            conversationTopology: { role: "branch" },
          });
        }
        expect(
          (await loadTranscriptEvents(f.target)).filter((event) =>
            JSON.stringify(event).includes("A completed source answer."),
          ),
        ).toHaveLength(1);
      } finally {
        grant.release();
      }
    },
  );

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
