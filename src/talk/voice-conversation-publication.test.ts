import { describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { prepareVoiceConversationPublication } from "./voice-conversation-publication.js";

const entry: InternalSessionEntry = {
  sessionId: "voice-session",
  updatedAt: 1,
  lifecycleRevision: "source-life",
  conversationTopology: {
    version: 1,
    role: "branch",
    rootSessionKey: "agent:example:internal:conversation-root",
    rootSessionId: "root-session",
    rootSessionLifecycleRevision: "root-life",
  },
};
const participant = { type: "profile" as const, id: "example-person" };
const source = { agentId: "example", sessionKey: "agent:example:voice" };
const assertCurrent = () => {};

describe("voice publication original commit intent", () => {
  it.each(["user", "assistant"] as const)(
    "captures %s observation and exact original recipient before the anchor exists",
    (role) => {
      let current = true;
      const recipient = { ...participant };
      const prepared = prepareVoiceConversationPublication({
        ...source,
        entry,
        sourceMode: "branches",
        role,
        participant,
        destinationAudience: {
          ...source,
          participant: recipient,
          channelId: "webchat",
          accountId: "default",
          nativeChannelId: "original-call",
          assertCurrent() {
            if (!current) {
              throw new Error("Recipient revoked");
            }
          },
        },
        assertCurrent,
      });
      expect(prepared?.intent).toMatchObject({
        kind: "utterance-observation",
        role,
        sourceMode: "branches",
        source: { sessionKey: source.sessionKey, sessionId: entry.sessionId },
        privateAudience: { participant, admission: "self" },
      });
      expect(prepared?.intent).not.toHaveProperty("runId");
      recipient.id = "replacement-person";
      expect(prepared?.intent.privateAudience?.participant).toEqual(participant);
      current = false;
      expect(() => prepared?.assertCurrent()).toThrow("Recipient revoked");
    },
  );

  it("retains enrolled native provenance and does not invent private proof for another speaker", () => {
    const audienceCheck = vi.fn();
    const prepared = prepareVoiceConversationPublication({
      ...source,
      entry,
      sourceMode: "native",
      role: "user",
      participant: { ...participant, id: "other-person" },
      destinationAudience: {
        ...source,
        participant,
        channelId: "webchat",
        accountId: "default",
        nativeChannelId: "original-call",
        assertCurrent: audienceCheck,
      },
      assertCurrent,
    });
    expect(prepared?.intent.sourceMode).toBe("native");
    expect(prepared?.intent.privateAudience).toBeUndefined();
    expect(audienceCheck).not.toHaveBeenCalled();
  });

  it.each([
    { ...entry, conversationTopology: undefined },
    { ...entry, lifecycleRevision: undefined },
    { ...entry, incognito: true },
  ] satisfies InternalSessionEntry[])(
    "does not enroll or publish ineligible sources",
    (ineligible) => {
      expect(
        prepareVoiceConversationPublication({
          ...source,
          entry: ineligible,
          sourceMode: "branches",
          role: "user",
          assertCurrent,
        }),
      ).toBeUndefined();
    },
  );
});
