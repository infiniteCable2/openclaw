import { describe, expect, it, vi } from "vitest";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import {
  prepareSessionParticipantInput,
  readSessionConversationParticipant,
  type SessionParticipantInputContext,
} from "../../sessions/session-participant-input.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { runSyntheticOverflowSummary } from "./queue/aggregate-run.js";
import {
  collectRuntimeMetadata,
  createOverflowSummaryRetrySource,
  resolveFollowupAuthorizationKey,
  resolveFollowupDeliveryStorageKey,
} from "./queue/delivery-context.js";
import type { FollowupRun } from "./queue/types.js";

// mock-isolation: The fixture constructor does not schedule or drain queue work.
vi.mock("./queue.js", () => ({ scheduleFollowupDrain: vi.fn() }));
// mock-isolation: The shared constructor's cleanup helper is unused in this source test.
vi.mock("./queue/drain.js", () => ({ clearFollowupDrainCallback: vi.fn() }));
// mock-isolation: The producer retains a lazy transcript target; this test never reads rows.
vi.mock("../../config/sessions.js", () => ({ resolveSessionStorePathCore: vi.fn() }));
// mock-isolation: No transcript persistence is performed; assert the actual aggregate carrier.
vi.mock("../../config/sessions/session-accessor.js", () => ({ loadSessionEntryReadOnly: vi.fn() }));
// mock-isolation: Keep the native producer, but not its unused transcript writer/worker graph.
vi.mock("../../sessions/user-turn-transcript.js", () => ({
  createUserTurnTranscriptRecorder: vi.fn(() => ({})),
}));
// mock-isolation: Hooks are passed to the unused recorder, never invoked in this carrier test.
vi.mock("../../agents/harness/hook-helpers.js", () => ({
  runAgentHarnessBeforeMessageWriteHook: vi.fn(),
}));

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

  it("carries the conservative original participant into the actual synthetic overflow producer", async () => {
    const source = run();
    const runFollowup = vi.fn<(next: FollowupRun) => Promise<void>>().mockResolvedValue();
    await runSyntheticOverflowSummary({
      source,
      sources: [source, run()],
      prompt: "Summarized original requests",
      runFollowup,
    });
    expect(runFollowup).toHaveBeenCalledOnce();
    expect(runFollowup.mock.calls[0]?.[0].conversationParticipant).toEqual(person);
    expect(runFollowup.mock.calls[0]?.[0].operatorAuthority).toBeUndefined();
  });
});
