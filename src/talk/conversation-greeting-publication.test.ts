import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  publishConversationGreeting,
  type GreetingPublicationTarget,
} from "./conversation-greeting-publication.js";
import { createConversationInputAdmission } from "./conversation-input-admission.js";
import type { ConversationInputScopeV1 } from "./conversation-input.types.js";

const mocks = vi.hoisted(() => ({
  facts: vi.fn(),
  append: vi.fn(),
  publish: vi.fn(),
  reconcile: vi.fn(),
}));
// mock-isolation: Exercise opaque host admission and publication intent without starting DB workers.
vi.mock("../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: mocks.facts,
}));
// mock-isolation: The existing writer owns durable idempotency; verify its exact request and receipts.
vi.mock("../config/sessions/session-accessor.sqlite-transcript-turn.js", () => ({
  appendExpectedSessionTranscriptTurn: mocks.append,
}));
// mock-isolation: Observe postcommit delivery without loading the full accessor/worker runtime.
vi.mock("../config/sessions/session-accessor.js", () => ({
  publishTranscriptUpdate: mocks.publish,
}));
// mock-isolation: Background reconciliation is independent of greeting admission and append.
vi.mock("../config/sessions/conversation-publication-reconcile.js", () => ({
  startConversationKnowledgePublication: mocks.reconcile,
}));

function fixture() {
  const expectedTarget: GreetingPublicationTarget = {
    agentId: "example",
    sessionKey: "agent:example:call",
    sessionId: "original-session",
    lifecycleRevision: "original-revision",
    storePath: "/example/sessions.sqlite",
  };
  const scope: ConversationInputScopeV1 = {
    agentId: "example",
    conversationId: "example-call",
    inputId: "greeting-publication",
    purpose: "greeting",
  };
  const entry: InternalSessionEntry = {
    sessionId: expectedTarget.sessionId,
    lifecycleRevision: expectedTarget.lifecycleRevision ?? undefined,
    updatedAt: 1,
    conversationTopology: {
      version: 1,
      role: "branch",
      rootSessionKey: "agent:example:internal:conversation-root",
      rootSessionId: "root-session",
      rootSessionLifecycleRevision: "root-revision",
    },
  };
  const target = {
    agentId: expectedTarget.agentId,
    canonicalKey: expectedTarget.sessionKey,
    storePath: expectedTarget.storePath,
    entry,
  };
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("Host authority revoked");
    }
  };
  const release = vi.fn();
  const sourceRelease = vi.fn();
  const audience = {
    agentId: "example",
    sessionKey: expectedTarget.sessionKey,
    participant: { type: "profile" as const, id: "example-person" },
    channelId: "matrix",
    accountId: "default",
    nativeChannelId: "example-room",
    assertCurrent,
  };
  const admit = () =>
    createConversationInputAdmission({
      scope,
      source: { channelId: "matrix", sessionKey: expectedTarget.sessionKey },
      privateAudience: audience,
      assertCurrent,
      assertInputCurrent: assertCurrent,
      release,
      prepareContext: () => ({ AgentId: "example", SessionKey: expectedTarget.sessionKey }),
    });
  mocks.facts.mockResolvedValue({ readCurrent: () => ({ target }), release: sourceRelease });
  mocks.append.mockImplementation(async (_target, options) => {
    options.assertCurrent();
    return {
      appendedMessages: [
        { appended: true, messageId: "message-one", message: options.messages[0].message },
      ],
    };
  });
  const params = {
    cfg: {},
    scope,
    expectedTarget,
    expectedTranscript: { generation: "original-generation", rawSeq: 1, updatedAt: 1 },
    eventId: "greeting:example-call:one",
    text: "Good morning!",
    timestamp: 1_800_000_000_000,
    audioDelivery: "submitted" as const,
  };
  return { params, admit, target, release, sourceRelease, revoke: () => (current = false) };
}

beforeEach(() => vi.clearAllMocks());

describe("greeting publication at the original conversation", () => {
  it.each(["submitted", "interrupted"] as const)(
    "publishes %s speech with a stable assistant-only identity and private audience",
    async (audioDelivery) => {
      const f = fixture();
      expect(
        await publishConversationGreeting({ ...f.params, admission: f.admit(), audioDelivery }),
      ).toEqual({
        appended: true,
        audioDelivery,
      });
      const request = mocks.append.mock.calls[0]![1];
      expect(request).toMatchObject({
        expectedSessionId: "original-session",
        selectedLifecycleRevision: "original-revision",
        messages: [
          {
            eventId: f.params.eventId,
            message: {
              role: "assistant",
              idempotencyKey: f.params.eventId,
              timestamp: f.params.timestamp,
              content: [{ type: "text", text: "Good morning!" }],
            },
            conversationPublication: {
              role: "assistant",
              sourceMode: "native",
              privateAudience: {
                participant: { type: "profile", id: "example-person" },
                admission: "self",
              },
            },
          },
        ],
      });
      expect(request.messages).toHaveLength(1);
      // A native duplicate receipt publishes no second transcript notification.
      mocks.append.mockResolvedValueOnce({ appendedMessages: [{ appended: false }] });
      expect(
        await publishConversationGreeting({ ...f.params, admission: f.admit() }),
      ).toMatchObject({ appended: false });
      expect(mocks.append.mock.calls[1]![1].messages[0].eventId).toBe(f.params.eventId);
      expect(mocks.publish).toHaveBeenCalledTimes(1);
      expect(f.release).toHaveBeenCalledTimes(2);
      expect(f.sourceRelease).toHaveBeenCalledTimes(2);
    },
  );

  it("does not publish an empty greeting", async () => {
    const f = fixture();
    await expect(
      publishConversationGreeting({ ...f.params, text: " ", admission: f.admit() }),
    ).rejects.toThrow("original input");
    expect(mocks.facts).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["agent", "key", "session", "revision", "store"])(
    "refuses a changed %s before append",
    async (field) => {
      const f = fixture();
      if (field === "agent") {
        f.target.agentId = "other";
      }
      if (field === "key") {
        f.target.canonicalKey = "agent:example:other";
      }
      if (field === "session") {
        f.target.entry.sessionId = "replacement";
      }
      if (field === "revision") {
        f.target.entry.lifecycleRevision = "replacement";
      }
      if (field === "store") {
        f.target.storePath = "/other/sessions.sqlite";
      }
      await expect(
        publishConversationGreeting({ ...f.params, admission: f.admit() }),
      ).rejects.toThrow("target changed");
      expect(mocks.append).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.sourceRelease).toHaveBeenCalledOnce();
    },
  );

  it("rechecks fresh host authority after the facts read and releases both owners", async () => {
    const f = fixture();
    const admission = f.admit();
    mocks.facts.mockImplementationOnce(async () => {
      f.revoke();
      return { readCurrent: () => ({ target: f.target }), release: f.sourceRelease };
    });
    await expect(publishConversationGreeting({ ...f.params, admission })).rejects.toThrow(
      "Host authority revoked",
    );
    expect(mocks.append).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.sourceRelease).toHaveBeenCalledOnce();
  });
});
