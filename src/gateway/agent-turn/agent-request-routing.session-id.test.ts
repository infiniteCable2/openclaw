import { expect, it, vi } from "vitest";
import { prepareEmbeddedRunSession } from "../../agents/embedded-agent-runner/run/session-bootstrap.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import * as resetPhase from "../server-methods/agent-reset-phase.js";
import * as contentPhase from "./agent-content-phase.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";
import { prepareAgentRequestRouting } from "./agent-request-routing.js";
import { createAgentTurnService } from "./agent-turn-service.js";
import type { AgentTurnPrincipal } from "./types.js";

async function route(
  cfg: OpenClawConfig,
  request: Parameters<typeof prepareAgentRequestRouting>[0]["request"],
) {
  const respond = vi.fn();
  const routing = await prepareAgentRequestRouting({
    cfg,
    request,
    runId: request.idempotencyKey,
    context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
    respond,
    isRawModelRun: false,
    agentDedupeKeys: [`agent:${request.idempotencyKey}`],
    reserveDedupe: vi.fn(),
    bindDedupeSessionTarget: vi.fn(),
    clearDedupe: vi.fn(),
  });
  expect(respond).not.toHaveBeenCalled();
  return routing;
}

it.each([
  { caller: "creation", createSessionIfMissing: false },
  { caller: "creation", createSessionIfMissing: true },
  { caller: "Gateway", createSessionIfMissing: false },
  { caller: "Gateway", createSessionIfMissing: true },
  { caller: "embedded", createSessionIfMissing: false },
])(
  "routes $caller session IDs (createSessionIfMissing=$createSessionIfMissing)",
  async ({ caller, createSessionIfMissing }) => {
    await withOpenClawTestState({ label: "session-id-routing" }, async (state) => {
      const storePath = state.statePath("sessions.json");
      const cfg: OpenClawConfig = {
        agents:
          caller === "creation"
            ? { entries: { main: {} } }
            : { ownership: "explicit", entries: { main: {}, ops: {} } },
        session: { store: storePath },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      try {
        if (caller === "creation") {
          await replaceSessionEntry(
            { agentId: "main", storePath, sessionKey: "agent:main:existing" },
            { sessionId: "existing-id", updatedAt: 1 },
          );
          expect(
            await route(cfg, {
              message: "start a named session",
              agentId: "main",
              sessionId: "new-id",
              createSessionIfMissing,
              idempotencyKey: "creation",
            }),
          ).toMatchObject({
            agentId: "main",
            requestedSessionId: "new-id",
            requestedSessionKey: createSessionIfMissing ? "agent:main:explicit:new-id" : undefined,
          });
          return;
        }
        const sessionKey = caller === "embedded" ? "unknown" : "global";
        for (const agentId of ["main", "ops"]) {
          await replaceSessionEntry(
            { agentId, storePath, sessionKey },
            { sessionId: `${agentId}-session`, updatedAt: 1 },
          );
          const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
          await closeOpenClawAgentDatabaseByPathAsync(target.path);
          unregisterOpenClawAgentDatabase({ agentId, path: target.path });
          expect(isOpenClawAgentDatabaseOpen(target.path)).toBe(false);
        }
        const openDatabase = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
        if (caller === "Gateway") {
          expect(
            await route(cfg, {
              message: "resume",
              sessionId: "ops-session",
              createSessionIfMissing,
              idempotencyKey: "lookup",
            }),
          ).toMatchObject({ agentId: "ops", requestedSessionKey: sessionKey });
        } else {
          const prepared = await prepareEmbeddedRunSession({
            config: cfg,
            sessionId: "ops-session",
            sessionFile: sessionKey,
            workspaceDir: state.workspaceDir,
            prompt: "resume",
            runId: "lookup",
            timeoutMs: 1000,
          });
          expect(prepared.params).toMatchObject({ sessionKey, agentId: "ops" });
        }
        expect(openDatabase).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
        clearRuntimeConfigSnapshot();
      }
    });
  },
);

function directConversationClient(): AgentTurnPrincipal {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin"],
    },
  };
}

it("refuses direct root input before content, reset, or execution despite internal-looking payloads", async () => {
  await withOpenClawTestState({ label: "agent-conversation-root-input" }, async (state) => {
    const storePath = state.statePath("sessions.json");
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { conversationMode: "branches" } } },
      session: { store: storePath, mainKey: "consolidation" },
      plugins: { enabled: false },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const execution = vi.spyOn(context, "trackExecution");
    const content = vi.spyOn(contentPhase, "prepareAgentContentPhase").mockResolvedValue(undefined);
    const reset = vi.spyOn(resetPhase, "runAgentResetPhase");
    const principal = directConversationClient();
    const service = createAgentTurnService({ context, isWebchatConnect: () => false });
    const payloads: Partial<AgentRunRequest>[] = [
      { sessionKey: "agent:main:internal:conversation-root" },
      { sessionKey: "internal:conversation-root" },
      { sessionKey: "agent:main:internal:conversation-root", message: "/reset continue" },
      { sessionKey: "internal:conversation-root", lane: "subagent" },
      {
        sessionKey: "internal:conversation-root",
        internalEvents: [
          {
            type: "task_completion",
            source: "subagent",
            childSessionKey: "agent:main:subagent:fixture",
            announceType: "task",
            taskLabel: "Fixture completion",
            status: "ok",
            statusLabel: "completed",
            result: "Synthetic result",
            replyInstruction: "Summarize this result.",
          },
        ],
      },
      {
        sessionKey: "internal:conversation-root",
        bootstrapContextMode: "lightweight",
        bootstrapContextRunKind: "heartbeat",
        sessionEffects: "internal",
        suppressPromptPersistence: true,
      },
    ];
    const invoke = async (patch: Partial<AgentRunRequest>, id: string) => {
      const io = { emitAcceptance: vi.fn(), emitFinal: vi.fn() };
      const request: AgentRunRequest = {
        message: "Do not route user input to the consolidating root",
        idempotencyKey: id,
        ...patch,
      };
      const preflight = await prepareAgentRequestPreflight({
        request,
        context,
        client: principal,
        io,
      });
      if (!preflight) {
        throw new Error("Fixture must reach conversation routing through native preflight");
      }
      await service.startTurn({ preflight, principal, io });
      return io;
    };
    try {
      for (const [index, payload] of payloads.entries()) {
        const io = await invoke(payload, `root-input-${index}`);
        expect(io.emitAcceptance).toHaveBeenCalledExactlyOnceWith(
          [
            false,
            undefined,
            expect.objectContaining({
              code: "INVALID_REQUEST",
              message: expect.stringContaining("reserves its internal root for consolidation"),
            }),
          ],
          undefined,
        );
        expect(io.emitFinal).not.toHaveBeenCalled();
      }
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey: "agent:main:consolidation" },
        {
          sessionId: "persisted-conversation-root",
          lifecycleRevision: "root-generation",
          updatedAt: 1,
          createdVia: "internal",
          createdActor: { type: "system", id: "conversation-root" },
          visibility: "draft",
          delivery: { kind: "none" },
          conversationTopology: { version: 1, role: "root" },
        },
      );
      cfg.agents = { entries: { main: { conversationMode: "native" } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      for (const [index, target] of [
        { sessionKey: "main" },
        { sessionId: "persisted-conversation-root" },
      ].entries()) {
        const optedOut = await invoke(target, `persisted-root-opt-out-${index}`);
        expect(optedOut.emitAcceptance).toHaveBeenCalledExactlyOnceWith(
          [
            false,
            undefined,
            expect.objectContaining({
              code: "INVALID_REQUEST",
              message: expect.stringContaining(
                "Explicitly migrate it before changing conversation mode",
              ),
            }),
          ],
          undefined,
        );
      }
      expect(content).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();
      expect(execution).not.toHaveBeenCalled();
      expect(context.dedupe.size).toBe(0);
    } finally {
      vi.restoreAllMocks();
      clearRuntimeConfigSnapshot();
    }
  });
});

it("keeps normal branches, native conversations, and host-owned task input routable", async () => {
  await withOpenClawTestState({ label: "agent-conversation-input-origin" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { conversationMode: "branches" } } },
      session: { store: state.statePath("sessions.json") },
      plugins: { enabled: false },
    };
    await state.writeConfig(cfg);
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const execution = vi.spyOn(context, "trackExecution");
    // Stop at the next real phase: this regression needs routing, not a model or a Gateway boot.
    const content = vi.spyOn(contentPhase, "prepareAgentContentPhase").mockResolvedValue(undefined);
    const service = createAgentTurnService({ context, isWebchatConnect: () => false });
    const direct = directConversationClient();
    const internal: AgentTurnPrincipal = {
      ...direct,
      internal: { syntheticClient: true, agentRunTracking: "native_subagent" },
    };
    const cases: Array<{
      mode: "branches" | "native";
      sessionKey: string;
      principal: AgentTurnPrincipal;
      input: true | undefined;
    }> = [
      { mode: "branches", sessionKey: "agent:main:matrix:room", principal: direct, input: true },
      { mode: "branches", sessionKey: "main", principal: direct, input: true },
      { mode: "native", sessionKey: "main", principal: direct, input: true },
      { mode: "branches", sessionKey: "main", principal: internal, input: undefined },
    ];
    try {
      for (const [index, entry] of cases.entries()) {
        cfg.agents = { entries: { main: { conversationMode: entry.mode } } };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        if (entry.principal === internal) {
          await replaceSessionEntry(
            {
              agentId: "main",
              storePath: state.statePath("sessions.json"),
              sessionKey: "agent:main:main",
            },
            {
              sessionId: "internal-task-root",
              lifecycleRevision: "root-generation",
              updatedAt: 1,
              createdVia: "internal",
              createdActor: { type: "system", id: "conversation-root" },
              visibility: "draft",
              delivery: { kind: "none" },
              conversationTopology: { version: 1, role: "root" },
            },
          );
        }
        const io = { emitAcceptance: vi.fn(), emitFinal: vi.fn() };
        const request: AgentRunRequest = {
          message: "Continue the admitted input",
          idempotencyKey: `conversation-origin-${index}`,
          sessionKey: entry.sessionKey,
        };
        const preflight = await prepareAgentRequestPreflight({
          request,
          context,
          client: entry.principal,
          io,
        });
        if (!preflight) {
          throw new Error("Fixture must pass native preflight");
        }
        await service.startTurn({ preflight, principal: entry.principal, io });
        expect(io.emitAcceptance).not.toHaveBeenCalled();
        expect(content).toHaveBeenCalledTimes(index + 1);
        expect(content).toHaveBeenLastCalledWith(
          expect.objectContaining({
            conversationInput: entry.input,
            requestedSessionKey: entry.sessionKey,
          }),
        );
        expect(context.dedupe.size).toBe(0);
      }
      expect(execution).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      clearRuntimeConfigSnapshot();
    }
  });
});
