import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  buildForkedChildTranscriptEvents,
  resolveParentForkSourceTranscript,
} from "../config/sessions/session-accessor.sqlite-parent-fork.js";
import { applySessionEntryLifecycleMutation } from "../config/sessions/session-accessor.sqlite-projection.js";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.sqlite-transcript-reports.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { PreparedInitialSessionContext } from "../config/sessions/session-initial-context.js";
import { prepareSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import { loadTranscriptEvents } from "../config/sessions/session-transcript-events.js";
import { prepareSessionTranscriptHydration } from "../config/sessions/session-transcript-hydration.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { linkEmail } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionListEntryFilter } from "./session-sharing-read.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import { prepareTranscriptReadAuthority } from "./session-transcript-read-authority.js";

function operator(profileId: string, options: { scopes?: string[]; signal?: AbortSignal } = {}) {
  const release = vi.fn();
  const retain = vi.fn(() => release);
  const authority = createAdmittedRunOperatorAuthority({
    profileId,
    scopes: options.scopes ?? ["operator.read"],
    signal: options.signal,
    assertCurrent: () => {},
    readCurrentRoleAssignment: () => null,
    retain,
  });
  return { authority, retain, release };
}

describe("retained transcript read authority", () => {
  it.each(["unchanged", "visibility", "different-grant", "missing-grant"] as const)(
    "carries the real read grant into atomic context seeding (%s)",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const reader = ensureProfileForEmail("seed-reader@example.test");
        const storePath = state.statePath("transcript-read-seed.sqlite");
        const cfg = {
          ...rolePolicyConfig(),
          agents: { entries: { main: {} } },
          session: { store: storePath },
        };
        const source = {
          agentId: "main",
          storePath,
          sessionKey: "agent:main:seed-source",
          sessionId: "seed-source",
        };
        const target = {
          ...source,
          sessionKey: "agent:main:seed-recipient",
          sessionId: "seed-recipient",
        };
        const sourceEntry: SessionEntry = {
          sessionId: source.sessionId,
          lifecycleRevision: "first",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: "other-profile" },
        };
        replaceSessionEntrySync(source, sourceEntry);
        await appendTranscriptMessage(source, {
          message: {
            role: "assistant",
            stopReason: "stop",
            content: "Authorized completed knowledge.",
          },
        });
        const grantSource =
          mode === "different-grant"
            ? { ...source, sessionKey: "agent:main:other-donor", sessionId: "other-donor" }
            : source;
        if (mode === "different-grant") {
          replaceSessionEntrySync(grantSource, {
            ...sourceEntry,
            sessionId: grantSource.sessionId,
          });
        }
        const principal = operator(reader.id);
        const grant = await prepareTranscriptReadAuthority({
          ...principal,
          getRuntimeConfig: () => cfg,
          sources: [grantSource],
        });
        try {
          const captured = grant.sources[0];
          if (!captured || typeof captured.readSource.databaseIdentity !== "string") {
            throw new Error("Synthetic seed source requires its admitted physical identity");
          }
          const hydration = await prepareSessionTranscriptHydration(source).read();
          if (hydration.kind !== "full") {
            throw new Error("Synthetic seed requires a full native transcript");
          }
          const selected = resolveParentForkSourceTranscript(
            hydration.snapshot.events,
            "last-completed",
          );
          if (!selected) {
            throw new Error("Synthetic seed requires a completed source answer");
          }
          const context: PreparedInitialSessionContext = {
            source: {
              ...captured.readSource,
              databaseIdentity: captured.readSource.databaseIdentity,
            },
            sourceSessionKey: source.sessionKey,
            sourceEntry: { sessionId: source.sessionId, lifecycleRevision: "first" },
            sourceVersion: hydration.snapshot.version,
            targetSessionId: target.sessionId,
            events: buildForkedChildTranscriptEvents({
              parentSessionFile: source.sessionKey,
              source: selected,
              targetSessionId: target.sessionId,
            }),
          };
          const entry: SessionEntry = {
            sessionId: target.sessionId,
            updatedAt: 2,
            permissionMode: "workspace",
            forkSource: { sessionKey: source.sessionKey, sessionId: source.sessionId },
            createdActor: { type: "human", source: "channel", id: "recipient-caller" },
          };
          const sql = mode === "unchanged" ? observeHostDataSql() : undefined;
          try {
            const operation = applySessionEntryLifecycleMutation({
              agentId: "main",
              storePath,
              activeSessionKey: target.sessionKey,
              skipMaintenance: true,
              source: mode === "missing-grant" ? undefined : grant.assertCurrent,
              upserts: [
                {
                  sessionKey: target.sessionKey,
                  initialContext: context,
                  buildEntry: () => {
                    // Projection runs after source preparation. Only the worker predicate can
                    // observe this access-fact drift; content/version and lifecycle stay valid.
                    if (mode === "visibility") {
                      replaceSessionEntrySync(source, { ...sourceEntry, visibility: "draft" });
                    }
                    return entry;
                  },
                },
              ],
            });
            if (mode === "visibility") {
              await expect(operation).rejects.toThrow("Transcript source read facts changed");
            } else if (mode === "different-grant") {
              await expect(operation).rejects.toThrow("matching prepared donor read authority");
            } else if (mode === "missing-grant") {
              await expect(operation).rejects.toThrow("requires retained source authority");
            } else {
              await expect(operation).resolves.toMatchObject({ afterCount: 2 });
              expect(sql?.queries).toEqual([]);
            }
          } finally {
            sql?.restore();
          }
          const persisted = await readSessionEntryReadOnlyInWorker(target);
          if (mode !== "unchanged") {
            expect(persisted).toBeUndefined();
            expect(await loadTranscriptEvents(target)).toEqual([]);
          } else {
            expect(persisted).toMatchObject({
              sessionId: target.sessionId,
              permissionMode: "workspace",
            });
            expect(JSON.stringify(await loadTranscriptEvents(target))).toContain(
              "Authorized completed knowledge.",
            );
          }
        } finally {
          grant.release();
        }
        expect(principal.release).toHaveBeenCalledOnce();
      });
    },
  );

  it("uses the real native report boundary with raw source identities and rejects a revoked cohort", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const reader = ensureProfileForEmail("report-reader@example.test");
      const storePath = state.statePath("transcript-read-report.sqlite");
      let cfg: OpenClawConfig = {
        ...rolePolicyConfig(),
        agents: { entries: { main: {} } },
        session: { store: storePath },
      };
      const source = {
        agentId: "main",
        sessionKey: "agent:main:knowledge",
        sessionId: "knowledge",
        storePath,
      };
      const target = { ...source, sessionKey: "agent:main:recipient", sessionId: "recipient" };
      for (const scope of [source, target]) {
        replaceSessionEntrySync(scope, {
          sessionId: scope.sessionId,
          lifecycleRevision: "first",
          updatedAt: 1,
          visibility: "shared",
          createdActor: {
            type: "human",
            source: "profile",
            id: scope === source ? "other-profile" : reader.id,
          },
        });
        await appendTranscriptMessage(scope, {
          message: { role: "user", content: "Synthetic completed source context." },
        });
      }
      const principal = operator(reader.id);
      const grant = await prepareTranscriptReadAuthority({
        ...principal,
        getRuntimeConfig: () => cfg,
        sources: [source, target],
      });
      try {
        const selectReport = vi.fn(() => ({
          customType: "synthetic-knowledge",
          content: "Authorized source knowledge.",
          display: false,
          details: { origin: "synthetic-source" },
        }));
        const report = {
          kind: "custom" as const,
          customTypes: ["synthetic-knowledge"],
          receipt: { field: "origin", value: "synthetic-source" },
          selectReport,
        };
        await expect(
          appendSessionTranscriptReport({ ...target, expectedLifecycleRevision: "first" }, report, {
            source: grant.assertCurrent,
          }),
        ).resolves.toEqual({ ok: true, value: undefined });
        expect(selectReport).toHaveBeenCalledOnce();
        expect(await loadTranscriptEvents(target)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "custom_message",
              customType: "synthetic-knowledge",
              content: "Authorized source knowledge.",
            }),
          ]),
        );
        cfg = {
          ...cfg,
          gateway: { ...cfg.gateway, roles: { ...cfg.gateway!.roles!, default: "none" } },
        };
        await expect(
          appendSessionTranscriptReport({ ...target, expectedLifecycleRevision: "first" }, report, {
            source: grant.assertCurrent,
          }),
        ).rejects.toThrow("Transcript source is no longer readable");
        expect(selectReport).toHaveBeenCalledOnce();
        expect(
          (await loadTranscriptEvents(target)).filter((event) => {
            if (!isRecord(event)) {
              throw new Error("Expected a native transcript event object");
            }
            return event.type === "custom_message";
          }),
        ).toHaveLength(1);
      } finally {
        grant.release();
      }
      expect(principal.release).toHaveBeenCalledOnce();
    });
  });

  it("shares native creator-alias/read policy with Gateway and revokes a mixed source cohort", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const reader = ensureProfileForEmail("reader@example.test");
      const old = ensureProfileForEmail("old-reader@example.test");
      linkEmail("old-reader@example.test", reader.id);
      const storePath = state.statePath("transcript-read.sqlite");
      let cfg: OpenClawConfig = {
        ...rolePolicyConfig(),
        agents: { entries: { main: {} } },
        session: { store: storePath },
      };
      const entries: SessionEntry[] = [
        {
          sessionId: "own",
          lifecycleRevision: "first",
          updatedAt: 1,
          visibility: "draft",
          createdActor: { type: "human", source: "profile", id: old.id },
        },
        {
          sessionId: "shared",
          lifecycleRevision: "first",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: "other-profile" },
        },
      ];
      const sources = entries.map((entry) => ({
        agentId: "main",
        sessionKey: `agent:main:${entry.sessionId}`,
      }));
      sources.forEach((source, index) =>
        replaceSessionEntrySync({ ...source, storePath }, entries[index]!),
      );
      const client = sharingPolicyClient({ user: reader.id, scopes: ["operator.read"] });
      const gatewayFilter = createSessionListEntryFilter(
        { cfg, client },
        (actor) =>
          actor?.type === "human" &&
          actor.source === "profile" &&
          (actor.id === reader.id || actor.id === old.id),
        { sessionCap: "view" },
      );
      expect(
        entries.map((entry, index) => gatewayFilter?.(sources[index]!.sessionKey, entry)),
      ).toEqual([true, true]);
      const principal = operator(reader.id);
      const grant = await prepareTranscriptReadAuthority({
        ...principal,
        getRuntimeConfig: () => cfg,
        sources,
      });
      try {
        expect(principal.retain).toHaveBeenCalledOnce();
        expect(grant.sources.map((source) => source.sessionId)).toEqual(["own", "shared"]);
        expect(grant.sources.every((source) => source.readSource.path === storePath)).toBe(true);
        const prepared = await prepareSessionSourceAuthority(grant.assertCurrent);
        try {
          expect(prepared.checks.map((check) => check.predicate.sessionKey)).toEqual(
            sources.map((source) => source.sessionKey),
          );
          expect(prepared.hasOpaqueCheck).not.toBe(true);
          expect(() => prepared.assertPreparedCurrent?.()).not.toThrow();
          expect(() => prepared.assertCurrent()).not.toThrow();
        } finally {
          await prepared.release?.();
        }
        cfg = {
          ...cfg,
          gateway: { ...cfg.gateway, roles: { ...cfg.gateway!.roles!, default: "none" } },
        };
        expect(() => grant.assertCurrent()).toThrow("Transcript source is no longer readable");
        cfg = { ...cfg, gateway: rolePolicyConfig().gateway };
        expect(() => grant.assertCurrent()).toThrow("Transcript source is no longer readable");
      } finally {
        grant.release();
      }
      expect(principal.release).toHaveBeenCalledOnce();
      expect(() => grant.assertCurrent()).toThrow();
    });
  });

  it("never adopts a replaced source and observes abort and explicit release", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const reader = ensureProfileForEmail("reader@example.test");
      const storePath = state.statePath("transcript-read-replaced.sqlite");
      const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
      const source = { agentId: "main", sessionKey: "agent:main:source" };
      const entry = { sessionId: "original", lifecycleRevision: "first", updatedAt: 1 };
      replaceSessionEntrySync({ ...source, storePath }, entry);
      const abort = new AbortController();
      const principal = operator(reader.id, { signal: abort.signal });
      const grant = await prepareTranscriptReadAuthority({
        ...principal,
        getRuntimeConfig: () => cfg,
        sources: [source],
      });
      try {
        replaceSessionEntrySync(
          { ...source, storePath },
          { ...entry, sessionId: "replacement", lifecycleRevision: "second" },
        );
        expect(() => grant.assertCurrent()).toThrow();
        expect(grant.sources[0]?.sessionId).toBe("original");
      } finally {
        grant.release();
      }
      const next = await prepareTranscriptReadAuthority({
        ...principal,
        getRuntimeConfig: () => cfg,
        sources: [source],
      });
      abort.abort(new Error("reader disconnected"));
      try {
        expect(() => next.assertCurrent()).toThrow("reader disconnected");
      } finally {
        next.release();
      }
      expect(principal.release).toHaveBeenCalledTimes(2);
      const profileBound = operator(reader.id);
      const retained = await prepareTranscriptReadAuthority({
        ...profileBound,
        getRuntimeConfig: () => cfg,
        sources: [source],
      });
      try {
        const merged = ensureProfileForEmail("merged-reader@example.test");
        linkEmail("reader@example.test", merged.id);
        expect(() => retained.assertCurrent()).toThrow();
      } finally {
        retained.release();
      }
      expect(profileBound.release).toHaveBeenCalledOnce();
    });
  });

  it("rejects missing history scope, partial unreadable cohorts, and oversized selections", async () => {
    await expect(
      prepareTranscriptReadAuthority({
        authority: {
          profileId: "unissued-profile",
          scopes: ["operator.read"],
          assertCurrent: () => {},
        },
        getRuntimeConfig: () => ({}),
        sources: [{ agentId: "main", sessionKey: "agent:main:source" }],
      }),
    ).rejects.toThrow("issued by the host");
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const reader = ensureProfileForEmail("reader@example.test");
      const storePath = state.statePath("transcript-read-denied.sqlite");
      const cfg = {
        ...rolePolicyConfig(),
        agents: { entries: { main: {} } },
        session: { store: storePath },
      };
      const sources = ["shared", "draft"].map((name) => ({
        agentId: "main",
        sessionKey: `agent:main:${name}`,
      }));
      sources.forEach((source, index) =>
        replaceSessionEntrySync(
          { ...source, storePath },
          {
            sessionId: source.sessionKey,
            updatedAt: 1,
            visibility: index ? "draft" : "shared",
            createdActor: { type: "human", source: "profile", id: "other-profile" },
          },
        ),
      );
      const talkOnly = operator(reader.id, { scopes: ["operator.talk"] });
      await expect(
        prepareTranscriptReadAuthority({ ...talkOnly, getRuntimeConfig: () => cfg, sources }),
      ).rejects.toThrow("lacks history scope");
      expect(talkOnly.release).toHaveBeenCalledOnce();
      const principal = operator(reader.id);
      await expect(
        prepareTranscriptReadAuthority({ ...principal, getRuntimeConfig: () => cfg, sources }),
      ).rejects.toThrow("no longer readable");
      expect(principal.release).toHaveBeenCalledOnce();
      await expect(
        prepareTranscriptReadAuthority({
          ...principal,
          getRuntimeConfig: () => cfg,
          sources: Array.from({ length: MAX_SESSION_ROW_FACTS_KEYS + 1 }, () => sources[0]!),
        }),
      ).rejects.toThrow(`1 to ${MAX_SESSION_ROW_FACTS_KEYS}`);
      await expect(
        prepareTranscriptReadAuthority({
          ...principal,
          getRuntimeConfig: () => cfg,
          sources: [{ agentId: "main", sessionKey: "agent:main:dashboard:incognito-selected" }],
        }),
      ).rejects.toThrow("requires durable sessions");
      expect(principal.retain).toHaveBeenCalledOnce();
    });
  });
});
