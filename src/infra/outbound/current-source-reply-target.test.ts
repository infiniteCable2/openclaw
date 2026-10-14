import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import {
  deliverToCurrentSourceReplyTarget,
  isImplicitCurrentSourceSend,
} from "./current-source-reply-target.js";
import type { MessageActionInput } from "./message-action-contracts.js";

function input(): MessageActionInput {
  return {
    cfg: {},
    action: "send",
    runId: "test-run",
    sessionId: "test-session",
    params: {
      message: "A sentence.",
      voiceText: "A sentence.",
      voiceExpression: { emotion: "joyful", parts: [{ text: "A sentence." }] },
    },
    currentSourceReplyTarget: {
      runId: "test-run",
      sessionId: "test-session",
      assertCurrent: vi.fn(),
      speechUtteranceOnly: true,
      deliver: vi.fn(async () => {}),
    },
  };
}

describe("native current-source reply custody", () => {
  it("keeps every explicit external route outside the source sink", () => {
    expect(isImplicitCurrentSourceSend("send", { message: "Hello" })).toBe(true);
    for (const route of [
      { channel: "matrix" },
      { target: "room:example" },
      { threadId: 4 },
      { accountId: "example" },
      { targets: [] },
    ]) {
      expect(isImplicitCurrentSourceSend("send", route)).toBe(false);
    }
    expect(isImplicitCurrentSourceSend("poll", {})).toBe(false);
  });

  it("hands exact canonical facts to the target without claiming playback", async () => {
    const call = input();
    call.sourceReplyFinal = false;
    const result = await deliverToCurrentSourceReplyTarget(call);
    expect(result.handledBy).toBe("current-source");
    const deliver = vi.mocked(call.currentSourceReplyTarget!.deliver);
    const [payload, context] = expectDefined(deliver.mock.calls[0], "expected source handoff");
    expect(context).toMatchObject({ final: false, phase: "final_answer" });
    expect(getReplyPayloadMetadata(payload)?.tts?.expression).toEqual(call.params.voiceExpression);
    expect(result.payload).not.toHaveProperty("audible");
  });

  it.each([true, false])(
    "accepts ordinary source speech with voiceText=%s and no expression",
    async (voiceText) => {
      const call = input();
      delete call.params.voiceExpression;
      if (!voiceText) delete call.params.voiceText;
      await deliverToCurrentSourceReplyTarget(call);
      const deliver = vi.mocked(call.currentSourceReplyTarget!.deliver);
      expect(deliver).toHaveBeenCalledOnce();
      const [payload] = expectDefined(deliver.mock.calls[0], "expected plain source handoff");
      expect(payload.text).toBe("A sentence.");
      expect(getReplyPayloadMetadata(payload)?.tts?.expression).toBeUndefined();
    },
  );

  it("rejects malformed expression, mismatched bytes and foreign run owners before handoff", async () => {
    for (const mutation of [
      (call: MessageActionInput) => {
        call.params.voiceExpression = { parts: [{ text: "Changed." }] };
      },
      (call: MessageActionInput) => {
        call.params.voiceText = "Changed.";
      },
      (call: MessageActionInput) => {
        call.runId = "another-run";
      },
      (call: MessageActionInput) => {
        call.params.voiceProvider = "another-provider";
      },
    ]) {
      const call = input();
      mutation(call);
      await expect(deliverToCurrentSourceReplyTarget(call)).rejects.toThrow();
      expect(call.currentSourceReplyTarget!.deliver).not.toHaveBeenCalled();
    }
  });

  it("fences a target revoked while its handoff is pending", async () => {
    const call = input();
    let current = true;
    call.currentSourceReplyTarget!.assertCurrent = () => {
      if (!current) {
        throw new Error("retired");
      }
    };
    call.currentSourceReplyTarget!.deliver = async () => {
      current = false;
    };
    await expect(deliverToCurrentSourceReplyTarget(call)).rejects.toThrow("retired");
  });

  it("does not hand off dry runs or let commentary complete an answer", async () => {
    const call = input();
    call.dryRun = true;
    await deliverToCurrentSourceReplyTarget(call);
    expect(call.currentSourceReplyTarget!.deliver).not.toHaveBeenCalled();
    call.dryRun = false;
    call.currentSourceReplyPhase = "commentary";
    await expect(deliverToCurrentSourceReplyTarget(call)).rejects.toThrow("Commentary");
  });
});
