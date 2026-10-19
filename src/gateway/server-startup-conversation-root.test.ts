import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../auto-reply/reply/session.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveAgentConversationRootSessionKey } from "../config/sessions/session-conversation-root-key.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { loadTranscriptEvents } from "../config/sessions/session-transcript-events.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayStartupSessions } from "./server-startup-session-migration.js";

describe("Gateway host conversation root startup", () => {
  it("prepares legacy channel history before the first and next real native reply initialization", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { conversationMode: "branches" } } },
        session: { reset: { mode: "idle", idleMinutes: 1_440 } },
      };
      await state.writeConfig(cfg);
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const scope = {
        agentId: "main",
        storePath: database.path,
        env: state.env,
        sessionKey: "agent:main:matrix:channel:synthetic-room",
        sessionId: "original-legacy-conversation",
      };
      replaceSessionEntrySync(scope, {
        sessionId: scope.sessionId,
        updatedAt: Date.now(),
        createdVia: "channel",
        chatType: "channel",
      });
      await appendTranscriptMessage(scope, {
        message: { role: "user", content: "Keep this original conversation." },
      });
      const before = await readSessionEntryReadOnlyInWorker(scope);
      const history = await loadTranscriptEvents(scope);
      expect(before?.lifecycleRevision).toBeUndefined();
      await prepareGatewayStartupSessions({
        cfg,
        env: state.env,
        log: { info: vi.fn(), warn: vi.fn() },
      });
      const initialized = await readSessionEntryReadOnlyInWorker(scope);
      expect(initialized).toEqual({ ...before, lifecycleRevision: expect.any(String) });
      expect(await loadTranscriptEvents(scope)).toEqual(history);
      const ctx = finalizeInboundContext({
        AgentId: "main",
        SessionKey: scope.sessionKey,
        Provider: "matrix",
        From: "synthetic-peer",
        To: "synthetic-room",
        ChatType: "channel",
        Body: "Continue the conversation.",
      });
      for (let turn = 0; turn < 2; turn++) {
        const result = await initSessionState({ cfg, ctx, commandAuthorized: false });
        expect(result.sessionId).toBe(scope.sessionId);
        expect(result.sessionEntry.lifecycleRevision).toBe(initialized?.lifecycleRevision);
        expect(await readSessionEntryReadOnlyInWorker(scope)).toMatchObject({
          conversationTopology: { role: "branch" },
        });
        expect(await loadTranscriptEvents(scope)).toEqual(history);
      }
    });
  });
  it.each(["initial", "deferred"] as const)(
    "refuses shared branch/native stores before %s startup maintenance or root creation",
    async (phase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath = state.statePath("shared.sqlite");
        const cfg: OpenClawConfig = {
          agents: { entries: { main: { conversationMode: "branches" }, helper: {} } },
          session: { store: storePath },
        };
        const resolveTargets = vi.fn();
        await expect(
          prepareGatewayStartupSessions({
            cfg,
            env: state.env,
            agentIds: phase === "deferred" ? new Set(["helper"]) : undefined,
            log: { info: vi.fn(), warn: vi.fn() },
            deps: { resolveAllAgentSessionStoreTargetsSync: resolveTargets },
          }),
        ).rejects.toThrow(/same physical session database.*not supported in branches mode/);
        expect(resolveTargets).not.toHaveBeenCalled();
        await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it("refuses a branch database owned by another agent even without a second configured agent", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("agents", "other", "agent", "openclaw-agent.sqlite");
      const cfg: OpenClawConfig = {
        agents: { entries: { researcher: { conversationMode: "branches" } } },
        session: { store: storePath },
      };
      await expect(
        prepareGatewayStartupSessions({
          cfg,
          env: state.env,
          log: { info: vi.fn(), warn: vi.fn() },
        }),
      ).rejects.toThrow(/belongs to another agent.*dedicated agent-owned session database/);
      await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("detects directory aliases before creating either branch root", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const firstDirectory = state.statePath("agents", "main", "agent");
      const aliasDirectory = state.statePath("agents", "helper", "agent");
      await fs.mkdir(firstDirectory, { recursive: true });
      await fs.mkdir(path.dirname(aliasDirectory), { recursive: true });
      await fs.symlink(firstDirectory, aliasDirectory, "junction");
      const cfg: OpenClawConfig = {
        agents: {
          entries: {
            main: { conversationMode: "branches" },
            helper: { conversationMode: "branches" },
          },
        },
      };
      await expect(
        prepareGatewayStartupSessions({
          cfg,
          env: state.env,
          log: { info: vi.fn(), warn: vi.fn() },
        }),
      ).rejects.toThrow(/same physical session database/);
      await expect(fs.readdir(firstDirectory)).resolves.toEqual([]);
    });
  });

  it("keeps native shared-store startup unchanged", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {}, helper: {} } },
        session: { store: state.statePath("shared.sqlite") },
      };
      await expect(
        prepareGatewayStartupSessions({
          cfg,
          env: state.env,
          log: { info: vi.fn(), warn: vi.fn() },
        }),
      ).resolves.toEqual([]);
    });
  });

  it("accepts a fixed selector that natively partitions agents into different database files", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("custom", "sessions.json");
      const cfg: OpenClawConfig = {
        agents: {
          entries: {
            main: { conversationMode: "branches" },
            helper: { conversationMode: "branches" },
          },
        },
        session: { store: storePath },
      };
      const databases = await prepareGatewayStartupSessions({
        cfg,
        env: state.env,
        log: { info: vi.fn(), warn: vi.fn() },
      });
      expect(databases).toHaveLength(2);
      expect(new Set(databases.map(({ database }) => database.path)).size).toBe(2);
      for (const agentId of ["main", "helper"]) {
        await expect(
          readSessionEntryReadOnlyInWorker({
            agentId,
            storePath,
            env: state.env,
            sessionKey: resolveAgentConversationRootSessionKey({ cfg, agentId }),
          }),
        ).resolves.toMatchObject({ conversationTopology: { role: "root" } });
      }
    });
  });

  it.each(["initial", "deferred"] as const)(
    "admits configured branch roots before %s readiness, without creating native-mode roots",
    async (phase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg: OpenClawConfig = {
          agents: {
            entries: {
              main: { conversationMode: "branches" },
              helper: { conversationMode: "branches" },
              ordinary: {},
            },
          },
        };
        const databases = await prepareGatewayStartupSessions({
          cfg,
          getConfig: () => cfg,
          env: state.env,
          agentIds: phase === "deferred" ? new Set(["helper"]) : undefined,
          log: { info: vi.fn(), warn: vi.fn() },
        });
        for (const agentId of ["main", "helper", "ordinary"]) {
          const scope = {
            agentId,
            env: state.env,
            sessionKey: resolveAgentConversationRootSessionKey({ cfg, agentId }),
          };
          const entry = await readSessionEntryReadOnlyInWorker(scope);
          const expected = agentId === "helper" || (phase === "initial" && agentId === "main");
          if (!expected) {
            expect(entry).toBeUndefined();
            continue;
          }
          expect(entry).toMatchObject({
            createdActor: { type: "system", id: "conversation-root" },
            visibility: "draft",
            delivery: { kind: "none" },
            conversationTopology: { version: 1, role: "root" },
          });
          expect(entry?.lifecycleRevision).toBeTruthy();
          if (!entry) {
            throw new Error("Startup returned without its configured conversation root");
          }
          const events = await loadTranscriptEvents({ ...scope, sessionId: entry.sessionId });
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({ type: "session", id: entry.sessionId });
          expect(
            await readSessionEntryReadOnlyInWorker({
              ...scope,
              sessionKey: `agent:${agentId}:main`,
            }),
          ).toBeUndefined();
        }
        expect(databases).toHaveLength(phase === "initial" ? 2 : 1);
        for (const database of databases) {
          expect(() => database.assertCurrent()).not.toThrow();
        }
      });
    },
  );
});
