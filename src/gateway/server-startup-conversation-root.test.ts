import { describe, expect, it, vi } from "vitest";
import { resolveAgentConversationRootSessionKey } from "../config/sessions/session-conversation-root-key.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { loadTranscriptEvents } from "../config/sessions/session-transcript-events.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayStartupSessions } from "./server-startup-session-migration.js";

describe("Gateway host conversation root startup", () => {
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
