import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { isSessionWorkAdmissionActive } from "../../sessions/session-lifecycle-admission.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { beginCronSessionWorkAdmission, type MutableCronSession } from "./run-session-state.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cron-conversation-admission-");

describe("cron conversation model admission", () => {
  it.each(["root", "branch", "native"] as const)(
    "admits model work only for a non-root current %s session",
    async (role) => {
      const storePath = path.join(sessionDirs.make(), "sessions.json");
      const sessionKey = "agent:main:cron-model-admission";
      const lifecycleRevision = "cron-model-revision";
      const entry: InternalSessionEntry = {
        sessionId: "run-session-id",
        updatedAt: 1000,
        systemSent: true,
        lifecycleRevision,
      };
      if (role !== "native") {
        entry.conversationTopology =
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
      await replaceSessionEntry({ sessionKey, storePath }, entry);
      const cronSession: MutableCronSession = {
        storePath,
        store: { [sessionKey]: { ...entry } },
        sessionEntry: { ...entry },
        initialSessionEntry: { ...entry },
        lifecycleRevision,
        systemSent: true,
        isNewSession: false,
        previousSessionId: undefined,
        resetBoundaryPending: undefined,
      };
      const run = beginCronSessionWorkAdmission({
        cronSession,
        agentSessionKey: sessionKey,
        runSessionKey: `${sessionKey}:run:model`,
        onInterrupt: vi.fn(),
      });
      if (role === "root") {
        await expect(run).rejects.toMatchObject({
          name: "CronSessionLifecycleClaimError",
          message: expect.stringContaining(
            "A consolidating conversation root cannot run model work",
          ),
        });
      } else {
        const admission = await run;
        try {
          expect(isSessionWorkAdmissionActive(storePath, [sessionKey, entry.sessionId])).toBe(true);
          await expect(admission.run(async () => "admitted")).resolves.toBe("admitted");
        } finally {
          admission.release();
        }
      }
      expect(isSessionWorkAdmissionActive(storePath, [sessionKey, entry.sessionId])).toBe(false);
    },
  );
});
