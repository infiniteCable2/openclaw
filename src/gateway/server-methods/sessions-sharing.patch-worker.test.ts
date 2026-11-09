import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { deleteSessionEntryRows } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as entryPatch from "../../config/sessions/session-entry-patch.js";
import { readSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as lifecycle from "../../sessions/session-controller.lifecycle.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import { identifiedClient, sessionSharingTestContext } from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

type PatchAction = "visibility" | "publicShare";

function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, async () => run(await fixture()));
}

async function fixture(
  conversationTopology?: InternalSessionEntry["conversationTopology"],
  retainedPublicShare = false,
) {
  await captureRuntimeConfigAsyncReader()();
  const sessionId = `sharing-patch-worker${conversationTopology ? `-${conversationTopology.role}` : ""}`;
  const scope = { agentId: "main", sessionKey: `agent:main:${sessionId}` };
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: 1,
    ...(conversationTopology?.role === "root"
      ? {
          createdVia: "internal" as const,
          createdActor: { type: "system" as const, id: "conversation-root" },
          lifecycleRevision: "root-lifecycle",
          visibility: "draft" as const,
          delivery: { kind: "none" as const },
        }
      : { createdActor: { type: "human" as const, source: "profile" as const, id: "owner" } }),
    ...(conversationTopology ? { conversationTopology } : {}),
    ...(retainedPublicShare
      ? { publicShare: { id: "c".repeat(48), sessionId, createdAt: 1 } }
      : {}),
  });
  await closeOpenClawAgentDatabasesAsync();
  const client = identifiedClient("owner");
  if (conversationTopology?.role === "root") {
    client.connect.scopes = ["operator.admin"];
  }
  const context = sessionSharingTestContext(vi.fn());
  await initializeSessionReadContext(context);
  return {
    scope,
    sessionId,
    client,
    context,
    async call(
      action: PatchAction,
      patch: Record<string, unknown> = action === "visibility"
        ? { visibility: "draft" }
        : { enabled: true },
      respond = vi.fn<RespondFn>(),
    ) {
      const method = `session.${action}.set` as const;
      const params = {
        ...scope,
        ...(method === "session.publicShare.set" ? { expectedSessionId: sessionId } : {}),
        ...patch,
      };
      await getSessionRowProjection(context)!.prepareSelection();
      const { authorization, error } = resolveSessionMutationAuthorization({
        client,
        context,
        method,
        requestParams: params,
      });
      expect(error).toBeNull();
      await sessionSharingHandlers[method]!({
        req: { type: "req", id: "sharing-patch", method, params },
        params,
        client,
        context,
        isWebchatConnect: () => true,
        sessionMutationAuthorization: authorization,
        respond,
      });
      return respond;
    },
  };
}

it("keeps consolidating roots draft at the native writer without limiting ordinary branches", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const root = await fixture({ version: 1, role: "root" });
    const before = await readSessionMembersInWorker(root.scope);
    for (const visibility of ["shared", "read-only", "suggest"]) {
      const respond = vi.fn<RespondFn>();
      await expect(root.call("visibility", { visibility }, respond)).rejects.toThrow(
        "A consolidating conversation root must remain draft.",
      );
      expect(respond).not.toHaveBeenCalled();
      expect(await readSessionMembersInWorker(root.scope)).toEqual(before);
    }
    expect(root.context.broadcast).not.toHaveBeenCalled();
    const unchanged = await root.call("visibility", { visibility: "draft" });
    expect(unchanged).toHaveBeenCalledWith(
      true,
      { ok: true, sessionKey: root.scope.sessionKey, visibility: "draft" },
      undefined,
    );
    expect(await readSessionMembersInWorker(root.scope)).toEqual(before);
    expect(root.context.broadcast).not.toHaveBeenCalled();

    const branch = await fixture({
      version: 1,
      role: "branch",
      rootSessionKey: root.scope.sessionKey,
      rootSessionId: root.sessionId,
      rootSessionLifecycleRevision: "root-lifecycle",
    });
    const response = await branch.call("visibility", { visibility: "read-only" });
    expect(response).toHaveBeenCalledWith(
      true,
      { ok: true, sessionKey: branch.scope.sessionKey, visibility: "read-only" },
      undefined,
    );
    expect((await readSessionMembersInWorker(branch.scope)).entry).toMatchObject({
      visibility: "read-only",
      conversationTopology: { role: "branch" },
    });
  });
});

it("revokes a retained root publication through the authorized native patch owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const root = await fixture({ version: 1, role: "root" }, true);
    const before = await readSessionMembersInWorker(root.scope);
    expect(before.entry?.publicShare?.id).toBe("c".repeat(48));
    await expect(root.call("publicShare", { enabled: true })).rejects.toThrow(
      "root cannot be published",
    );
    expect(await readSessionMembersInWorker(root.scope)).toEqual(before);
    const response = await root.call("publicShare", { enabled: false });
    expect(response).toHaveBeenCalledWith(
      true,
      { ok: true, sessionKey: root.scope.sessionKey },
      undefined,
    );
    const cleared = await readSessionMembersInWorker(root.scope);
    expect(cleared.entry).not.toHaveProperty("publicShare");
    expect(cleared.entry).toMatchObject({
      sessionId: root.sessionId,
      visibility: "draft",
      conversationTopology: { version: 1, role: "root" },
    });
  });
});

it("publishes sharing changes without caller-thread SQLite", () =>
  withFixture(async (f) => {
    const sql = observeMainThreadSql();
    try {
      for (const visibility of ["draft", "shared"]) {
        const response = await f.call("visibility", { visibility });
        const expected = { ok: true, sessionKey: f.scope.sessionKey, visibility };
        expect(response).toHaveBeenCalledWith(true, expected, undefined);
        expect((await readSessionMembersInWorker(f.scope)).entry?.visibility).toBe(visibility);
      }
      for (const enabled of [true, true, false]) {
        const response = await f.call("publicShare", { enabled });
        expect(response.mock.calls[0]?.[0]).toBe(true);
        const stored = (await readSessionMembersInWorker(f.scope)).entry?.publicShare;
        expect(stored).toEqual(
          enabled
            ? expect.objectContaining({ sessionId: f.sessionId, id: expect.any(String) })
            : undefined,
        );
      }
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  }));

it.each([
  ["visibility", "caller"],
  ["visibility", "policy"],
  ["publicShare", "caller"],
] as const)(
  "rolls back session.%s.set when %s authority is revoked at the worker commit grant",
  (action, revoked) =>
    withFixture(async (f) => {
      const before = await readSessionMembersInWorker(f.scope);
      let reachedCommit = false;
      sqliteWorkerOwnerProbe.admission(admission, (request, grant, admit) => {
        if (
          request.stage === "commit" &&
          isRecord(request.facts) &&
          isRecord(request.facts.publication) &&
          request.facts.publication.kind === "session-entry-patch-committed"
        ) {
          reachedCommit = true;
          if (revoked === "caller") {
            f.client.invalidated = true;
          } else {
            f.context.getRuntimeConfig().session = { sharing: { drafts: false } };
          }
        }
        admit(request, grant);
      });
      await expect(f.call(action)).rejects.toThrow();
      expect(reachedCommit).toBe(true);
      expect(await readSessionMembersInWorker(f.scope)).toEqual(before);
      expect(f.context.broadcast).not.toHaveBeenCalled();
    }),
);

it.each(["caller", "revoked grant", "deleted row", "replaced generation"] as const)(
  "withholds a committed public-share token if %s authority is revoked during lifecycle cleanup",
  (revoked) =>
    withFixture(async (f) => {
      await readSessionMembersInWorker(f.scope);
      const run = lifecycle.runSessionMutation;
      let acknowledgedShareId: string | undefined;
      vi.spyOn(lifecycle, "runSessionMutation").mockImplementationOnce(async (params) => {
        const result = await run(params);
        const committed = (await readSessionMembersInWorker(f.scope)).entry?.publicShare;
        expect(committed?.sessionId).toBe(f.sessionId);
        acknowledgedShareId = committed?.id;
        if (revoked === "caller") {
          f.client.invalidated = true;
        } else if (revoked === "deleted row") {
          runOpenClawAgentWriteTransaction(
            (database) => deleteSessionEntryRows(database, f.scope.sessionKey),
            f.scope,
          );
        } else {
          await upsertSessionEntryCore(
            f.scope,
            revoked === "revoked grant"
              ? { publicShare: undefined }
              : { sessionId: "replacement-session" },
          );
        }
        return result;
      });
      const respond = vi.fn<RespondFn>();
      const refusal = {
        caller: "session ownership changed before sharing mutation",
        "revoked grant": "session publication changed before sharing response",
        "deleted row": "Session access facts are unavailable",
        "replaced generation": "Session access facts are unavailable",
      }[revoked];
      await expect(f.call("publicShare", undefined, respond)).rejects.toThrow(refusal);
      expect(acknowledgedShareId).toEqual(expect.any(String));
      expect(respond).not.toHaveBeenCalled();
      const entry = loadSessionEntry(f.scope);
      if (revoked === "deleted row") {
        expect(entry).toBeUndefined();
      } else if (revoked === "revoked grant") {
        expect(entry).toMatchObject({ sessionId: f.sessionId });
        expect(entry).not.toHaveProperty("publicShare");
      } else if (revoked === "replaced generation") {
        expect(entry).toMatchObject({ sessionId: "replacement-session" });
      } else {
        expect(entry).toMatchObject({
          publicShare: { id: acknowledgedShareId, sessionId: f.sessionId },
        });
      }
    }),
);

it.each(["visibility", "publicShare"] as const)(
  "refuses session.%s.set after a session reset between preparation and commit",
  (action) =>
    withFixture(async (f) => {
      const patch = entryPatch.patchSessionEntryInWorker;
      vi.spyOn(entryPatch, "patchSessionEntryInWorker").mockImplementation((params) =>
        patch({
          ...params,
          async prepare(snapshot) {
            const prepared = await params.prepare(snapshot);
            const replacement = { ...loadSessionEntry(f.scope)!, sessionId: "replacement-session" };
            replaceSessionEntrySync(f.scope, replacement);
            return prepared;
          },
        }),
      );
      await expect(f.call(action)).rejects.toThrow();
      const entry = loadSessionEntry(f.scope);
      expect(entry).toMatchObject({
        sessionId: "replacement-session",
        createdActor: { id: "owner" },
      });
      expect(entry).not.toHaveProperty("visibility");
      expect(entry).not.toHaveProperty("publicShare");
      expect(f.context.broadcast).not.toHaveBeenCalled();
    }),
);
