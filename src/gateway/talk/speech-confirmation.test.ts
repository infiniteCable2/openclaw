import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserTurnOriginalInputCommit } from "../../sessions/user-turn-transcript.types.js";
import {
  checkClientVoiceToolConfirmationPolicy,
  consumeClientVoiceToolConfirmationPolicy,
  deactivateClientVoiceConfirmationSession,
} from "../../talk/client-voice-confirmation.js";
import { resetClientVoiceConfirmationStateForTest } from "../../talk/client-voice-confirmation.test-support.js";
import type { ConversationReplyResult } from "../../talk/conversation-reply.js";
import type { SpeechNativeInputParams } from "../../talk/speech/types.js";
import { createNativeSpeechConfirmation } from "./speech-confirmation.js";

const mocks = vi.hoisted(() => ({ registerRun: vi.fn() }));
// mock-isolation: Isolate durable voice-run registration; actual one-shot confirmation state stays native.
vi.mock("../../talk/client-voice-session.js", () => ({
  registerClientVoiceConsultRun: mocks.registerRun,
}));

const target = { agentId: "example", voiceSessionId: "voice-example" };
const action = { toolName: "message", toolParams: { action: "send", message: "Example message" } };
function originalCommit(text: string): UserTurnOriginalInputCommit {
  return {
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
    anchor: {
      agentId: target.agentId,
      sessionId: "native-session",
      sessionKey: "agent:example:browser-talk:example-call",
      storePath: "/fixture/example/sessions.sqlite",
      generation: "generation-original",
      entryId: "native-user-entry",
      rawSeq: 1,
      effectiveParentId: null,
      activeMessagePosition: 1,
    },
  };
}
function fixture() {
  const events: Array<{ type: string; text?: string }> = [];
  const onOutputFailure = vi.fn();
  const input: SpeechNativeInputParams = {
    sessionId: target.voiceSessionId,
    inputId: "original-input",
    purpose: "user",
    args: { question: "Send a message" },
    transcript: [],
    bufferReply: false,
    queueMode: "steer",
    onQueueAccepted: vi.fn(),
    onNativeRunBound: vi.fn(),
    onInputDisposition: vi.fn(),
    onSpeakableText: (event) => {
      events.push(event);
    },
  };
  const dispatch = vi.fn<(input: SpeechNativeInputParams) => Promise<ConversationReplyResult>>();
  const run = createNativeSpeechConfirmation({
    ...target,
    sessionKey: "agent:example:browser-talk:example-call",
    canonicalSessionKey: "agent:example:browser-talk:example-call",
    config: {},
    dispatch,
    onOutputFailure,
  });
  return { input, dispatch, events, run, onOutputFailure };
}

describe("native getReply voice confirmation presentation", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => resetClientVoiceConfirmationStateForTest());

  it.each([false, true])(
    "keeps early commentary but replaces blocked-action narration once (partial=%s)",
    async (partial) => {
      const f = fixture();
      f.dispatch.mockImplementation(async (input) => {
        input.onOriginalInputCommitted?.(originalCommit("Send a message"));
        input.onRunStarted?.("actual-native-run");
        if (partial) {
          await input.onSpeakableText?.({ type: "chunk", text: "Checking." });
        }
        expect(
          checkClientVoiceToolConfirmationPolicy({
            ...target,
            ...action,
            runId: "actual-native-run",
          }).allowed,
        ).toBe(false);
        await input.onSpeakableText?.({ type: "chunk", text: "The message was sent." });
        await input.onSpeakableText?.({ type: "done", text: "The message was sent." });
        return { kind: "reply", reply: { text: "The message was sent.", delivered: true } };
      });
      const result = await f.run(f.input);
      expect(mocks.registerRun).toHaveBeenCalledWith(
        expect.objectContaining({ ...target, runId: "actual-native-run" }),
      );
      expect(result.kind).toBe("reply");
      if (result.kind !== "reply") {
        throw new Error("Expected the actual native reply");
      }
      expect(result.reply.text).toContain("has not run");
      expect(result.reply.utterances).toBeUndefined();
      expect(f.events.filter((event) => event.type === "done")).toHaveLength(1);
      expect(f.events.filter((event) => event.type === "chunk")).toEqual([
        ...(partial ? [{ type: "chunk", text: "Checking." }] : []),
        { type: "chunk", text: result.reply.text },
      ]);
    },
  );

  it.each(["commit-first", "run-first"])(
    "binds a persisted affirmative only after both native facts (%s)",
    async (order) => {
      const f = fixture();
      const now = Date.now() - 20;
      expect(
        checkClientVoiceToolConfirmationPolicy({ ...target, ...action, runId: "blocked-run", now })
          .allowed,
      ).toBe(false);
      f.input.args = { question: "yes" };
      f.dispatch.mockImplementation(async (input) => {
        expect(input.queueMode).toBe("followup");
        if (order === "commit-first") {
          input.onOriginalInputCommitted?.(originalCommit("yes"));
        } else {
          input.onRunStarted?.("actual-approved-run");
        }
        expect(
          checkClientVoiceToolConfirmationPolicy({
            ...target,
            ...action,
            runId: "actual-approved-run",
          }).allowed,
        ).toBe(false);
        if (order === "commit-first") {
          input.onRunStarted?.("actual-approved-run");
        } else {
          input.onOriginalInputCommitted?.(originalCommit("yes"));
        }
        expect(
          consumeClientVoiceToolConfirmationPolicy({
            ...target,
            ...action,
            runId: "actual-approved-run",
          }).allowed,
        ).toBe(true);
        expect(
          consumeClientVoiceToolConfirmationPolicy({
            ...target,
            ...action,
            runId: "actual-approved-run",
          }).allowed,
        ).toBe(false);
        return { kind: "reply", reply: { text: "Done." } };
      });
      await f.run(f.input);
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(mocks.registerRun).toHaveBeenCalledOnce();
    },
  );

  it("does not interpret an unpersisted yes as authority or retarget a native steer", async () => {
    const f = fixture();
    f.input.args = { question: "yes" };
    f.dispatch.mockImplementation(async (input) => {
      expect(input.queueMode).toBe("steer");
      return { kind: "steered" };
    });
    await expect(f.run(f.input)).resolves.toEqual({ kind: "steered" });
    expect(mocks.registerRun).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });

  it.each(["before-commit", "before-run"])(
    "keeps accepted work after close without resurrecting an unbound confirmation (%s)",
    async (closeAt) => {
      const f = fixture();
      checkClientVoiceToolConfirmationPolicy({
        ...target,
        ...action,
        runId: "blocked-run",
        now: Date.now() - 20,
      });
      f.input.args = { question: "yes" };
      f.dispatch.mockImplementation(async (input) => {
        const close = () =>
          deactivateClientVoiceConfirmationSession(target.agentId, target.voiceSessionId);
        if (closeAt === "before-commit") {
          close();
        }
        input.onOriginalInputCommitted?.(originalCommit("yes"));
        if (closeAt === "before-run") {
          close();
        }
        input.onRunStarted?.("accepted-after-close");
        expect(() => input.assertWorkCurrent?.()).not.toThrow();
        expect(
          consumeClientVoiceToolConfirmationPolicy({
            ...target,
            ...action,
            runId: "accepted-after-close",
          }).allowed,
        ).toBe(false);
        return { kind: "reply", reply: { text: "Native work completed" } };
      });
      await expect(f.run(f.input)).resolves.toEqual({ kind: "reply", reply: { text: "" } });
      expect(mocks.registerRun).toHaveBeenCalledOnce();
      expect(f.dispatch).toHaveBeenCalledOnce();
    },
  );

  it("requires this input's original native commit even when the model says yes to a pending action", async () => {
    const f = fixture();
    checkClientVoiceToolConfirmationPolicy({
      ...target,
      ...action,
      runId: "blocked-run",
      now: Date.now() - 20,
    });
    f.input.args = { question: "yes" };
    f.dispatch.mockImplementation(async (input) => {
      expect(input.queueMode).toBe("followup");
      input.onRunStarted?.("uncommitted-run");
      expect(
        consumeClientVoiceToolConfirmationPolicy({ ...target, ...action, runId: "uncommitted-run" })
          .allowed,
      ).toBe(false);
      await input.onSpeakableText?.({ type: "done", text: "Not authoritative" });
      return { kind: "reply", reply: { text: "Not authoritative" } };
    });
    await f.run(f.input);
    expect(f.events.at(-1)?.text).toContain("has not run");
  });

  it("does not invent a voice run when native work terminates before model admission", async () => {
    const f = fixture();
    f.dispatch.mockResolvedValue({ kind: "reply", reply: { text: "Native shortcut" } });
    await expect(f.run(f.input)).resolves.toEqual({
      kind: "reply",
      reply: { text: "Native shortcut" },
    });
    expect(mocks.registerRun).not.toHaveBeenCalled();
  });

  it("keeps native run registration failure before tools instead of silently bypassing the gate", async () => {
    const f = fixture();
    const execute = vi.fn();
    mocks.registerRun.mockImplementationOnce(() => {
      throw new Error("voice source unavailable");
    });
    f.dispatch.mockImplementation(async (input) => {
      expect(() => input.onRunStarted?.("actual-native-run")).toThrow("voice source unavailable");
      // A native fallback can swallow an observer failure; its retained work
      // source must still refuse the next tool/model attempt.
      input.assertWorkCurrent?.();
      execute();
      return { kind: "reply", reply: { text: "Never reached" } };
    });
    await expect(f.run(f.input)).rejects.toThrow("voice source unavailable");
    expect(execute).not.toHaveBeenCalled();
  });

  it("retains a failed host registration even when it throws a falsy value", async () => {
    const f = fixture();
    mocks.registerRun.mockImplementationOnce(() => {
      // oxlint-disable-next-line typescript/only-throw-error -- This regression must reject a genuinely falsy thrown value, not an Error substitute.
      throw undefined;
    });
    f.dispatch.mockImplementation(async (input) => {
      try {
        input.onRunStarted?.("actual-native-run");
      } catch {
        /* Native observer classified it. */
      }
      let refused = false;
      try {
        input.assertWorkCurrent?.();
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      return { kind: "reply", reply: { text: "No retry" } };
    });
    await f.run(f.input);
  });

  it("treats challenge output failure as output-only and never retries completed native work", async () => {
    const f = fixture();
    f.input.onSpeakableText = () => {
      throw new Error("output closed");
    };
    f.dispatch.mockImplementation(async (input) => {
      input.onRunStarted?.("actual-native-run");
      checkClientVoiceToolConfirmationPolicy({ ...target, ...action, runId: "actual-native-run" });
      // The native presentation owner classifies sink failure independently
      // from the already completed model/tool work.
      await expect(
        input.onSpeakableText?.({ type: "done", text: "Untrusted claim" }),
      ).rejects.toThrow("output closed");
      return { kind: "reply", reply: { text: "Untrusted claim" } };
    });
    await expect(f.run(f.input)).resolves.toEqual({ kind: "reply", reply: { text: "" } });
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.onOutputFailure).toHaveBeenCalledOnce();
  });
});
