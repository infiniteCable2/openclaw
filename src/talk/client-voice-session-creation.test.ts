import { expect, it, vi } from "vitest";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionPendingInputAuthorityFacts } from "../config/sessions/session-pending-input-authority.js";
import type { SessionSourceTransactionGrant } from "../config/sessions/session-source-authority.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ensureClientVoiceAgentSessionEntry } from "./client-voice-session-write.js";

it.each(["native", "opaque"] as const)(
  "preserves ordinary configured SDK creation with %s source authority",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("sdk-voice.sqlite");
      const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
      await state.writeConfig(cfg);
      const target = { agentId: "main", sessionKey: "agent:main:sdk-voice", storePath };
      let allowed = true;
      const requester = Object.assign(
        vi.fn(() => {
          if (!allowed) {
            throw new Error("SDK source revoked");
          }
        }),
        { nativeSource: true, ...(kind === "opaque" ? { opaqueCommitGuard: true } : {}) },
      );
      const onCommitted = vi.fn();
      const params = { ...target, cfg, requester, onCommitted };
      const sessionId = await ensureClientVoiceAgentSessionEntry(params);
      expect(requester).toHaveBeenCalled();
      expect(onCommitted).toHaveBeenCalledOnce();
      expect(await ensureClientVoiceAgentSessionEntry(params)).toBe(sessionId);
      expect(onCommitted).toHaveBeenCalledOnce();
      allowed = false;
      await expect(ensureClientVoiceAgentSessionEntry(params)).rejects.toThrow(
        "SDK source revoked",
      );
      expect((await readSessionEntryReadOnlyInWorker(target))?.sessionId).toBe(sessionId);
    });
  },
);

it.each([false, true])(
  "creates and reuses a Talk row with native transaction authority (warm: %s)",
  async (warm) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("voice-creation.sqlite");
      const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
      await state.writeConfig(cfg);
      const target = { agentId: "main", sessionKey: "agent:main:voice-creation", storePath };
      if (warm) {
        openOpenClawAgentDatabase({ agentId: target.agentId, path: storePath });
      }
      const facts: SessionPendingInputAuthorityFacts[] = [];
      const release = vi.fn();
      const onCommittedSource = vi.fn();
      const onCreatedSessionCommitted = vi.fn();
      const prepareWorkerGrant = vi.fn(
        async (source?: Omit<SessionSourceTransactionGrant, "assertCurrent">) => {
          expect(source?.source.databaseIdentity).toBeTruthy();
          expect(source?.agentId).toBe(target.agentId);
          expect(source?.sessionKey).toBe(target.sessionKey);
          if (!source) {
            throw new Error("Missing prepared source");
          }
          return {
            assertCurrent() {},
            assertLifetimeCurrent() {},
            release,
            transaction: {
              ...source,
              assertCurrent(value: SessionPendingInputAuthorityFacts) {
                expect(value.readSource?.databaseIdentity).toBe(source.source.databaseIdentity);
                expect(value.sessionKey).toBe(target.sessionKey);
                facts.push(value);
              },
            },
          };
        },
      );
      const params = {
        ...target,
        cfg,
        prepareWorkerGrant,
        onCommittedSource,
        onCreatedSessionCommitted,
      };
      const sessionId = await ensureClientVoiceAgentSessionEntry(params);
      expect(facts.length).toBeGreaterThanOrEqual(2);
      expect(facts.every((value) => value.entry === undefined)).toBe(true);
      expect(onCommittedSource).toHaveBeenCalledOnce();
      expect(onCreatedSessionCommitted).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      facts.length = 0;
      expect(await ensureClientVoiceAgentSessionEntry(params)).toBe(sessionId);
      expect(facts.length).toBeGreaterThanOrEqual(2);
      expect(facts.every((value) => value.entry?.sessionId === sessionId)).toBe(true);
      expect(onCommittedSource).toHaveBeenCalledOnce();
      expect(onCreatedSessionCommitted).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledTimes(2);
      expect((await readSessionEntryReadOnlyInWorker(target))?.sessionId).toBe(sessionId);
    });
  },
);

it.each(["foreign-target", "commit-revoked"] as const)(
  "leaves no Talk row when creation is %s",
  async (reason) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("refused-voice-creation.sqlite");
      const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
      await state.writeConfig(cfg);
      const target = { agentId: "main", sessionKey: "agent:main:refused-voice", storePath };
      const release = vi.fn();
      const onCreatedSessionCommitted = vi.fn();
      let assertions = 0;
      await expect(
        ensureClientVoiceAgentSessionEntry({
          ...target,
          cfg,
          onCreatedSessionCommitted,
          async prepareWorkerGrant(source) {
            if (!source) {
              throw new Error("Missing prepared source");
            }
            return {
              assertCurrent() {},
              assertLifetimeCurrent() {},
              release,
              transaction: {
                ...source,
                sessionKey: reason === "foreign-target" ? "agent:main:other" : source.sessionKey,
                assertCurrent() {
                  if (++assertions >= 2) {
                    throw new Error("Creation authorization revoked before COMMIT");
                  }
                },
              },
            };
          },
        }),
      ).rejects.toThrow(reason === "foreign-target" ? "exact creation" : "revoked before COMMIT");
      expect(await readSessionEntryReadOnlyInWorker(target)).toBeUndefined();
      expect(onCreatedSessionCommitted).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });
  },
);
