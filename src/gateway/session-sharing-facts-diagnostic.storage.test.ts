import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { SessionMutationFactsUnavailableError } from "./session-sharing-incognito.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

it("retains ordinary native writes and attributes the first actual invalidation without changing rejection", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("facts-diagnostic.sqlite");
    const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const target = { agentId: "main", sessionKey: "agent:main:diagnostic", storePath };
    const entry = {
      sessionId: "synthetic-session",
      lifecycleRevision: "same-generation",
      updatedAt: 1,
    };
    replaceSessionEntrySync(target, entry);
    const facts = await prepareSessionMutationFacts({ cfg, ...target });
    try {
      for (let turn = 0; turn < 3; turn++) {
        replaceSessionEntrySync(target, { ...entry, updatedAt: turn + 2, label: `Turn ${turn}` });
        expect(facts.readCurrent(cfg).target.entry.sessionId).toBe(entry.sessionId);
      }
      sessionChanges.emit({ all: true, scope: "stores" });
      sessionChanges.emit({ ...target, factsInvalidated: true });
      let caught: unknown;
      try {
        facts.readCurrent(cfg);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionMutationFactsUnavailableError);
      expect(caught).toMatchObject({
        diagnostic: {
          reason: "invalidated",
          firstInvalidation: { reason: "store-topology", scope: "stores" },
        },
      });
    } finally {
      facts.release();
    }
    expect(() => facts.readCurrent(cfg)).toThrow("Session access facts are unavailable");
  });
});

it("distinguishes current routing changes from storage preparation failure", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("facts-routing.sqlite");
    const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const target = { agentId: "main", sessionKey: "agent:main:routing", storePath };
    replaceSessionEntrySync(target, { sessionId: "routing", updatedAt: 1 });
    const facts = await prepareSessionMutationFacts({ cfg, ...target });
    try {
      expect(() =>
        facts.readCurrent({ ...cfg, session: { ...cfg.session, mainKey: "changed" } }),
      ).toThrow(expect.objectContaining({ diagnostic: { reason: "routing-changed" } }));
    } finally {
      facts.release();
    }
    await expect(
      prepareSessionMutationFacts({ cfg, ...target, sessionKey: "agent:main:missing" }),
    ).rejects.toBeInstanceOf(SessionMutationFactsUnavailableError);
  });
});
