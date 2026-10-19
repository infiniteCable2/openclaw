import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  readConversationKnowledgeReceipt,
} from "../../config/sessions/conversation-knowledge.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { admitSessionConversationBranch } from "../../config/sessions/session-conversation-admission.js";
import { ensureAgentConversationRoot } from "../../config/sessions/session-conversation-root.js";
import { captureSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import { recordSessionParticipantInWorker } from "../../config/sessions/session-sharing-store.async.js";
import type {
  PreparedSessionSourceAuthority,
  SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";

// Actual SQLite, compiled read/write workers, personal read authority and Knowledge owners
// are intentionally not mocked. Controlled transcript commits replace only model generation;
// this proves the Knowledge/storage contract, not Matrix/Assistant or model-loop E2E.
type Branch = {
  agentId: string;
  storePath: string;
  env: NodeJS.ProcessEnv;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
};

export const person = {
  type: "remote",
  pluginId: "matrix",
  domain: "example.test",
  idKind: "user-id",
  id: "@person-a:example.test",
} satisfies SessionParticipantIdentity;
export const otherPerson: SessionParticipantIdentity = { ...person, id: "@person-b:example.test" };

export async function createConversationKnowledgeScenario(state: OpenClawTestState) {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { conversationMode: "branches" } } },
    session: { store: database.path },
  };
  await state.writeConfig(cfg);
  const admitted = await ensureAgentConversationRoot({
    cfg,
    agentId: "main",
    env: state.env,
    admittedStorePath: database.path,
    getConfig: () => cfg,
  });
  const root = {
    agentId: "main",
    storePath: database.path,
    env: state.env,
    sessionKey: admitted.sessionKey,
    sessionId: admitted.entry.sessionId,
  };
  // Native session initialization evaluates freshness against the wall clock.
  // Keep synthetic ordering, without accidentally presenting a 1970 session.
  let clock = Date.now();
  const closeClaims: Array<() => Promise<void>> = [];
  const branch = async (
    label: string,
    participant: SessionParticipantIdentity | null = person,
    chatType: "direct" | "group" | "channel" = "direct",
    sessionKey?: string,
  ): Promise<Branch> => {
    const selected = {
      ...root,
      sessionKey: sessionKey ?? `agent:main:scenario-${label}`,
      sessionId: `scenario-${label}`,
      lifecycleRevision: `scenario-${label}-life`,
    };
    await upsertSessionEntryCore(selected, {
      sessionId: selected.sessionId,
      lifecycleRevision: selected.lifecycleRevision,
      updatedAt: ++clock,
      chatType,
      conversationTopology: admitSessionConversationBranch({
        agentId: selected.agentId,
        sessionKey: selected.sessionKey,
        rootSessionKey: root.sessionKey,
        rootEntry: loadSessionEntry(root),
      }),
    });
    if (participant) {
      expect(
        await recordSessionParticipantInWorker(selected, {
          identity: participant,
          promptedAt: ++clock,
          sessionAgentId: selected.agentId,
          expectedSession: selected,
        }),
      ).toBe("inserted");
    }
    return selected;
  };
  const claim = async (selected: Branch) => {
    const { databaseClaim } = await loadSessionEntryForAdmission(selected);
    if (!("kind" in databaseClaim) || databaseClaim.kind !== "worker" || !databaseClaim.reader) {
      await databaseClaim.release();
      throw new Error("Scenario requires the real admitted worker cohort reader");
    }
    const reader = databaseClaim.reader;
    closeClaims.push(async () => {
      await databaseClaim.release();
    });
    const captured = captureSessionEntryReadSource(database, undefined);
    let current = true;
    const check = () => {
      databaseClaim.assertCurrent();
      if (!current) {
        throw new Error("Original scenario input revoked");
      }
    };
    const prepare = async (): Promise<PreparedSessionSourceAuthority> => {
      check();
      return {
        assertCurrent: check,
        checks: [
          {
            predicate: {
              source: captured,
              sessionKey: selected.sessionKey,
              fields: ["sessionId", "lifecycleRevision"],
              expected: {
                sessionId: selected.sessionId,
                lifecycleRevision: selected.lifecycleRevision,
              },
            },
            refuse: (): never => {
              throw new Error("Original scenario input incarnation changed");
            },
          },
        ],
      };
    };
    const assertCurrent: SessionSourceAssertion = Object.assign(check, {
      prepareSessionSource: prepare,
    });
    return {
      reader,
      sourceMode: "branches" as const,
      assertCurrent,
      sessionId: selected.sessionId,
      revoke: () => {
        current = false;
      },
    };
  };
  const append = async (
    selected: Branch,
    runId: string,
    stopReason = "stop",
    answerText = `${runId} answer`,
  ) => {
    const admittedTurn = await appendTranscriptMessage(selected, {
      message: { role: "user", content: `${runId} question`, timestamp: ++clock },
    });
    const saved = await appendTranscriptMessage(selected, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: answerText }],
        stopReason,
        timestamp: ++clock,
        idempotencyKey: `${runId}:assistant`,
        __openclaw: { runId },
      },
    });
    expect(saved.appended).toBe(true);
    expect(saved.anchor).toBeDefined();
    return {
      runId,
      assistantTranscriptIdempotencyKey: `${runId}:assistant`,
      admission: admittedTurn.anchor,
    };
  };
  const read = async (
    selected: Awaited<ReturnType<typeof claim>>,
    originalParticipant: SessionParticipantIdentity | undefined = person,
  ) => {
    const prepared = await prepareReplyConversationKnowledge({
      ...selected,
      originalParticipant,
      getRuntimeConfig: () => cfg,
    });
    if (!prepared) {
      throw new Error("Expected the actual admitted branch knowledge capability");
    }
    try {
      prepared.assertCurrent();
      expect(prepared.fragments.every((fragment) => fragment.kind === "conversation-data")).toBe(
        true,
      );
      return {
        text: prepared.fragments.map((fragment) => fragment.text).join("\n"),
        observed: structuredClone(prepared.observed),
      };
    } finally {
      prepared.release();
    }
  };
  const receipts = async () =>
    (await loadTranscriptEvents(root)).flatMap((event) => {
      const record = asOptionalRecord(event);
      const receipt =
        record?.customType === CONVERSATION_KNOWLEDGE_REPORT
          ? readConversationKnowledgeReceipt(record.details)
          : undefined;
      return receipt ? [receipt] : [];
    });
  return {
    cfg,
    root,
    branch,
    claim,
    append,
    read,
    receipts,
    close: async () => {
      const failures: unknown[] = [];
      for (const close of closeClaims.toReversed()) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Scenario claim cleanup failed");
      }
    },
  };
}
