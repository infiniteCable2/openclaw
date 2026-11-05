import "../../test-utils/prepare-compiled-subprocesses.js";
import { describe, expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { OperatorRunRecoverySnapshot } from "../../gateway/operator-run-recovery-source.js";
import { captureGatewayPrivateConversationAudience } from "../../gateway/session-input-participant.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  clearGenerationPrivateFieldsForRotatedSessionPatch,
  generationValidPrivateFieldsForSameSession,
} from "../../plugin-sdk/session-store-runtime-internal.js";
import {
  collectConversationPrivateAudiences,
  retainConversationPrivateAudience,
} from "../../sessions/conversation-private-audience.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import {
  captureConversationRecipientEnrollment,
  retainConversationRecipientEnrollment,
} from "./conversation-recipient-enrollment.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import {
  projectSessionSharingEntry,
  sessionSharingEntriesEqual,
} from "./session-accessor.sqlite-entry-cache.types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  projectPublicSessionEntry,
  projectPublicSessionEntryPatch,
} from "./session-entry-projection.js";
import type { InternalSessionEntry } from "./types.js";

const snapshot: OperatorRunRecoverySnapshot = {
  profileId: "example-person",
  scopes: ["operator.read", "operator.talk"],
  assignedRole: null,
  githubLogin: null,
  grant: null,
  aliasBindingIds: [],
  authPolicy: {
    generation: "",
    grantGeneration: "example-auth-generation",
    role: "operator",
    authMethod: "token",
  },
  controlUiAdmin: false,
  localOperator: false,
  sourceIngress: "internal",
};

function audience(check: () => void = () => {}, captured = true) {
  return captureGatewayPrivateConversationAudience({
    agentId: "main",
    sessionKey: "agent:main:private-endpoint",
    participant: { type: "profile", id: snapshot.profileId },
    operatorAuthority: createAdmittedRunOperatorAuthority({
      profileId: snapshot.profileId,
      scopes: snapshot.scopes,
      recoverySnapshot: captured
        ? {
            ...snapshot,
            modelPolicy: {
              models: [{ provider: "example", model: "execution-only" }],
              allowed: { exact: [], wildcards: [] },
              denied: { exact: [], wildcards: [] },
            },
          }
        : undefined,
      assertCurrent: check,
      retain: () => () => {},
    }),
    entry: { chatType: "direct" },
    assertCurrent: check,
  })!;
}

function fixture() {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const branch: ConversationKnowledgeBranch = {
    agentId: "main",
    sessionKey: "agent:main:private-endpoint",
    sessionId: "example-recipient",
    lifecycleRevision: "example-recipient-lifecycle",
    storePath: database.path,
    root: {
      sessionKey: "agent:main:main",
      sessionId: "example-root",
      lifecycleRevision: "example-root-lifecycle",
    },
  };
  const entry: InternalSessionEntry = {
    sessionId: branch.sessionId,
    lifecycleRevision: branch.lifecycleRevision,
    updatedAt: 1,
    visibility: "draft",
    chatType: "direct",
    status: "done",
    endedAt: 1,
    conversationTopology: {
      version: 1,
      role: "branch",
      rootSessionKey: branch.root.sessionKey,
      rootSessionId: branch.root.sessionId,
      rootSessionLifecycleRevision: branch.root.lifecycleRevision,
    },
  };
  const scope = { ...branch, env: process.env };
  replaceSessionEntrySync(scope, entry);
  replaceSessionEntrySync(
    { ...scope, sessionKey: branch.root.sessionKey },
    {
      sessionId: branch.root.sessionId,
      lifecycleRevision: branch.root.lifecycleRevision,
      updatedAt: 1,
      conversationTopology: { version: 1, role: "root" },
    },
  );
  return { database, branch, scope, entry };
}

describe("durable reusable recipient enrollment", () => {
  it("preserves the original native source through retention and rejects source-less backfill", () => {
    const original = audience();
    const collected = collectConversationPrivateAudiences([original, original])!;
    expect(collected.restartSource).toEqual({ kind: "operator", snapshot });
    const leases = retainConversationPrivateAudience(collected);
    try {
      expect(leases[0]?.audience.restartSource).toEqual(original.restartSource);
      expect(audience(() => {}, false).restartSource).toBeUndefined();
      const mixed = collectConversationPrivateAudiences([original, audience(() => {}, false)]);
      expect(mixed?.restartSource).toBeUndefined();
    } finally {
      for (const lease of leases) {
        lease.release();
      }
    }
  });

  it("writes once through native worker custody without treating a finished run as endpoint retirement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const held = await loadSessionEntryForAdmission(f.scope, { assertCurrent() {} });
      try {
        if (
          !("kind" in held.databaseClaim) ||
          held.databaseClaim.kind !== "worker" ||
          !held.databaseClaim.reader
        ) {
          throw new Error("Expected the native worker cohort");
        }
        const params = {
          reader: held.databaseClaim.reader,
          branch: f.branch,
          audience: audience(),
          assertCurrent() {},
        };
        await retainConversationRecipientEnrollment(params);
        const first = readExactSessionEntryRow(f.database, f.scope.sessionKey)?.entry;
        expect(first?.conversationRecipientEnrollment).toEqual({
          version: 1,
          lifetime: "reusable",
          branch: f.branch,
          source: { kind: "operator", snapshot },
        });
        expect(first?.updatedAt).toBe(1);
        expect(first?.status).toBe("done");
        const retained = projectSessionSharingEntry(first!);
        expect(retained.conversationRecipientEnrollment).toEqual(
          first?.conversationRecipientEnrollment,
        );
        expect(retained.conversationRecipientEnrollment).not.toBe(
          first?.conversationRecipientEnrollment,
        );
        expect(
          sessionSharingEntriesEqual(retained, {
            ...retained,
            conversationRecipientEnrollment: undefined,
          }),
        ).toBe(false);
        await retainConversationRecipientEnrollment(params);
        expect(readExactSessionEntryRow(f.database, f.scope.sessionKey)?.entry).toEqual(first);
        expect(projectPublicSessionEntry(first!)).not.toHaveProperty(
          "conversationRecipientEnrollment",
        );
        expect(projectPublicSessionEntryPatch(first!)).not.toHaveProperty(
          "conversationRecipientEnrollment",
        );
        expect(
          generationValidPrivateFieldsForSameSession(
            first,
            f.branch.sessionId,
            f.branch.lifecycleRevision,
          ),
        ).toHaveProperty("conversationRecipientEnrollment", first?.conversationRecipientEnrollment);
        expect(
          clearGenerationPrivateFieldsForRotatedSessionPatch(first!, { sessionId: "new-session" }),
        ).toHaveProperty("conversationRecipientEnrollment", undefined);
        expect(
          clearGenerationPrivateFieldsForRotatedSessionPatch(first!, {
            lifecycleRevision: "new-lifecycle",
          }),
        ).toHaveProperty("conversationRecipientEnrollment", undefined);
        expect(captureConversationRecipientEnrollment(undefined)).toBeUndefined();
        expect(() =>
          captureConversationRecipientEnrollment({
            ...first?.conversationRecipientEnrollment,
            version: 2,
          }),
        ).toThrow();
      } finally {
        await held.databaseClaim.release();
      }
    });
  });

  it("does not enroll a changed root incarnation or a principal revoked after an awaited read", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const held = await loadSessionEntryForAdmission(f.scope, { assertCurrent() {} });
      try {
        if (
          !("kind" in held.databaseClaim) ||
          held.databaseClaim.kind !== "worker" ||
          !held.databaseClaim.reader
        ) {
          throw new Error("Expected the native worker cohort");
        }
        const params = {
          reader: held.databaseClaim.reader,
          branch: { ...f.branch, root: { ...f.branch.root, lifecycleRevision: "replaced-root" } },
          audience: audience(),
          assertCurrent() {},
        };
        await expect(retainConversationRecipientEnrollment(params)).rejects.toThrow(
          "changed incarnation",
        );
        let current = true;
        let checks = 0;
        const original = audience(() => {
          if (!current) {
            throw new Error("Original principal revoked");
          }
        });
        await expect(
          retainConversationRecipientEnrollment({
            ...params,
            branch: f.branch,
            audience: original,
            assertCurrent() {
              if (++checks === 1) {
                queueMicrotask(() => {
                  current = false;
                });
              }
            },
          }),
        ).rejects.toThrow("Original principal revoked");
        expect(checks).toBeGreaterThan(1);
        expect(readExactSessionEntryRow(f.database, f.scope.sessionKey)?.entry).not.toHaveProperty(
          "conversationRecipientEnrollment",
        );
      } finally {
        await held.databaseClaim.release();
      }
    });
  });

  it("leaves valid shared or archived endpoints unchanged without aborting admitted work", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const unsupported: Partial<InternalSessionEntry>[] = [
        { visibility: "shared" },
        { archivedAt: 2 },
        { publicShare: { id: "example-share", sessionId: f.branch.sessionId, createdAt: 1 } },
      ];
      for (const patch of unsupported) {
        replaceSessionEntrySync(f.scope, { ...f.entry, ...patch });
        const before = readExactSessionEntryRow(f.database, f.scope.sessionKey)?.entry;
        const held = await loadSessionEntryForAdmission(f.scope, { assertCurrent() {} });
        try {
          if (
            !("kind" in held.databaseClaim) ||
            held.databaseClaim.kind !== "worker" ||
            !held.databaseClaim.reader
          ) {
            throw new Error("Expected the native worker cohort");
          }
          await expect(
            retainConversationRecipientEnrollment({
              reader: held.databaseClaim.reader,
              branch: f.branch,
              audience: audience(),
              assertCurrent() {},
            }),
          ).resolves.toBeUndefined();
          expect(readExactSessionEntryRow(f.database, f.scope.sessionKey)?.entry).toEqual(before);
          expect(before).not.toHaveProperty("conversationRecipientEnrollment");
        } finally {
          await held.databaseClaim.release();
        }
      }
    });
  });

  it("rechecks the original principal at the final native worker commit grant", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const held = await loadSessionEntryForAdmission(f.scope, { assertCurrent() {} });
      let current = true;
      let finalGrants = 0;
      const probe = sqliteWorkerOwnerProbe.admission(admission, (request, grant, callback) => {
        if (request.stage === "commit") {
          finalGrants++;
          current = false;
        }
        callback(request, grant);
      });
      try {
        if (
          !("kind" in held.databaseClaim) ||
          held.databaseClaim.kind !== "worker" ||
          !held.databaseClaim.reader
        ) {
          throw new Error("Expected the native worker cohort");
        }
        await expect(
          retainConversationRecipientEnrollment({
            reader: held.databaseClaim.reader,
            branch: f.branch,
            audience: audience(() => {
              if (!current) {
                throw new Error("Original principal revoked before commit");
              }
            }),
            assertCurrent() {},
          }),
        ).rejects.toThrow("Original principal revoked before commit");
        expect(finalGrants).toBeGreaterThan(0);
        expect(readExactSessionEntryRow(f.database, f.scope.sessionKey)?.entry).not.toHaveProperty(
          "conversationRecipientEnrollment",
        );
      } finally {
        probe.mockRestore();
        await held.databaseClaim.release();
      }
    });
  });
});
