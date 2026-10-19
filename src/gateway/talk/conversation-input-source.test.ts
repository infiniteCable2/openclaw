import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { ChatType } from "../../channels/chat-type.js";
import { deriveSessionMetaPatch } from "../../config/sessions/metadata.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { readConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { readSessionInputProfileId } from "../../sessions/session-participant-input.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  prepareConversationReplyContext,
} from "../../talk/conversation-input-admission.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";

const mocks = vi.hoisted(() => ({ prepareFacts: vi.fn() }));
// mock-isolation: Native row publication I/O is independent of this input handoff contract.
vi.mock("../session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: mocks.prepareFacts,
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
  const source = createGatewayTalkConversationInputSource({
    target,
    conversationId: scope.conversationId,
    getRuntimeConfig: () => ({}),
    captureOperatorAuthority: async () => ({ authority, release }),
    authority: { senderIsOwner: false },
    participant,
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
    entry,
    closeAudio: () => (audioClosed = true),
    revoke: () => (revoked = true),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("native Gateway speech participant", () => {
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
