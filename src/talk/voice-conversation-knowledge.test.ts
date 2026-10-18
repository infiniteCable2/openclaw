import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  prepare: vi.fn(),
  record: vi.fn(),
  participant: vi.fn(),
  warn: vi.fn(),
}));
// mock-isolation: Native worker/read/transaction owners are independently tested; no workers/models here.
vi.mock("../config/sessions/session-accessor.sqlite-entry-admission.js", () => ({
  loadSessionEntryForAdmission: mocks.load,
}));
// mock-isolation: Borrowed-reader lifetime is tested without starting a second knowledge read owner.
vi.mock("../auto-reply/reply/conversation-knowledge.js", () => ({
  prepareReplyConversationKnowledge: mocks.prepare,
}));
// mock-isolation: Capture exact observation receipts without committing transcript reports in this adapter test.
vi.mock("../config/sessions/conversation-knowledge-store.js", () => ({
  recordConversationUtteranceObservation: mocks.record,
}));
// mock-isolation: Record participant commit arguments without invoking the native SQLite participant worker.
vi.mock("../config/sessions/session-sharing-store.async.js", () => ({
  recordSessionParticipantInWorker: mocks.participant,
}));
vi.mock("../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ warn: mocks.warn }),
}));

import {
  prepareVoiceConversationKnowledge,
  recordVoiceConversationObservation,
} from "./voice-conversation-knowledge.js";

const config: OpenClawConfig = {
  agents: { entries: { example: { conversationMode: "branches" } } },
};
const participant = { type: "profile" as const, id: "example-person" };
const target = {
  agentId: "example",
  sessionKey: "agent:example:branch",
  sessionId: "session-a",
  storePath: "/example/store.sqlite",
};
const anchor: TranscriptEntryAnchor = {
  ...target,
  entryId: "voice:call:1",
  generation: "transcript-a",
  rawSeq: 1,
  activeMessagePosition: 0,
  effectiveParentId: null,
};
function setup() {
  let current = true;
  const assertCurrent = vi.fn(() => {
    if (!current) {
      throw new Error("Original voice source revoked");
    }
  });
  const reader = { assertCurrent };
  const release = vi.fn(async () => {});
  mocks.load.mockResolvedValue({
    entry: { sessionId: target.sessionId, lifecycleRevision: "row-a" },
    databaseClaim: { kind: "worker", reader, assertCurrent, release },
  });
  mocks.record.mockResolvedValue(true);
  mocks.participant.mockResolvedValue("inserted");
  const preparedRelease = vi.fn();
  mocks.prepare.mockResolvedValue({
    fragments: [{ kind: "conversation-data", text: "quoted observation" }],
    observed: [],
    assertCurrent,
    release: preparedRelease,
  });
  return {
    assertCurrent,
    reader,
    release,
    preparedRelease,
    revoke: () => {
      current = false;
    },
  };
}
beforeEach(() => vi.resetAllMocks());

describe("native voice branch knowledge adapter", () => {
  it("leaves source-only native mode unchanged without loading a reader", async () => {
    const owner = setup();
    expect(
      await prepareVoiceConversationKnowledge({
        target,
        assertCurrent: owner.assertCurrent,
        getRuntimeConfig: () => ({}),
      }),
    ).toBeUndefined();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("uses the actual borrowed reader and retains it until release", async () => {
    const owner = setup();
    const prepared = await prepareVoiceConversationKnowledge({
      target,
      participant,
      assertCurrent: owner.assertCurrent,
      getRuntimeConfig: () => config,
    });
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        reader: owner.reader,
        sessionId: target.sessionId,
        originalParticipant: participant,
      }),
    );
    expect(prepared?.fragments).toEqual([
      { kind: "conversation-data", text: "quoted observation" },
    ]);
    expect(owner.release).not.toHaveBeenCalled();
    await Promise.all([prepared!.release(), prepared!.release()]);
    expect(owner.release).toHaveBeenCalledTimes(1);
    expect(owner.preparedRelease).toHaveBeenCalledTimes(1);
    expect(() => prepared!.assertCurrent()).toThrow("released");
  });

  it("does not infer history access from a non-worker row or matching IDs", async () => {
    const owner = setup();
    mocks.load.mockResolvedValue({
      entry: { sessionId: target.sessionId },
      databaseClaim: { kind: "native", assertCurrent: owner.assertCurrent, release: owner.release },
    });
    const prepared = await prepareVoiceConversationKnowledge({
      target,
      participant,
      assertCurrent: owner.assertCurrent,
      getRuntimeConfig: () => config,
    });
    expect(prepared?.fragments[0]?.text).toContain("original-native-reader-unavailable");
    expect(mocks.prepare).not.toHaveBeenCalled();
    await prepared?.release();
  });

  it("preserves native prepared source predicates through the reader adapter", async () => {
    const owner = setup();
    const prepare = vi.fn(async () => ({
      nativeSource: true,
      assertCurrent: owner.assertCurrent,
      checks: [],
    }));
    mocks.prepare.mockResolvedValueOnce({
      fragments: [],
      observed: [],
      assertCurrent: Object.assign(owner.assertCurrent, { prepareSessionSource: prepare }),
      release: owner.preparedRelease,
    });
    const prepared = await prepareVoiceConversationKnowledge({
      target,
      participant,
      assertCurrent: owner.assertCurrent,
      getRuntimeConfig: () => config,
    });
    const source = await prepareSessionSourceAuthority(prepared!.assertCurrent);
    expect(prepare).toHaveBeenCalled();
    expect(source.nativeSource).toBe(true);
    await source.release?.();
    await prepared?.release();
  });

  it("rejects a replaced native session and releases the borrowed owner", async () => {
    const owner = setup();
    mocks.load.mockResolvedValue({
      entry: { sessionId: "replacement" },
      databaseClaim: {
        kind: "worker",
        reader: owner.reader,
        assertCurrent: owner.assertCurrent,
        release: owner.release,
      },
    });
    await expect(
      prepareVoiceConversationKnowledge({
        target,
        participant,
        assertCurrent: owner.assertCurrent,
        getRuntimeConfig: () => config,
      }),
    ).rejects.toThrow("changed");
    expect(owner.release).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("never projects private related context for an unidentified current speaker", async () => {
    const owner = setup();
    const prepared = await prepareVoiceConversationKnowledge({
      target,
      assertCurrent: owner.assertCurrent,
      getRuntimeConfig: () => config,
    });
    expect(prepared?.fragments[0]?.text).toContain("original-participant-unconfirmed");
    expect(mocks.prepare).not.toHaveBeenCalled();
    await prepared?.release();
  });

  it("keeps the original participant restriction across an awaited native admission", async () => {
    const owner = setup();
    const original = { ...participant };
    mocks.load.mockImplementationOnce(async () => {
      original.id = "replacement-person";
      return {
        entry: { sessionId: target.sessionId, lifecycleRevision: "row-a" },
        databaseClaim: {
          kind: "worker",
          reader: owner.reader,
          assertCurrent: owner.assertCurrent,
          release: owner.release,
        },
      };
    });
    const prepared = await prepareVoiceConversationKnowledge({
      target,
      participant: original,
      assertCurrent: owner.assertCurrent,
      getRuntimeConfig: () => config,
    });
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        originalParticipant: participant,
        expectedAudienceIdentity: JSON.stringify([
          JSON.stringify({ type: "profile" }),
          participant.id,
        ]),
      }),
    );
    await prepared?.release();
  });

  it("reports the actual append anchor as observation, never a completed task", async () => {
    const owner = setup();
    await recordVoiceConversationObservation({
      anchor,
      lifecycleRevision: "row-a",
      role: "assistant",
      fresh: true,
      timestamp: 1,
      config,
      assertCurrent: owner.assertCurrent,
    });
    expect(mocks.record).toHaveBeenCalledExactlyOnceWith({
      reader: owner.reader,
      assertCurrent: owner.assertCurrent,
      sessionId: target.sessionId,
      anchor,
      role: "assistant",
    });
    expect(mocks.record.mock.calls[0]?.[0]).not.toHaveProperty("runId");
    expect(mocks.participant).not.toHaveBeenCalled();
    expect(owner.release).toHaveBeenCalledOnce();
  });

  it("records only genuine user participant with original row and commit fence", async () => {
    const owner = setup();
    const inputParticipant = { type: "profile" as const, id: "example-person" };
    await recordVoiceConversationObservation({
      anchor,
      lifecycleRevision: "row-a",
      role: "user",
      participant: inputParticipant,
      fresh: true,
      timestamp: 42,
      config,
      assertCurrent: owner.assertCurrent,
    });
    expect(mocks.participant).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(target),
      {
        identity: inputParticipant,
        promptedAt: 42,
        sessionAgentId: "example",
        expectedSession: { sessionId: target.sessionId, lifecycleRevision: "row-a" },
      },
      owner.assertCurrent,
    );
    expect(mocks.record).toHaveBeenCalledOnce();
  });

  it("does not double-credit participants on transcript deduplication", async () => {
    const owner = setup();
    await recordVoiceConversationObservation({
      anchor,
      lifecycleRevision: "row-a",
      role: "user",
      participant: { type: "profile", id: "example-person" },
      fresh: false,
      timestamp: 42,
      config,
      assertCurrent: owner.assertCurrent,
    });
    expect(mocks.participant).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledOnce();
  });

  it("cannot report after source revocation during a borrowed read", async () => {
    const owner = setup();
    mocks.load.mockImplementationOnce(async () => {
      owner.revoke();
      return {
        entry: { sessionId: target.sessionId, lifecycleRevision: "row-a" },
        databaseClaim: {
          kind: "worker",
          reader: owner.reader,
          assertCurrent: owner.assertCurrent,
          release: owner.release,
        },
      };
    });
    await recordVoiceConversationObservation({
      anchor,
      lifecycleRevision: "row-a",
      role: "user",
      fresh: true,
      timestamp: 1,
      config,
      assertCurrent: owner.assertCurrent,
    });
    expect(mocks.record).not.toHaveBeenCalled();
    expect(owner.release).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it("does not turn a report failure into a failed or retryable saved utterance", async () => {
    const owner = setup();
    mocks.record.mockRejectedValueOnce(new Error("Report refused"));
    await expect(
      recordVoiceConversationObservation({
        anchor,
        lifecycleRevision: "row-a",
        role: "assistant",
        fresh: true,
        timestamp: 1,
        config,
        assertCurrent: owner.assertCurrent,
      }),
    ).resolves.toBeUndefined();
    expect(owner.release).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });
});
