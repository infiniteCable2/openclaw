import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { ensureAgentConversationRoot } from "./session-conversation-root.js";
import { createSessionEntryWithTranscriptIfAbsent } from "./session-entry-creation.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";
import type { InternalSessionEntry } from "./types.js";

function rootFixture(overrides: Partial<InternalSessionEntry> = {}): InternalSessionEntry {
  return {
    sessionId: "existing-root",
    lifecycleRevision: "original-root-generation",
    updatedAt: 1,
    createdAt: 1,
    createdVia: "internal",
    createdActor: { type: "system", id: "conversation-root" },
    visibility: "draft",
    delivery: { kind: "none" },
    conversationTopology: { version: 1, role: "root" },
    ...overrides,
  };
}

describe("host conversation root admission", () => {
  it("preserves native main history and reuses one internal root across main-key changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const nativeScope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:main",
        sessionId: "native-conversation",
      };
      replaceSessionEntrySync(nativeScope, {
        sessionId: nativeScope.sessionId,
        updatedAt: 1,
      });
      await appendTranscriptMessage(nativeScope, {
        message: { role: "user", content: "Keep the native conversation." },
      });
      const before = await readSessionEntryReadOnlyInWorker(nativeScope);
      const events = await loadTranscriptEvents(nativeScope);
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { conversationMode: "branches" } } },
      };
      const root = await ensureAgentConversationRoot({ cfg, agentId: "main", env: state.env });
      cfg.session = { mainKey: "primary" };
      const reused = await ensureAgentConversationRoot({ cfg, agentId: "main", env: state.env });
      expect(reused.created).toBe(false);
      expect(reused.sessionKey).toBe(root.sessionKey);
      expect(reused.entry).toEqual(root.entry);
      expect(await readSessionEntryReadOnlyInWorker(nativeScope)).toEqual(before);
      expect(await loadTranscriptEvents(nativeScope)).toEqual(events);
      expect(
        await readSessionEntryReadOnlyInWorker({
          ...nativeScope,
          sessionKey: "agent:main:primary",
        }),
      ).toBeUndefined();
    });
  });

  it("creates only an empty private system root, then reuses it without writes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { conversationMode: "branches" } } },
      };
      const params = { cfg, agentId: "main", env: state.env };
      const root = await ensureAgentConversationRoot(params);
      expect(root.sessionKey).toBe("agent:main:internal:conversation-root");
      const scope = { agentId: "main", env: state.env, sessionKey: root.sessionKey };
      const before = await readSessionEntryReadOnlyInWorker(scope);
      const events = await loadTranscriptEvents({ ...scope, sessionId: root.entry.sessionId });
      expect(root.created).toBe(true);
      expect(before).toMatchObject({
        sessionId: root.entry.sessionId,
        lifecycleRevision: root.entry.lifecycleRevision,
        createdVia: "internal",
        createdActor: { type: "system", id: "conversation-root" },
        visibility: "draft",
        delivery: { kind: "none" },
        conversationTopology: { version: 1, role: "root" },
      });
      expect(root.entry.lifecycleRevision).toBeTruthy();
      expect(before?.owner).toBeUndefined();
      expect(before?.parentSessionKey).toBeUndefined();
      expect(before?.spawnedBy).toBeUndefined();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "session", id: root.entry.sessionId });
      const reused = await ensureAgentConversationRoot(params);
      expect(reused.created).toBe(false);
      expect(await readSessionEntryReadOnlyInWorker(scope)).toEqual(before);
      expect(await loadTranscriptEvents({ ...scope, sessionId: root.entry.sessionId })).toEqual(
        events,
      );
    });
  });

  it.each([
    { conversationTopology: undefined },
    { createdActor: { type: "human", source: "profile", id: "fixture-person" } },
    { visibility: "shared" },
    { parentSessionKey: "agent:main:another-conversation" },
    { lifecycleRevision: undefined },
    { delivery: normalizeSessionDeliveryState({ context: { channel: "matrix", to: "fixture" } }) },
  ] satisfies Partial<InternalSessionEntry>[])(
    "refuses existing non-root state %# without adoption",
    async (patch) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = {
          agentId: "main",
          env: state.env,
          sessionKey: "agent:main:internal:conversation-root",
          sessionId: "existing-root",
        };
        replaceSessionEntrySync(scope, rootFixture(patch));
        await appendTranscriptMessage(scope, {
          message: { role: "user", content: "Preserve this conversation." },
        });
        const before = await readSessionEntryReadOnlyInWorker(scope);
        const events = await loadTranscriptEvents(scope);
        await expect(
          ensureAgentConversationRoot({
            cfg: { agents: { entries: { main: { conversationMode: "branches" } } } },
            agentId: "main",
            env: state.env,
          }),
        ).rejects.toThrow("explicitly migrate");
        expect(await readSessionEntryReadOnlyInWorker(scope)).toEqual(before);
        expect(await loadTranscriptEvents(scope)).toEqual(events);
      });
    },
  );

  it("preserves a concurrent winner and its history instead of replacing a now-claimed key", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:internal:conversation-root",
        sessionId: "winning-root",
      };
      let winner: InternalSessionEntry | undefined;
      let history: Awaited<ReturnType<typeof loadTranscriptEvents>> = [];
      await expect(
        createSessionEntryWithTranscriptIfAbsent(scope, async ({ targetEntry }) => {
          expect(targetEntry).toBeUndefined();
          replaceSessionEntrySync(scope, rootFixture({ sessionId: scope.sessionId }));
          await appendTranscriptMessage(scope, {
            message: { role: "assistant", content: "Winning history." },
          });
          winner = await readSessionEntryReadOnlyInWorker(scope);
          history = await loadTranscriptEvents(scope);
          return { ok: true, entry: rootFixture({ sessionId: "losing-root" }) };
        }),
      ).rejects.toThrow("unclaimed conversation");
      expect(await readSessionEntryReadOnlyInWorker(scope)).toEqual(winner);
      expect(await loadTranscriptEvents(scope)).toEqual(history);
      expect(await loadTranscriptEvents({ ...scope, sessionId: "losing-root" })).toEqual([]);
    });
  });

  it("rechecks the native commit guard before publishing either row or header", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:internal:conversation-root",
        sessionId: "revoked-root",
      };
      let revoked = false;
      await expect(
        createSessionEntryWithTranscriptIfAbsent(
          scope,
          () => ({ ok: true, entry: rootFixture({ sessionId: scope.sessionId }) }),
          {
            onPhase: (phase) => {
              if (phase === "writerAdmission") {
                revoked = true;
              }
            },
            commitGuard: () => {
              if (revoked) {
                throw new Error("Host startup superseded");
              }
            },
          },
        ),
      ).rejects.toThrow("Host startup superseded");
      expect(await readSessionEntryReadOnlyInWorker(scope)).toBeUndefined();
      expect(await loadTranscriptEvents(scope)).toEqual([]);
    });
  });

  it("rejects cancellation and an opted-out current config before creation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { conversationMode: "branches" } } },
      };
      const controller = new AbortController();
      controller.abort(new Error("Startup cancelled"));
      await expect(
        ensureAgentConversationRoot({
          cfg,
          agentId: "main",
          env: state.env,
          signal: controller.signal,
        }),
      ).rejects.toThrow("Startup cancelled");
      await expect(
        ensureAgentConversationRoot({
          cfg,
          agentId: "main",
          env: state.env,
          getConfig: () => ({ agents: { entries: { main: {} } } }),
        }),
      ).rejects.toThrow("configuration changed");
      expect(
        await readSessionEntryReadOnlyInWorker({
          agentId: "main",
          env: state.env,
          sessionKey: "agent:main:internal:conversation-root",
        }),
      ).toBeUndefined();
    });
  });

  it("refuses global scope and a store outside the native configured physical selection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { conversationMode: "branches" } } },
      };
      await expect(
        ensureAgentConversationRoot({
          cfg: { ...cfg, session: { scope: "global" } },
          agentId: "main",
          env: state.env,
        }),
      ).rejects.toThrow("not global scope");
      await expect(
        ensureAgentConversationRoot({
          cfg,
          agentId: "main",
          env: state.env,
          admittedStorePath: state.statePath("unrelated.sqlite"),
        }),
      ).rejects.toThrow("admitted physical session store");
      expect(
        await readSessionEntryReadOnlyInWorker({
          agentId: "main",
          env: state.env,
          sessionKey: "agent:main:internal:conversation-root",
        }),
      ).toBeUndefined();
    });
  });
});
