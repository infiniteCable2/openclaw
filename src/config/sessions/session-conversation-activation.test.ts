import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { prepareReplyConversationKnowledge } from "../../auto-reply/reply/conversation-knowledge.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveAgentConversationMode } from "../agent-conversation-mode.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { CONVERSATION_KNOWLEDGE_CONTEXT } from "./conversation-knowledge-packets.js";
import { CONVERSATION_KNOWLEDGE_SEED } from "./conversation-knowledge-seed.js";
import { recordConversationKnowledgeTurn } from "./conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  readConversationKnowledgeReceipt,
} from "./conversation-knowledge.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { prepareSessionConversationActivation } from "./session-conversation-activation.js";
import { admitSessionConversationBranch } from "./session-conversation-admission.js";
import { enrollSessionConversationBranch } from "./session-conversation-enrollment.js";
import { resolveAgentConversationRootSessionKey } from "./session-conversation-root-key.js";
import { ensureAgentConversationRoot } from "./session-conversation-root.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import { captureSessionEntrySourceAssertion } from "./session-entry-source-authority.js";
import type { SessionParticipantIdentity } from "./session-participant-identity.js";
import { recordSessionParticipantInWorker } from "./session-sharing-store.async.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";
import type { InternalSessionEntry } from "./types.js";

// Real SQLite, admission, seeding, report selection and personal-difference authority.
// Synthetic committed replies replace model generation; this is not transport/model-loop E2E.
let state: OpenClawTestState;
let database: ReturnType<typeof openOpenClawAgentDatabase>;
let cfg: OpenClawConfig;
let clock = 10;
const person: SessionParticipantIdentity = {
  type: "remote",
  pluginId: "matrix",
  domain: "example.test",
  idKind: "user-id",
  id: "@person:example.test",
};
type Scope = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  storePath: string;
  env: NodeJS.ProcessEnv;
};
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "conversation-activation" });
  database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  cfg = {
    agents: { entries: { main: { conversationMode: "native" } } },
    session: { store: database.path },
  };
  await state.writeConfig(cfg);
});
afterAll(async () => {
  await state.cleanup();
});

function scope(sessionKey: string, sessionId: string): Scope {
  return { agentId: "main", sessionKey, sessionId, storePath: database.path, env: state.env };
}
async function mode(conversationMode: "native" | "branches") {
  cfg = { ...cfg, agents: { entries: { main: { conversationMode } } } };
  await state.writeConfig(cfg);
}
async function createConversation(
  selected: Scope,
  topology?: InternalSessionEntry["conversationTopology"],
) {
  replaceSessionEntrySync(selected, {
    sessionId: selected.sessionId,
    lifecycleRevision: `${selected.sessionId}-life`,
    updatedAt: ++clock,
    chatType: "direct",
    visibility: "draft",
    createdAt: 1,
    createdVia: "channel",
    createdActor: { type: "human", source: "channel", id: "synthetic-original-caller" },
    delivery: normalizeSessionDeliveryState({
      context: { channel: "matrix", to: "synthetic-room" },
    }),
    cliSessionBindings: {
      "synthetic-cli": { sessionId: "keep-native-thread", resumeCheckpointId: "keep-checkpoint" },
    },
    ...(topology ? { conversationTopology: topology } : {}),
  });
  expect(
    await recordSessionParticipantInWorker(selected, {
      identity: person,
      promptedAt: ++clock,
      sessionAgentId: selected.agentId,
      expectedSession: {
        sessionId: selected.sessionId,
        lifecycleRevision: `${selected.sessionId}-life`,
      },
    }),
  ).toBe("inserted");
}
async function append(selected: Scope, runId: string) {
  await appendTranscriptMessage(selected, {
    message: { role: "user", content: `${runId} question`, timestamp: ++clock },
  });
  const saved = await appendTranscriptMessage(selected, {
    message: {
      role: "assistant",
      content: [{ type: "text", text: `${runId} answer` }],
      stopReason: "stop",
      timestamp: ++clock,
      idempotencyKey: `${runId}:assistant`,
      __openclaw: { runId },
    },
  });
  expect(saved.appended).toBe(true);
  return { runId, assistantTranscriptIdempotencyKey: `${runId}:assistant` };
}
async function withOwner<T>(
  selected: Scope,
  run: (owner: {
    reader: SessionEntryCohortReader;
    assertCurrent: SessionSourceAssertion;
    sessionId: string;
    sourceMode: "native" | "branches";
  }) => Promise<T>,
) {
  const held = await loadSessionEntryForAdmission(selected);
  try {
    if (
      !("kind" in held.databaseClaim) ||
      held.databaseClaim.kind !== "worker" ||
      !held.databaseClaim.reader ||
      !held.entry
    ) {
      throw new Error("Activation scenario requires its real admitted worker reader");
    }
    const assertCurrent = captureSessionEntrySourceAssertion({
      scope: selected,
      readSource: captureSessionEntryReadSource(database, undefined),
      expected: held.entry,
      fields: ["sessionId", "lifecycleRevision"],
      assertCurrent: () => held.databaseClaim.assertCurrent(),
      assertHostCurrent: () => held.databaseClaim.assertCurrent(),
      refuse: (): never => {
        throw new Error("Original activation source changed");
      },
    });
    return await run({
      reader: held.databaseClaim.reader,
      assertCurrent,
      sessionId: selected.sessionId,
      sourceMode: resolveAgentConversationMode(cfg, selected.agentId),
    });
  } finally {
    await held.databaseClaim.release();
  }
}
async function activate(selected: Scope) {
  await withOwner(selected, (owner) =>
    prepareSessionConversationActivation({
      ...selected,
      cfg,
      getConfig: () => cfg,
      assertCurrent: owner.assertCurrent,
    }),
  );
}
async function reports(selected: Scope, customType: string) {
  return (await loadTranscriptEvents(selected))
    .map(asOptionalRecord)
    .filter((event) => event?.customType === customType);
}
async function retain(selected: Scope) {
  await withOwner(selected, async (owner) => {
    const prepared = await prepareReplyConversationKnowledge({
      ...owner,
      originalParticipant: person,
      getRuntimeConfig: () => cfg,
      retainInHistory: {
        maintainContext: async (source) => {
          source();
        },
      },
    });
    try {
      prepared?.assertCurrent();
    } finally {
      prepared?.release();
    }
  });
}

describe("native conversation mode activation", () => {
  it("keeps one native main through enable, native catch-up and re-enable without duplicate knowledge", async () => {
    const trace: string[] = [];
    const main = scope("agent:main:main", "original-native-main");
    const rootKey = resolveAgentConversationRootSessionKey({ cfg, agentId: "main" });
    await createConversation(main);
    await append(main, "before-enable");
    const initialEntry = await readSessionEntryReadOnlyInWorker(main);
    const initialHistory = await loadTranscriptEvents(main);
    await activate(main);
    expect(await readSessionEntryReadOnlyInWorker(main)).toEqual(initialEntry);
    expect(await loadTranscriptEvents(main)).toEqual(initialHistory);
    expect(
      await readSessionEntryReadOnlyInWorker({ ...main, sessionKey: rootKey }),
    ).toBeUndefined();
    trace.push("native without infrastructure is unchanged");

    await mode("branches");
    const admitted = await ensureAgentConversationRoot({
      cfg,
      agentId: "main",
      env: state.env,
      admittedStorePath: database.path,
      getConfig: () => cfg,
    });
    const root = scope(admitted.sessionKey, admitted.entry.sessionId);
    await activate(main);
    const activated = await readSessionEntryReadOnlyInWorker(main);
    expect(activated).toEqual({
      ...initialEntry,
      conversationTopology: {
        version: 1,
        role: "branch",
        rootSessionKey: root.sessionKey,
        rootSessionId: root.sessionId,
        rootSessionLifecycleRevision: admitted.entry.lifecycleRevision,
      },
    });
    expect(await loadTranscriptEvents(main)).toEqual(initialHistory);
    const initialReports = await reports(root, CONVERSATION_KNOWLEDGE_REPORT);
    expect(
      initialReports.map((event) => readConversationKnowledgeReceipt(event?.details)?.sourceMode),
    ).toEqual(["native"]);
    expect(await reports(root, CONVERSATION_KNOWLEDGE_SEED)).toHaveLength(1);
    const seededRoot = await loadTranscriptEvents(root);
    await activate(main);
    expect(await loadTranscriptEvents(root)).toEqual(seededRoot);
    trace.push("existing main enrolls and seeds once without rewriting dialogue");

    const branch = scope("agent:main:activation-branch", "activation-branch");
    const topology = admitSessionConversationBranch({
      agentId: "main",
      sessionKey: branch.sessionKey,
      rootSessionKey: root.sessionKey,
      rootEntry: admitted.entry,
    });
    await createConversation(branch, topology);
    await activate(branch);
    const terminal = await append(branch, "branch-period");
    await withOwner(branch, async (owner) => {
      expect(await recordConversationKnowledgeTurn({ ...owner, ...terminal })).toBe(true);
    });
    await retain(branch);
    expect(JSON.stringify(await reports(branch, CONVERSATION_KNOWLEDGE_CONTEXT))).toContain(
      "before-enable answer",
    );
    trace.push("branch consumes the original native main through personal authority");

    await mode("native");
    const other = scope("agent:main:activation-other", "activation-other");
    await createConversation(
      other,
      admitSessionConversationBranch({
        agentId: "main",
        sessionKey: other.sessionKey,
        rootSessionKey: root.sessionKey,
        rootEntry: admitted.entry,
      }),
    );
    const otherTerminal = await append(other, "other-native-period");
    await withOwner(other, async (owner) => {
      expect(await recordConversationKnowledgeTurn({ ...owner, ...otherTerminal })).toBe(true);
    });
    await activate(main);
    await retain(main);
    const nativePackets = JSON.stringify(await reports(main, CONVERSATION_KNOWLEDGE_CONTEXT));
    expect(nativePackets).toContain("branch-period answer");
    expect(nativePackets).not.toContain("other-native-period answer");
    expect(await readSessionEntryReadOnlyInWorker(main)).toEqual(activated);
    const nativeTerminal = await append(main, "main-native-off-period");
    await withOwner(main, async (owner) => {
      expect(await recordConversationKnowledgeTurn({ ...owner, ...nativeTerminal })).toBe(true);
    });
    trace.push(
      "native main catches only branch-mode contributions and records its own native period",
    );

    await mode("branches");
    const reused = await ensureAgentConversationRoot({
      cfg,
      agentId: "main",
      env: state.env,
      admittedStorePath: database.path,
      getConfig: () => cfg,
    });
    expect(reused.created).toBe(false);
    expect(reused.entry.sessionId).toBe(root.sessionId);
    expect(reused.entry.lifecycleRevision).toBe(admitted.entry.lifecycleRevision);
    await activate(main);
    await retain(branch);
    const packets = await reports(branch, CONVERSATION_KNOWLEDGE_CONTEXT);
    expect(JSON.stringify(packets)).toContain("main-native-off-period answer");
    expect(JSON.stringify(packets)).toContain("other-native-period answer");
    const packetIds = packets.map((event) => asOptionalRecord(event?.details)?.packetId);
    expect(new Set(packetIds).size).toBe(packetIds.length);
    const completedRoot = await loadTranscriptEvents(root);
    await activate(main);
    await retain(branch);
    expect(await reports(branch, CONVERSATION_KNOWLEDGE_CONTEXT)).toEqual(packets);
    expect(await loadTranscriptEvents(root)).toEqual(completedRoot);
    expect(
      (await loadTranscriptEvents(root)).some(
        (event) => asOptionalRecord(event)?.type === "message",
      ),
    ).toBe(false);
    trace.push("re-enable reuses the root and consumes native-period deltas exactly once");
    expect(trace).toEqual([
      "native without infrastructure is unchanged",
      "existing main enrolls and seeds once without rewriting dialogue",
      "branch consumes the original native main through personal authority",
      "native main catches only branch-mode contributions and records its own native period",
      "re-enable reuses the root and consumes native-period deltas exactly once",
    ]);
  });

  it("refuses a marked branch tied to another valid root before seeding either root", async () => {
    await mode("branches");
    const admitted = await ensureAgentConversationRoot({
      cfg,
      agentId: "main",
      env: state.env,
      admittedStorePath: database.path,
      getConfig: () => cfg,
    });
    const canonicalRoot = scope(admitted.sessionKey, admitted.entry.sessionId);
    const previousRoot = scope("agent:main:previous-valid-root", "previous-valid-root");
    const previousEntry: InternalSessionEntry = {
      ...admitted.entry,
      sessionId: previousRoot.sessionId,
      lifecycleRevision: "previous-root-life",
    };
    replaceSessionEntrySync(previousRoot, previousEntry);
    const selected = scope("agent:main:old-root-branch", "old-root-branch");
    await createConversation(
      selected,
      admitSessionConversationBranch({
        agentId: "main",
        sessionKey: selected.sessionKey,
        rootSessionKey: previousRoot.sessionKey,
        rootEntry: previousEntry,
      }),
    );
    await append(selected, "old-root-history");
    const before = await readSessionEntryReadOnlyInWorker(selected);
    const history = await loadTranscriptEvents(selected);
    const canonicalHistory = await loadTranscriptEvents(canonicalRoot);
    const previousHistory = await loadTranscriptEvents(previousRoot);
    await expect(activate(selected)).rejects.toThrow("incarnation changed");
    expect(await readSessionEntryReadOnlyInWorker(selected)).toEqual(before);
    expect(await loadTranscriptEvents(selected)).toEqual(history);
    expect(await loadTranscriptEvents(canonicalRoot)).toEqual(canonicalHistory);
    expect(await loadTranscriptEvents(previousRoot)).toEqual(previousHistory);
  });

  it.each(["source", "root", "abort", "store", "global", "agent", "root-key"] as const)(
    "does not finish a seed after %s changes during original-source preparation",
    async (change, { signal }) => {
      await mode("branches");
      const admitted = await ensureAgentConversationRoot({
        cfg,
        agentId: "main",
        env: state.env,
        admittedStorePath: database.path,
        getConfig: () => cfg,
      });
      const root = scope(admitted.sessionKey, admitted.entry.sessionId);
      const selected = scope(
        `agent:main:activation-refused-${change}`,
        `activation-refused-${change}`,
      );
      await createConversation(selected);
      await append(selected, `seed-refused-${change}`);
      await withOwner(selected, async (owner) => {
        await enrollSessionConversationBranch({
          ...selected,
          cfg,
          getConfig: () => cfg,
          assertCurrent: owner.assertCurrent,
        });
      });
      // Removing an agent must refuse even when its missing-entry default keeps the
      // captured native mode unchanged; the other config cases stay in branches.
      if (change === "agent") {
        await mode("native");
      }
      const inputConfig = cfg;
      const seedCount = (await reports(root, CONVERSATION_KNOWLEDGE_SEED)).length;
      const entered = createDeferred();
      const release = createDeferred();
      const cancellation = new AbortController();
      try {
        await withOwner(selected, async (owner) => {
          let current = true;
          let intercepted = false;
          const liveSource = composeSessionSourceAssertion(
            [owner.assertCurrent],
            (assertSource) => {
              assertSource();
              if (!current) {
                throw new Error("Original activation input revoked");
              }
            },
          );
          const prepare = liveSource.prepareSessionSource;
          if (!prepare) {
            throw new Error("Expected real native prepared source");
          }
          const source = Object.assign(() => liveSource(), {
            prepareSessionSource: async () => {
              const prepared = await prepare();
              if (!intercepted) {
                intercepted = true;
                entered.resolve();
                await release.promise;
              }
              return prepared;
            },
          });
          const operation = prepareSessionConversationActivation({
            ...selected,
            cfg: inputConfig,
            getConfig: () => cfg,
            assertCurrent: source,
            signal: cancellation.signal,
          });
          const settled = operation.then(
            () => "completed",
            () => "refused",
          );
          try {
            await withinTest(
              awaitGateBeforeSettlement(
                entered.promise,
                operation,
                "Activation settled before seed source preparation",
              ),
              signal,
            );
            if (change === "source") {
              current = false;
            } else if (change === "abort") {
              cancellation.abort(new Error("Seed cancelled"));
            } else if (change === "root") {
              replaceSessionEntrySync(root, {
                ...admitted.entry,
                sessionId: "replaced-activation-root",
                lifecycleRevision: "replaced",
              });
            } else if (change === "store") {
              cfg = {
                ...inputConfig,
                session: { ...inputConfig.session, store: state.statePath("changed-store.sqlite") },
              };
            } else if (change === "global") {
              cfg = { ...inputConfig, session: { ...inputConfig.session, scope: "global" } };
            } else if (change === "agent") {
              cfg = {
                ...inputConfig,
                agents: { entries: { other: { conversationMode: "native" } } },
              };
            } else {
              cfg = {
                ...inputConfig,
                session: { ...inputConfig.session, mainKey: "internal:conversation-root" },
              };
            }
            expect(resolveAgentConversationMode(cfg, selected.agentId)).toBe(
              resolveAgentConversationMode(inputConfig, selected.agentId),
            );
          } finally {
            release.resolve();
            expect(await settled).toBe("refused");
          }
        });
      } finally {
        cfg = inputConfig;
        if (change === "root") {
          replaceSessionEntrySync(root, admitted.entry);
        }
      }
      expect(await reports(root, CONVERSATION_KNOWLEDGE_SEED)).toHaveLength(seedCount);
    },
  );
});
