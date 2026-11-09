import { describe, expect, it, vi } from "vitest";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import {
  prepareSessionParticipantInput,
  readSessionConversationParticipant,
  type SessionParticipantInputContext,
} from "../../sessions/session-participant-input.js";
import { createQueueCase } from "./queue.case.test-support.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import {
  collectRuntimeMetadata,
  createOverflowSummaryRetrySource,
  resolveFollowupAuthorizationKey,
  resolveFollowupDeliveryStorageKey,
} from "./queue/delivery-context.js";
import type { FollowupRun } from "./queue/types.js";

const person: SessionParticipantIdentity = { type: "profile", id: "example-person" };
function run(identity: SessionParticipantIdentity = person): FollowupRun {
  const context: SessionParticipantInputContext = {};
  prepareSessionParticipantInput(context, identity);
  return {
    ...createQueueTestRun({ prompt: "Original request", originatingChannel: "webchat" }),
    conversationParticipant: readSessionConversationParticipant(context),
  };
}

describe("original participant in native queued conversation work", () => {
  it("retains all private recipient lifetimes and never collects an unconfirmed destination", () => {
    const firstAssert = vi.fn();
    const secondAssert = vi.fn();
    const audience: ConversationPrivateAudience = {
      agentId: "example",
      sessionKey: "agent:example:chat",
      channelId: "example",
      accountId: "primary",
      nativeChannelId: "room",
      participant: person,
      assertCurrent: firstAssert,
    };
    const first = { ...run(), conversationAudience: audience };
    const second = { ...run(), conversationAudience: { ...audience, assertCurrent: secondAssert } };
    const metadata = collectRuntimeMetadata([first, second]);
    metadata.conversationAudience?.assertCurrent();
    expect(firstAssert).toHaveBeenCalledOnce();
    expect(secondAssert).toHaveBeenCalledOnce();
    expect(createOverflowSummaryRetrySource(first).conversationAudience).toBe(audience);
    expect(collectRuntimeMetadata([first, run()]).conversationAudience).toBeUndefined();
    expect(
      collectRuntimeMetadata([
        first,
        { ...second, conversationAudience: { ...audience, accountId: "other" } },
      ]).conversationAudience,
    ).toBeUndefined();
    expect(resolveFollowupAuthorizationKey(first)).not.toBe(resolveFollowupAuthorizationKey(run()));
  });
  it("keeps person identity in both collect authorization and overflow storage grouping", () => {
    const first = run();
    const other = run({ type: "profile", id: "other-person" });
    const absent = { ...first, conversationParticipant: undefined };
    expect(resolveFollowupAuthorizationKey(first)).not.toBe(resolveFollowupAuthorizationKey(other));
    expect(resolveFollowupDeliveryStorageKey(first)).not.toBe(
      resolveFollowupDeliveryStorageKey(other),
    );
    expect(resolveFollowupAuthorizationKey(first)).not.toBe(
      resolveFollowupAuthorizationKey(absent),
    );
  });

  it("collects only the same original person and retains every original source assertion", () => {
    const assertFirst = vi.fn();
    const assertSecond = vi.fn();
    const first = { ...run(), assertSourceCurrent: assertFirst };
    const second = { ...run(), assertSourceCurrent: assertSecond };
    const metadata = collectRuntimeMetadata([first, second]);
    expect(metadata.conversationParticipant).toEqual(person);
    expect(Object.isFrozen(metadata.conversationParticipant)).toBe(true);
    metadata.assertSourceCurrent?.();
    expect(assertFirst).toHaveBeenCalledOnce();
    expect(assertSecond).toHaveBeenCalledOnce();
    expect(metadata.operatorAuthority).toBeUndefined();
  });

  it("drops private-person eligibility for a mixed or incomplete synthetic batch", () => {
    const first = run();
    expect(collectRuntimeMetadata([]).conversationParticipant).toBeUndefined();
    expect(
      collectRuntimeMetadata([first, run({ type: "profile", id: "other-person" })])
        .conversationParticipant,
    ).toBeUndefined();
    expect(
      collectRuntimeMetadata([first, { ...first, conversationParticipant: undefined }])
        .conversationParticipant,
    ).toBeUndefined();
  });

  it("retains the exact source snapshot in compact overflow retries", () => {
    const source = run();
    const retry = createOverflowSummaryRetrySource(source);
    expect(retry.conversationParticipant).toBe(source.conversationParticipant);
    expect(retry.operatorAuthority).toBeUndefined();
  });

  it("carries the conservative original participant through the native overflow owner", async () => {
    const queue = createQueueCase({ mode: "followup", cap: 1 }, 2);
    for (const prompt of ["first request", "second request", "pending tail"]) {
      queue.add({ ...run(), prompt });
    }
    await queue.drain();
    const summary = queue.calls.find((item) => item.prompt.startsWith("[Queue overflow]"));
    expect(summary).toBeDefined();
    expect(summary?.conversationParticipant).toEqual(person);
    expect(summary?.operatorAuthority).toBeUndefined();
  });
});
