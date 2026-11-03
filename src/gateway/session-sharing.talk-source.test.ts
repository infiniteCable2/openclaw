import "../config/sessions/session-entry-patch-delivery.test-support.js";
import { isMainThread } from "node:worker_threads";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { readPreparedSessionSharingChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import {
  applySessionEntryOperation,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { releaseSessionSourceAuthorities } from "../config/sessions/session-source-authority.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import {
  readConversationPrivateAudience,
  retainConversationPrivateAudience,
} from "../sessions/conversation-private-audience.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  prepareConversationReplyContext,
} from "../talk/conversation-input-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { OperatorScope } from "./operator-scopes.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-preparation.js";
import { createGatewayTalkConversationInputSource } from "./talk/conversation-input-source.js";
import { createTalkOperatorRunSource } from "./talk/operator-run-source.js";

const { getSessionEntryPatchDelivery } =
  await import("../config/sessions/session-entry-patch-delivery.test-support.js");
const delivery = getSessionEntryPatchDelivery();

it("retains the real Talk principal after normal input release and still observes profile revocation", async () => {
  expect(isMainThread).toBe(true);
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const profile = ensureProfileForEmail("retained-talk-principal@example.test");
    const storePath = state.statePath("retained-talk-principal.sqlite");
    const scopes: OperatorScope[] = ["operator.read", "operator.write"];
    const cfg = {
      agents: { entries: { main: {} } },
      session: { store: storePath },
      gateway: {
        roles: {
          default: "speaker",
          definitions: {
            speaker: { scopes, agents: ["main"], sessions: { others: "none" as const } },
            blocked: { scopes: [], agents: [], sessions: { others: "none" as const } },
          },
        },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const target = { agentId: "main", sessionKey: "agent:main:retained-talk", storePath };
    replaceSessionEntrySync(target, {
      sessionId: "original-conversation",
      lifecycleRevision: "original-generation",
      updatedAt: 1,
      chatType: "direct",
      visibility: "draft",
      createdActor: { type: "human", source: "profile", id: profile.id },
    });
    const context = createContext();
    context.getRuntimeConfig = () => cfg;
    const client = createOperatorClient({ profileId: profile.id, scopes });
    const source = createGatewayTalkConversationInputSource({
      target: { ...target, canonicalKey: target.sessionKey },
      conversationId: "original-connection",
      getRuntimeConfig: () => cfg,
      // The actual Talk adapter calls the real native operator-capture owner;
      // neither its profile preparation nor its retain/revocation logic is mocked.
      captureOperatorAuthority: createTalkOperatorRunSource({ client, context }),
      authority: { senderIsOwner: false },
      participant: { type: "profile", id: profile.id },
      assertInputCurrent() {},
      resolveGatewayContext: () => context,
    });
    const cleanup: Array<{ release(): void }> = [];
    const admit = async (inputId: string) => {
      const scope = {
        agentId: "main",
        conversationId: "original-connection",
        inputId,
        purpose: "user" as const,
      };
      const input = consumeConversationInputAdmission(await source.admitInput(scope), scope);
      cleanup.push({ release: () => input.release?.() });
      claimConversationInputExecution(input);
      const replyContext = await prepareConversationReplyContext(input, {
        text: "An admitted input.",
      });
      const audience = readConversationPrivateAudience(replyContext);
      if (!audience) {
        throw new Error("The original personal Talk input has no native private audience");
      }
      const retained = retainConversationPrivateAudience(audience);
      cleanup.push(...retained);
      return { input, retained };
    };
    try {
      const completed = await admit("completed-input");
      const active = await admit("independent-active-input");
      completed.input.release?.();
      let normalReleaseFailure: unknown;
      try {
        for (const held of completed.retained) {
          held.audience.assertCurrent();
        }
      } catch (error) {
        normalReleaseFailure = error;
      }
      // An independent still-live input distinguishes actual profile revocation
      // from the first principal's accidentally latched input-release failure.
      for (const held of active.retained) {
        expect(() => held.audience.assertCurrent()).not.toThrow();
      }
      setUserProfileRole(profile.id, "blocked");
      for (const held of active.retained) {
        expect(held.signal?.aborted).toBe(true);
        expect(() => held.audience.assertCurrent()).toThrow();
      }
      expect(normalReleaseFailure).toBeUndefined();
    } finally {
      await releaseSessionSourceAuthorities(cleanup);
    }
  });
});

it.for(["continuous", "reset"] as const)(
  "keeps a native admitted Talk source current across COMMIT and participant publication: %s",
  async (intervention, { signal }) => {
    expect(isMainThread).toBe(true);
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("talk-source-sharing.sqlite");
      const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const target = { agentId: "main", sessionKey: "agent:main:talk-source", storePath };
      const entry = {
        sessionId: "spoken-conversation",
        lifecycleRevision: "spoken-generation",
        activeWriterRunId: "previous-writer",
        updatedAt: 1,
        chatType: "direct" as const,
        visibility: "draft" as const,
        createdActor: { type: "human" as const, source: "profile" as const, id: "speaker" },
      };
      replaceSessionEntrySync(target, entry);
      const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      const gateway = createDirectChatContext({ getRuntimeConfig: () => cfg });
      let sourceReleased = false;
      const source = createGatewayTalkConversationInputSource({
        target: { ...target, canonicalKey: target.sessionKey },
        conversationId: "connected-audio",
        getRuntimeConfig: () => cfg,
        // Only the original operator issuer is controlled here. Native session
        // admission, retained sharing reads and writer publication are not mocked.
        captureOperatorAuthority: async (invocation) => ({
          authority: createAdmittedRunOperatorAuthority({
            profileId: "speaker",
            scopes: ["operator.read", "operator.write", "operator.talk"],
            gatewayAccessGrant: null,
            rolePolicy: { sessionAccessCap: "none", sandboxRequired: false, agents: ["main"] },
            assertCurrent() {
              invocation.assertCurrent();
              if (sourceReleased) {
                throw new Error("Original Talk operator released");
              }
            },
          }),
          release() {
            sourceReleased = true;
          },
        }),
        authority: { senderIsOwner: false },
        participant: { type: "profile", id: "speaker" },
        assertInputCurrent() {},
        resolveGatewayContext: () => gateway,
      });
      const scope = {
        agentId: "main",
        conversationId: "connected-audio",
        inputId: "spoken-input",
        purpose: "user" as const,
      };
      const input = consumeConversationInputAdmission(await source.admitInput(scope), scope);
      const publications: Array<{
        key: string;
        storePath: string | undefined;
        scope: string | undefined;
        kind: string | undefined;
        invalidated: true | "category" | undefined;
        sharing: "changed" | "unchanged" | undefined;
      }> = [];
      const stop = sessionChanges.subscribeFacts((change) => {
        if ("sessionKey" in change && change.sessionKey === target.sessionKey) {
          publications.push({
            key: change.sessionKey,
            storePath: change.storePath,
            scope: typeof change.scope === "string" ? change.scope : undefined,
            kind: change.facts?.kind,
            invalidated: change.factsInvalidated,
            sharing: readPreparedSessionSharingChange(change),
          });
        }
      });
      const sourceOutcomeWithoutSql = () => {
        const sql = observeHostDataSql();
        let failure: unknown;
        try {
          try {
            input.assertCurrent();
          } catch (error) {
            failure = error;
          }
          for (const call of sql.calls) {
            expect(call).not.toHaveBeenCalled();
          }
          return failure;
        } finally {
          sql.restore();
        }
      };
      const assertWithoutSql = () =>
        expect(sourceOutcomeWithoutSql(), JSON.stringify(publications)).toBeUndefined();
      const committed = createDeferredCore();
      const releaseDelivery = createDeferredCore();
      let held = false;
      let pendingError: unknown;
      let commitGrants = 0;
      const probe = sqliteWorkerOwnerProbe.admission(admission, (request, grant, admit) => {
        if (request.stage !== "commit") {
          admit(request, grant);
          return;
        }
        admit(request, (beforeRelease) => {
          commitGrants++;
          try {
            input.assertCurrent();
          } catch (error) {
            pendingError = error;
          }
          return grant(beforeRelease);
        });
      });
      delivery.afterCommit = async (result) => {
        expect(result).toMatchObject({ kind: "session-entry-patch-committed" });
        held = true;
        committed.resolve();
        await releaseDelivery.promise;
      };
      let mutation: Promise<unknown> | undefined;
      try {
        claimConversationInputExecution(input);
        const context = await prepareConversationReplyContext(input, { text: "An actual input." });
        expect(context.SessionKey).toBe(target.sessionKey);
        assertWithoutSql();
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
          if (!held) {
            throw new Error(
              `Native Talk patch missed delivery: ${JSON.stringify(delivery.commands)}`,
            );
          }
          return result;
        });
        void mutation.catch(() => {});
        await withinTest(
          awaitGateBeforeSettlement(
            committed.promise,
            mutation,
            "Talk patch settled before COMMIT gate",
          ),
          signal,
        );
        expect(commitGrants).toBe(1);
        expect(pendingError).toBeInstanceOf(SessionMutationFactsUnavailableError);
        // Sample the retained claim before an observational row read can publish facts.
        const acknowledgedFailure = sourceOutcomeWithoutSql();
        expect(readExactSessionEntryRow(database, target.sessionKey)?.entry).toMatchObject({
          sessionId: entry.sessionId,
          activeWriterRunId: "next-writer",
        });
        expect(acknowledgedFailure, JSON.stringify(publications)).toBeUndefined();
        expect(
          recordSessionParticipant(target, {
            identity: { type: "profile", id: "speaker" },
            promptedAt: 2,
            expectedSession: entry,
          }),
        ).toBe("inserted");
        assertWithoutSql();
        if (intervention === "reset") {
          replaceSessionEntrySync(target, {
            ...entry,
            sessionId: "replacement-conversation",
            lifecycleRevision: "replacement-generation",
          });
          expect(() => input.assertCurrent()).toThrow();
        }
        releaseDelivery.resolve();
        await withinTest(mutation, signal);
        const fresh = await prepareSessionMutationFacts({
          cfg,
          ...target,
          preserveQualifiedAddress: true,
        });
        try {
          const freshTarget = fresh.readCurrent(cfg).target;
          if (!freshTarget) {
            throw new Error("The committed Talk source is absent from fresh native facts");
          }
          if (intervention === "continuous") {
            assertWithoutSql();
            expect(freshTarget.entry).toMatchObject({
              sessionId: entry.sessionId,
              activeWriterRunId: "next-writer",
              participantCount: 1,
            });
          } else {
            expect(() => input.assertCurrent()).toThrow();
            expect(freshTarget.entry.sessionId).toBe("replacement-conversation");
          }
        } finally {
          fresh.release();
        }
        expect(publications.some((change) => change.kind === "participants")).toBe(true);
      } finally {
        releaseDelivery.resolve();
        try {
          await mutation;
        } finally {
          delivery.afterCommit = undefined;
          probe.mockRestore();
          stop();
          input.release?.();
        }
      }
      expect(sourceReleased).toBe(true);
    });
  },
);
