import "../config/sessions/session-entry-patch-delivery.test-support.js";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import {
  applySessionEntryOperation,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { authorizePreparedSessionMutation } from "./session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-preparation.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

const { getSessionEntryPatchDelivery } =
  await import("../config/sessions/session-entry-patch-delivery.test-support.js");
const delivery = getSessionEntryPatchDelivery();

it.for(["continuous", "membership-revoked", "reset"] as const)(
  "keeps acknowledged writer-claim facts current before patch delivery without reviving %s authority",
  async (intervention, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("patch-commit-sharing.sqlite");
      const cfg = {
        ...rolePolicyConfig(),
        agents: { entries: { main: {} } },
        session: { store: storePath },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const target = { agentId: "main", sessionKey: "agent:main:patch-commit", storePath };
      const entry = {
        sessionId: "patch-conversation",
        lifecycleRevision: "same-generation",
        activeWriterRunId: "previous-writer",
        updatedAt: 1,
        visibility: "read-only" as const,
        createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
      };
      replaceSessionEntrySync(target, entry);
      addSessionMember(target, { identityId: "reader", addedBy: "owner", addedAt: 1 });
      const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      const facts = await prepareSessionMutationFacts({ cfg, ...target });
      const client = sharingPolicyClient({ user: "reader" });
      const policy = cfg.gateway?.roles?.definitions?.view;
      if (!policy) {
        throw new Error("The synthetic sharing policy is missing");
      }
      const authorized = () => {
        try {
          return (
            authorizePreparedSessionMutation(
              { cfg, client, sessionKey: target.sessionKey, agentId: target.agentId },
              facts.readCurrent(cfg),
              { policy, aliases: new Set(["reader"]) },
            ) === null
          );
        } catch (error) {
          expect(error).toBeInstanceOf(SessionMutationFactsUnavailableError);
          return false;
        }
      };
      const committed = createDeferredCore();
      const releaseDelivery = createDeferredCore();
      let deliveryHeld = false;
      let beforeCommit: unknown;
      let commitGrants = 0;
      const probe = sqliteWorkerOwnerProbe.admission(admission, (request, grant, admit) => {
        if (request.stage !== "commit") {
          admit(request, grant);
          return;
        }
        admit(request, (beforeRelease) => {
          commitGrants++;
          // The native owner has begun publication custody, but the real grant
          // has not released SQL yet. Withholding changed facts here is correct.
          try {
            beforeCommit = facts.readCurrent(cfg);
          } catch (error) {
            beforeCommit = error;
          }
          return grant(beforeRelease);
        });
      });
      delivery.afterCommit = async (result) => {
        // The real executor and SQL have completed. Delay only ordinary result
        // adoption, independently of the admission owner's native COMMIT receipt.
        expect(result).toMatchObject({ kind: "session-entry-patch-committed" });
        deliveryHeld = true;
        committed.resolve();
        await releaseDelivery.promise;
      };
      let mutation: Promise<unknown> | undefined;
      try {
        expect(authorized()).toBe(true);
        mutation = applySessionEntryOperation(
          target,
          {
            kind: "fields",
            expected: {
              sessionId: entry.sessionId,
              lifecycleRevision: entry.lifecycleRevision,
            },
            patch: { activeWriterRunId: "next-writer" },
          },
          { skipMaintenance: true },
        ).then((result) => {
          if (!deliveryHeld) {
            throw new Error(
              `Patch did not reach native delivery: ${JSON.stringify({
                commands: delivery.commands,
                commitGrants,
                result,
                stored: readExactSessionEntryRow(database, target.sessionKey)?.entry,
              })}`,
            );
          }
          return result;
        });
        void mutation.catch(() => {});
        await withinTest(
          awaitGateBeforeSettlement(
            committed.promise,
            mutation,
            "Writer claim settled before its delayed COMMIT delivery",
          ),
          signal,
        );
        expect(commitGrants).toBe(1);
        expect(beforeCommit).toBeInstanceOf(SessionMutationFactsUnavailableError);
        let acknowledgedFacts: unknown;
        try {
          acknowledgedFacts = facts.readCurrent(cfg);
        } catch (error) {
          acknowledgedFacts = error;
        }
        // A real native row read proves COMMIT independently of cache adoption.
        expect(readExactSessionEntryRow(database, target.sessionKey)?.entry).toMatchObject({
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          activeWriterRunId: "next-writer",
        });
        expect(acknowledgedFacts).toMatchObject({
          target: {
            entry: {
              sessionId: entry.sessionId,
              lifecycleRevision: entry.lifecycleRevision,
              activeWriterRunId: "next-writer",
            },
          },
        });
        if (intervention === "continuous") {
          expect(authorized()).toBe(true);
        } else if (intervention === "membership-revoked") {
          // Exercise the native synchronous sharing contract while the worker's
          // acknowledged result is withheld; a later receipt must not undo it.
          expect(removeSessionMember(target, "reader")).not.toBeNull();
          expect(authorized()).toBe(false);
        } else {
          replaceSessionEntrySync(target, {
            ...entry,
            sessionId: "replacement-conversation",
            lifecycleRevision: "replacement-generation",
          });
          expect(() => facts.readCurrent(cfg)).toThrow(SessionMutationFactsUnavailableError);
        }
        releaseDelivery.resolve();
        await withinTest(mutation, signal);
        if (intervention === "continuous") {
          expect(facts.readCurrent(cfg).target?.entry.activeWriterRunId).toBe("next-writer");
          expect(authorized()).toBe(true);
        } else if (intervention === "membership-revoked") {
          expect(authorized()).toBe(false);
          const fresh = await prepareSessionMutationFacts({ cfg, ...target });
          try {
            expect(fresh.readCurrent(cfg).membership.has("reader")).toBe(false);
          } finally {
            fresh.release();
          }
        } else {
          expect(() => facts.readCurrent(cfg)).toThrow(SessionMutationFactsUnavailableError);
          expect(readExactSessionEntryRow(database, target.sessionKey)?.entry).toMatchObject({
            sessionId: "replacement-conversation",
            lifecycleRevision: "replacement-generation",
          });
        }
      } finally {
        releaseDelivery.resolve();
        try {
          await mutation;
        } finally {
          delivery.afterCommit = undefined;
          probe.mockRestore();
          facts.release();
        }
      }
    });
  },
);
