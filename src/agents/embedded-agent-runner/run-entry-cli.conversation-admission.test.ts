import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { installSessionPlacementAdmissionProvider } from "../session-placement-admission.js";
import { withAdmittedCliCandidate } from "./run-entry-cli.js";

// There are no spawned tasks in these candidate-admission fixtures.
vi.mock("../subagents/registry/subagent-registry.js", () => ({
  markRequesterTurnYielded: vi.fn(async () => 0),
  settleRequesterAfterSessionSpawns: vi.fn(async () => true),
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cli-conversation-admission-");

describe("CLI conversation model admission", () => {
  it.each([
    ["read-only", "root"],
    ["writable", "root"],
    ["read-only", "branch"],
    ["writable", "branch"],
    ["read-only", "native"],
    ["writable", "native"],
  ] as const)(
    "checks the fresh %s candidate's %s topology before its callback",
    async (readMode, role) => {
      const storePath = path.join(sessionDirs.make(), "sessions.json");
      const sessionKey = "agent:main:cli-root-fence";
      const sessionEntry: InternalSessionEntry = {
        sessionId: "cli-root-fence",
        updatedAt: 1000,
        lifecycleRevision: "cli-root-fence-revision",
      };
      await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
      const admittedEntry: InternalSessionEntry = { ...sessionEntry };
      if (role !== "native") {
        admittedEntry.conversationTopology =
          role === "root"
            ? { version: 1, role: "root" }
            : {
                version: 1,
                role: "branch",
                rootSessionKey: "agent:main:main",
                rootSessionId: "root-session",
                rootSessionLifecycleRevision: "root-revision",
              };
      }
      const uninstall = installSessionPlacementAdmissionProvider({
        assertCompactionSuccessorAllowed: () => {},
        executeLocalTurn: async (_claim, runLocal) => {
          await replaceSessionEntry({ sessionKey, storePath }, admittedEntry);
          return await runLocal();
        },
        executeTurn: async (_claim, _params, runLocal) => await runLocal(),
      });
      const callback = vi.fn<Parameters<typeof withAdmittedCliCandidate>[1]>(async () => ({
        payloads: [{ text: "candidate completed" }],
        meta: { durationMs: 1 },
      }));
      try {
        const run = withAdmittedCliCandidate(
          {
            claim: {
              agentId: "main",
              sessionKey,
              sessionId: sessionEntry.sessionId,
              runId: "root-fence",
            },
            admission: undefined,
            provider: "claude-cli",
            sessionTarget: {
              agentId: "main",
              sessionKey,
              sessionId: sessionEntry.sessionId,
              storePath,
            },
            expectedLifecycleRevision: sessionEntry.lifecycleRevision,
            readMode,
            // This pre-placement snapshot deliberately lacks the current private topology.
            getSessionEntry: () => sessionEntry,
          },
          callback,
        );
        if (role === "root") {
          await expect(run).rejects.toThrow(
            "A consolidating conversation root cannot run model work",
          );
          expect(callback).not.toHaveBeenCalled();
        } else {
          await expect(run).resolves.toMatchObject({ payloads: [{ text: "candidate completed" }] });
          expect(callback).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ sessionEntry: expect.objectContaining(admittedEntry) }),
          );
        }
      } finally {
        uninstall();
      }
    },
  );
});
