import { describe, expect, it, vi } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import * as candidates from "./session-accessor.sqlite-maintenance-candidates.js";
import {
  applySessionEntryMaintenanceInDatabase,
  prepareSessionEntryMaintenanceInDatabase,
} from "./session-accessor.sqlite-maintenance-store.js";
import { ensureAgentConversationRoot } from "./session-conversation-root.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

const preservation = () => ({ providerKeys: [], workIdentities: [], lifecycleIdentities: [] });

describe("native conversation root maintenance protection", () => {
  it.each(["age", "cap"] as const)(
    "retains a headless root under %s pressure without task ancestry",
    async (reason) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const root = await ensureAgentConversationRoot({
          cfg: {
            agents: { entries: { main: { conversationMode: "branches" } } },
            session: { mainKey: "root-conversation" },
          },
          agentId: "main",
          env: state.env,
        });
        const scope = {
          agentId: "main",
          env: state.env,
          sessionKey: root.sessionKey,
          sessionId: root.entry.sessionId,
        };
        replaceSessionEntrySync(scope, { ...root.entry, updatedAt: 1 });
        const lifecycleRevision = root.entry.lifecycleRevision;
        if (!lifecycleRevision) {
          throw new Error("Root admission omitted its lifecycle revision");
        }
        const branch = {
          ...scope,
          sessionKey: "agent:main:conversation-a",
          sessionId: "ordinary-branch",
        };
        replaceSessionEntrySync(branch, {
          sessionId: branch.sessionId,
          updatedAt: 2,
          conversationTopology: {
            version: 1,
            role: "branch",
            rootSessionKey: root.sessionKey,
            rootSessionId: root.entry.sessionId,
            rootSessionLifecycleRevision: lifecycleRevision,
          },
        });
        const before = await readSessionEntryReadOnlyInWorker(scope);
        const transcript = await loadTranscriptEvents(scope);
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const plan = runOpenClawAgentWriteTransaction(
          (owned) =>
            applySessionEntryMaintenanceInDatabase(
              owned,
              {
                maintenance: {
                  ...resolveMaintenanceConfigFromInput({
                    mode: "enforce",
                    maxEntries: reason === "cap" ? 1 : 100,
                  }),
                  pruneAfterMs: reason === "age" ? 1_000 : 0,
                  archiveDashboardAfterMs: null,
                  preserveRecentMs: null,
                },
                archiveDirectory: state.statePath("maintenance-archives"),
                storePath: database.path,
                forceMaintenance: true,
              },
              preservation,
            ),
          { agentId: "main", env: state.env, path: database.path },
        );
        expect(plan.archivedEntries).toEqual([
          { sessionKey: branch.sessionKey, sessionId: branch.sessionId },
        ]);
        expect(plan.entryRemovals).toEqual([]);
        expect(await readSessionEntryReadOnlyInWorker(scope)).toEqual(before);
        expect(await loadTranscriptEvents(scope)).toEqual(transcript);
        expect((await readSessionEntryReadOnlyInWorker(branch))?.archivedAt).toBeDefined();
        expect(before?.parentSessionKey).toBeUndefined();
        expect(before?.spawnedBy).toBeUndefined();
      });
    },
  );

  it("refuses a planned root archive using the actual writer row before commit", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const root = await ensureAgentConversationRoot({
        cfg: {
          agents: { entries: { main: { conversationMode: "branches" } } },
          session: { mainKey: "root-conversation" },
        },
        agentId: "main",
        env: state.env,
      });
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: root.sessionKey,
        sessionId: root.entry.sessionId,
      };
      replaceSessionEntrySync(scope, { ...root.entry, updatedAt: 1 });
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const before = await readSessionEntryReadOnlyInWorker(scope);
      const readProjection = candidates.readSessionMaintenanceKeyProjection;
      // Exercise final writer protection independently of planner correctness:
      // the real row remains a root while this one planning projection omits it.
      const projection = vi
        .spyOn(candidates, "readSessionMaintenanceKeyProjection")
        .mockImplementationOnce((...args) => {
          const store = readProjection(...args);
          delete store[root.sessionKey]?.conversationTopology;
          return store;
        });
      let prepared: ReturnType<typeof prepareSessionEntryMaintenanceInDatabase>;
      try {
        prepared = prepareSessionEntryMaintenanceInDatabase(
          database,
          {
            maintenance: {
              ...resolveMaintenanceConfigFromInput({ mode: "enforce", maxEntries: 100 }),
              pruneAfterMs: 1_000,
              archiveDashboardAfterMs: null,
              preserveRecentMs: null,
            },
            archiveDirectory: state.statePath("maintenance-archives"),
            storePath: database.path,
            forceMaintenance: true,
          },
          preservation,
        );
      } finally {
        projection.mockRestore();
      }
      expect(prepared.kind).toBe("write");
      if (prepared.kind !== "write") {
        throw new Error("Fixture failed to prepare its deliberate stale root victim");
      }
      const apply = prepared.captureMutation();
      expect(() =>
        runOpenClawAgentWriteTransaction((owned) => apply(owned), {
          agentId: "main",
          env: state.env,
          path: database.path,
        }),
      ).toThrow("maintenance candidates became protected before commit");
      expect(await readSessionEntryReadOnlyInWorker(scope)).toEqual(before);
    });
  });
});
