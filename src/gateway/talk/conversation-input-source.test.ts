import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { ChatType } from "../../channels/chat-type.js";
import { deriveSessionMetaPatch } from "../../config/sessions/metadata.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { readConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { readSessionInputProfileId } from "../../sessions/session-participant-input.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  prepareConversationReplyContext,
} from "../../talk/conversation-input-admission.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";

const mocks = vi.hoisted(() => ({ prepareFacts: vi.fn(), openRecipient: vi.fn() }));
// mock-isolation: Native row publication I/O is independent of this input handoff contract.
vi.mock("../session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: mocks.prepareFacts,
}));
// mock-isolation: Prove the Gateway's opening handoff without starting background recipient workers.
vi.mock("../../auto-reply/reply/conversation-knowledge-open.js", () => ({
  openConversationKnowledgeRecipient: mocks.openRecipient,
}));

import { createGatewayTalkConversationInputSource } from "./conversation-input-source.js";

const target = {
  agentId: "researcher",
  sessionKey: "agent:researcher:talk:call",
  canonicalKey: "agent:researcher:talk:call",
  storePath: "/tmp/openclaw-test/sessions",
};
const scope = {
  agentId: target.agentId,
  conversationId: "call",
  inputId: "original-spoken-input",
  purpose: "user" as const,
};

function fixture(
  participant?: SessionParticipantIdentity,
  chatType?: ChatType,
  profileId = "operator-alpha",
) {
  const gateway = createDirectChatContext({ getRuntimeConfig: () => ({}) });
  const release = vi.fn();
  const releaseFacts = vi.fn();
  const connection = new AbortController();
  let revoked = false;
  let audioClosed = false;
  const entry: Pick<
    InternalSessionEntry,
    "sessionId" | "lifecycleRevision" | "chatType" | "publicShare"
  > = {
    sessionId: "original-session",
    lifecycleRevision: "original-revision",
    chatType,
  };
  mocks.prepareFacts.mockResolvedValue({
    readCurrent: () => ({
      target: {
        ...target,
        entry,
      },
    }),
    release: releaseFacts,
  });
  const authority = createAdmittedRunOperatorAuthority({
    profileId,
    scopes: ["operator.write"],
    gatewayAccessGrant: null,
    rolePolicy: { sessionAccessCap: "none", sandboxRequired: true, agents: [target.agentId] },
    assertCurrent() {
      if (revoked) {
        throw new Error("Original operator revoked");
      }
    },
  });
  const captureOperatorAuthority = vi.fn(async () => ({ authority, release }));
  const source = createGatewayTalkConversationInputSource({
    target,
    conversationId: scope.conversationId,
    getRuntimeConfig: () => ({}),
    captureOperatorAuthority,
    authority: { senderIsOwner: false },
    participant,
    connectionAbortSignal: connection.signal,
    assertInputCurrent() {
      if (audioClosed) {
        throw new Error("Audio connection closed");
      }
    },
    resolveGatewayContext: () => gateway,
  });
  return {
    source,
    release,
    releaseFacts,
    captureOperatorAuthority,
    entry,
    closeConnection: () => connection.abort(),
    closeAudio: () => (audioClosed = true),
    revoke: () => (revoked = true),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openRecipient.mockResolvedValue(undefined);
});

describe("native Gateway speech participant", () => {
  it("opens a private recipient before input and retains dedicated custody until connection close", async () => {
    const f = fixture({ type: "profile", id: "operator-alpha" }, "direct");
    await f.source.prepareConnection?.();
    await f.source.prepareConnection?.();
    expect(f.captureOperatorAuthority).toHaveBeenCalledOnce();
    expect(mocks.openRecipient).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: {
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
          sessionId: f.entry.sessionId,
          storePath: target.storePath,
        },
        participant: { type: "profile", id: "operator-alpha" },
      }),
    );
    const audience = mocks.openRecipient.mock.calls[0]![0].audience;
    expect(() => audience.assertCurrent()).not.toThrow();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.releaseFacts).not.toHaveBeenCalled();
    f.closeConnection();
    await f.source.closeConnection?.();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.releaseFacts).toHaveBeenCalledOnce();
    expect(() => audience.assertCurrent()).toThrow();
  });

  it("does not reuse the connection hold as an accepted input's authority", async () => {
    const f = fixture({ type: "profile", id: "operator-alpha" }, "direct");
    await f.source.prepareConnection?.();
    const input = consumeConversationInputAdmission(await f.source.admitInput(scope), scope);
    try {
      claimConversationInputExecution(input);
      f.closeConnection();
      await f.source.closeConnection?.();
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(() => input.assertCurrent()).not.toThrow();
      await expect(
        prepareConversationReplyContext(input, { text: "Already accepted user work." }),
      ).resolves.toMatchObject({ SessionKey: target.canonicalKey });
    } finally {
      input.release?.();
    }
    expect(f.captureOperatorAuthority).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.releaseFacts).toHaveBeenCalledTimes(2);
  });

  it.each(["expired", "wrong-person"] as const)(
    "refuses %s opening authority and releases native custody",
    async (kind) => {
      const f = fixture(
        { type: "profile", id: kind === "wrong-person" ? "operator-beta" : "operator-alpha" },
        "direct",
      );
      if (kind === "expired") {
        f.revoke();
      }
      await expect(f.source.prepareConnection?.()).rejects.toThrow(
        kind === "expired" ? "Original operator revoked" : "original authenticated caller",
      );
      expect(mocks.openRecipient).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.releaseFacts).toHaveBeenCalledOnce();
    },
  );

  it.each(["group", "public", "unknown"] as const)(
    "does not enroll a %s endpoint as private during opening",
    async (kind) => {
      const f = fixture(
        { type: "profile", id: "operator-alpha" },
        kind === "unknown" ? undefined : kind === "group" ? "group" : "direct",
      );
      if (kind === "public") {
        f.entry.publicShare = { id: "public", sessionId: f.entry.sessionId, createdAt: 1 };
      }
      await f.source.prepareConnection?.();
      expect(mocks.openRecipient).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.releaseFacts).toHaveBeenCalledOnce();
      f.closeConnection();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it("releases and refuses an opening closed while native recipient preparation awaits", async () => {
    const f = fixture({ type: "profile", id: "operator-alpha" }, "direct");
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    mocks.openRecipient.mockImplementation(async () => {
      entered.resolve();
      await finish.promise;
    });
    const preparing = f.source.prepareConnection?.();
    await entered.promise;
    f.closeConnection();
    finish.resolve();
    await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    await f.source.closeConnection?.();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.releaseFacts).toHaveBeenCalledOnce();
  });

  it("retains failed connection source cleanup and retries only unsettled native holds", async () => {
    const f = fixture({ type: "profile", id: "operator-alpha" }, "direct");
    await f.source.prepareConnection?.();
    f.release.mockImplementationOnce(() => {
      throw new Error("Source still owned");
    });
    await expect(f.source.closeConnection?.()).rejects.toThrow("cleanup remains pending");
    expect(f.releaseFacts).toHaveBeenCalledOnce();
    await f.source.closeConnection?.();
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.releaseFacts).toHaveBeenCalledOnce();
  });

  it("carries the original authenticated person through the actual native input handoff", async () => {
    const original = { type: "profile" as const, id: "operator-alpha" };
    const fixtureValue = fixture(original, "direct");
    original.id = "changed-after-source-creation";
    const admission = await fixtureValue.source.admitInput(scope);
    const input = consumeConversationInputAdmission(admission, scope);
    try {
      claimConversationInputExecution(input);
      const context = await prepareConversationReplyContext(input, { text: "Original request." });
      expect(readSessionInputProfileId(context)).toBe("operator-alpha");
      expect(input.participant?.identity).toEqual({ type: "profile", id: "operator-alpha" });
      expect(context.SessionKey).toBe(target.canonicalKey);
      expect(context.CommandInterpretationSuppressed).toBe(true);
      expect(input.assertOwnerCurrent).toBeUndefined();
      const audience = readConversationPrivateAudience({ ...context });
      expect(audience).toMatchObject({
        agentId: target.agentId,
        sessionKey: target.canonicalKey,
        participant: { type: "profile", id: "operator-alpha" },
      });
      fixtureValue.closeAudio();
      expect(() => audience?.assertCurrent()).not.toThrow();
      expect(() => input.assertCurrent()).not.toThrow();
      fixtureValue.revoke();
      expect(() => audience?.assertCurrent()).toThrow("Original operator revoked");
    } finally {
      input.release?.();
    }
    expect(fixtureValue.release).toHaveBeenCalledOnce();
    expect(fixtureValue.releaseFacts).toHaveBeenCalledOnce();
  });

  it("does not infer the speaker from operator authority when original participant evidence is absent", async () => {
    const { source } = fixture();
    const input = consumeConversationInputAdmission(await source.admitInput(scope), scope);
    try {
      claimConversationInputExecution(input);
      const context = await prepareConversationReplyContext(input, { text: "Original request." });
      expect(readSessionInputProfileId(context)).toBeUndefined();
      expect(input.participant).toBeUndefined();
      expect(readConversationPrivateAudience(context)).toBeUndefined();
    } finally {
      input.release?.();
    }
  });

  it.each(["owner", "group", "public", "unknown"] as const)(
    "does not attest a private speech recipient for %s",
    async (kind) => {
      const id = kind === "owner" ? GATEWAY_OWNER_PROFILE_ID : "operator-alpha";
      const f = fixture(
        { type: "profile", id },
        kind === "unknown" ? undefined : kind === "group" ? "group" : "direct",
        id,
      );
      if (kind === "public") {
        f.entry.publicShare = { id: "public", sessionId: f.entry.sessionId, createdAt: 1 };
      }
      const input = consumeConversationInputAdmission(await f.source.admitInput(scope), scope);
      try {
        claimConversationInputExecution(input);
        const context = await prepareConversationReplyContext(input, { text: "Original request." });
        expect(readConversationPrivateAudience(context)).toBeUndefined();
      } finally {
        input.release?.();
      }
    },
  );

  it("revokes a prepared private speech audience when native sharing changes", async () => {
    const f = fixture({ type: "profile", id: "operator-alpha" }, "direct");
    const input = consumeConversationInputAdmission(await f.source.admitInput(scope), scope);
    try {
      claimConversationInputExecution(input);
      f.closeAudio();
      const context = await prepareConversationReplyContext(input, {
        text: "Already accepted request.",
      });
      const audience = readConversationPrivateAudience(context);
      expect(audience).toBeDefined();
      f.entry.publicShare = { id: "new-share", sessionId: f.entry.sessionId, createdAt: 1 };
      expect(() => audience?.assertCurrent()).toThrow("private conversation was shared");
    } finally {
      input.release?.();
    }
  });

  it("refuses a different participant before native execution and releases original custody", async () => {
    const { source, release, releaseFacts } = fixture({ type: "profile", id: "operator-beta" });
    await expect(source.admitInput(scope)).rejects.toThrow("original authenticated caller");
    expect(release).toHaveBeenCalledOnce();
    expect(releaseFacts).toHaveBeenCalledOnce();
  });

  it("preserves an existing group without origin through native reply metadata derivation", async () => {
    const { source, entry } = fixture(undefined, "group");
    const input = consumeConversationInputAdmission(await source.admitInput(scope), scope);
    try {
      claimConversationInputExecution(input);
      const context = await prepareConversationReplyContext(input, { text: "Group request." });
      expect(context.ChatType).toBe("group");
      const patch = deriveSessionMetaPatch({
        ctx: context,
        sessionKey: target.canonicalKey,
        existing: { ...entry, updatedAt: 1 },
      });
      expect(patch?.chatType ?? entry.chatType).toBe("group");
    } finally {
      input.release?.();
    }
  });

  it("refuses a changed conversation audience before preparing native reply context", async () => {
    const { source, entry } = fixture(undefined, "group");
    const input = consumeConversationInputAdmission(await source.admitInput(scope), scope);
    try {
      claimConversationInputExecution(input);
      entry.chatType = "direct";
      await expect(
        prepareConversationReplyContext(input, { text: "Original request." }),
      ).rejects.toThrow("conversation incarnation changed");
    } finally {
      input.release?.();
    }
  });
});
