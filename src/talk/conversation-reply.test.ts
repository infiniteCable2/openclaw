import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { REPLY_OPERATION_RUN_STATE } from "../auto-reply/reply/reply-operation-run-state.js";
import type { MsgContext } from "../auto-reply/templating.js";
import {
  consumeConversationInputAdmission,
  createConversationInputAdmission,
} from "./conversation-input-admission.js";
import type { ConversationInputScopeV1 } from "./conversation-input.types.js";
import { replyToConversationInput } from "./conversation-reply.js";

const mocks = vi.hoisted(() => ({ getReplyFromConfig: vi.fn(), prepareGreeting: vi.fn() }));
// mock-isolation: The existing native reply owner is the boundary; do not start models or storage.
vi.mock("../auto-reply/reply/get-reply.js", () => mocks);
// mock-isolation: The auxiliary owner has its own detached-run tests, not a user-turn dispatcher.
vi.mock("./conversation-greeting.js", () => ({
  prepareConversationGreeting: mocks.prepareGreeting,
}));
// mock-isolation: No test here has an operation owner; avoid unrelated provider fallback bootstrap.
vi.mock("../auto-reply/reply/reply-operation-abort.js", () => ({
  isReplyOperationSuperseded: () => false,
}));

function setup(purpose: ConversationInputScopeV1["purpose"] = "user") {
  const source = { current: true };
  const output = { current: true };
  const scope: ConversationInputScopeV1 = {
    agentId: "example-agent",
    conversationId: "example-call",
    inputId: "example-input",
    purpose,
  };
  const context: MsgContext = {
    AgentId: scope.agentId,
    Body: "Original speech",
    SessionKey: "agent:example-agent:call",
  };
  const prepareContext = vi.fn(() => context);
  const assertCurrent = vi.fn(() => {
    if (!source.current) throw new Error("Original source unavailable");
  });
  const release = vi.fn();
  const admission = createConversationInputAdmission({
    scope,
    source: { channelId: "example-channel", sessionKey: "agent:example-agent:call" },
    prepareContext,
    assertCurrent,
    assertInputCurrent: assertCurrent,
    release,
  });
  const onError = vi.fn();
  const onSpeakableText = vi.fn();
  const params = {
    cfg: {},
    admission,
    scope,
    text: "Original speech",
    speech: {
      assertOutputCurrent() {
        if (!output.current) throw new Error("Audio output closed");
      },
      onSpeakableText,
      speakCommentary: true,
      onError,
      logger: { warn: vi.fn() },
    },
  };
  return {
    params,
    scope,
    context,
    source,
    output,
    assertCurrent,
    prepareContext,
    onError,
    release,
  };
}

async function present(options: InternalGetReplyOptions, text = "A complete answer.") {
  const source = options.speechPresentation!;
  const run = source.openRun({
    runId: "actual-native-run",
    sessionId: "actual-native-session",
    abortSignal: new AbortController().signal,
    assertCurrent: options.assertSourceCurrent!,
  });
  try {
    await run.onBlockReply({ text });
    await run.finish({ payloads: [{ text }], meta: { durationMs: 1 } });
  } catch (error) {
    // Match the native presentation owner's non-retrying output failure boundary.
    source.onError(error);
    await run.abort();
  } finally {
    await run.close();
  }
}

describe("original conversation input through native reply", () => {
  beforeEach(() => {
    mocks.getReplyFromConfig.mockReset();
    mocks.prepareGreeting.mockReset();
  });

  it("claims the real original input once and uses only the native reply owner", async () => {
    const fixture = setup();
    const toolBindings = { liveVideo: { assertCurrent: vi.fn() } };
    const onOriginalInputCommitted = vi.fn();
    const runtimeContext = [{ label: "Source data", payload: { text: "Untrusted input" } }];
    mocks.getReplyFromConfig.mockImplementation(async (_context, options) => {
      await present(options);
      return { text: "A complete answer." };
    });
    const result = await replyToConversationInput({
      ...fixture.params,
      toolBindings,
      thinkingLevelOverride: "off",
      onOriginalInputCommitted,
      runtimeContext,
    });
    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: "A complete answer.", delivered: true },
    });
    expect(fixture.prepareContext).toHaveBeenCalledExactlyOnceWith("Original speech");
    expect(fixture.context.GatewayRunToolBindings).toBe(toolBindings);
    expect(fixture.context.ChannelStructuredContext).toEqual(runtimeContext);
    expect(fixture.context.ChannelStructuredContext).not.toBe(runtimeContext);
    expect(mocks.getReplyFromConfig).toHaveBeenCalledExactlyOnceWith(
      fixture.context,
      expect.objectContaining({
        assertSourceCurrent: expect.any(Function),
        speechPresentation: expect.any(Object),
        suppressTyping: true,
        thinkingLevelOverride: "off",
        onOriginalInputCommitted,
      }),
      fixture.params.cfg,
    );
    await expect(replyToConversationInput(fixture.params)).rejects.toThrow("admission");
    expect(mocks.getReplyFromConfig).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("retains a host failure fence alongside original authority across native fallback", async () => {
    const fixture = setup();
    let failed = false;
    mocks.getReplyFromConfig.mockImplementation(
      async (_context, options: InternalGetReplyOptions) => {
        options.assertSourceCurrent?.();
        failed = true;
        expect(() => options.assertSourceCurrent?.()).toThrow("Host work source failed");
        throw new Error("Host work source failed");
      },
    );
    await expect(
      replyToConversationInput({
        ...fixture.params,
        assertWorkCurrent: () => {
          if (failed) throw new Error("Host work source failed");
        },
      }),
    ).rejects.toThrow("Host work source failed");
    expect(fixture.assertCurrent).toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("waits for queued native completion, not dispatch return or presentation finish", async () => {
    const fixture = setup();
    const entered = createDeferred();
    let retained: InternalGetReplyOptions | undefined;
    mocks.getReplyFromConfig.mockImplementation(async (_context, options) => {
      retained = options;
      options.turnAdoptionLifecycle.onDeferred();
      entered.resolve();
      return undefined;
    });
    let settled = false;
    const result = replyToConversationInput(fixture.params).finally(() => {
      settled = true;
    });
    await entered.promise;
    expect(settled).toBe(false);
    expect(fixture.release).not.toHaveBeenCalled();
    await present(retained!);
    expect(settled).toBe(false);
    expect(retained!.onQueuedFollowupReplyBatch!.ownsCompletion?.("example-channel")).toBe(true);
    await retained!.onQueuedFollowupReplyBatch!({
      kind: "queued-followup",
      runId: "actual-native-run",
      originatingChannel: "example-channel",
      payloads: [{ text: "A complete answer." }],
      completion: { kind: "completed" },
    });
    expect(await result).toMatchObject({
      kind: "reply",
      reply: { text: "A complete answer.", delivered: true },
    });
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("releases the original authority hold when context projection fails before native work", async () => {
    const fixture = setup();
    fixture.prepareContext.mockImplementation(() => {
      throw new Error("Source projection failed");
    });
    await expect(replyToConversationInput(fixture.params)).rejects.toThrow(
      "Source projection failed",
    );
    expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("settles pre-adoption refusal without inventing a delivery batch", async () => {
    const fixture = setup();
    mocks.getReplyFromConfig.mockImplementation(async (_context, options) => {
      options.turnAdoptionLifecycle.onDeferred();
      options.turnAdoptionLifecycle.onAbandoned();
      return undefined;
    });
    await expect(replyToConversationInput(fixture.params)).rejects.toThrow("abandoned");
  });

  it("does not replay output or committed work after the audio target closes", async () => {
    const fixture = setup();
    mocks.getReplyFromConfig.mockImplementation(async (_context, options) => {
      fixture.output.current = false;
      expect(options.abortSignal).toBeUndefined();
      options.assertSourceCurrent();
      await present(options);
      return { text: "Already completed work." };
    });
    expect(await replyToConversationInput(fixture.params)).toEqual({
      kind: "reply",
      reply: { text: "" },
    });
    expect(fixture.onError).toHaveBeenCalledOnce();
    expect(mocks.getReplyFromConfig).toHaveBeenCalledOnce();
  });

  it("retains native immediate visible results without speaking reasoning or errors", async () => {
    const fixture = setup();
    const payloads: ReplyPayload[] = [
      { text: "Hidden reasoning", isReasoning: true },
      { text: "Failure diagnostic", isError: true },
      { text: "Progress only", isCommentary: true },
      { text: "NO_REPLY" },
      { text: "Visible native command result." },
    ];
    mocks.getReplyFromConfig.mockResolvedValue(payloads);
    expect(await replyToConversationInput(fixture.params)).toEqual({
      kind: "reply",
      reply: { text: "Visible native command result." },
    });
  });

  it("waits for foreground dispatch when its lifecycle settles before return", async () => {
    const fixture = setup();
    const released = createDeferred();
    const finished = createDeferred();
    mocks.getReplyFromConfig.mockImplementation(async (_context, options) => {
      options.turnAdoptionLifecycle.onSettled();
      released.resolve();
      await finished.promise;
      return { text: "Foreground result." };
    });
    let settled = false;
    const result = replyToConversationInput(fixture.params).finally(() => {
      settled = true;
    });
    await released.promise;
    expect(settled).toBe(false);
    finished.resolve();
    expect(await result).toEqual({ kind: "reply", reply: { text: "Foreground result." } });
  });

  it("reports committed native steering as input adoption, never a second delivered reply", async () => {
    const fixture = setup("steering");
    mocks.getReplyFromConfig.mockImplementation(async (_context, options) => {
      options.turnAdoptionLifecycle.onDeferred();
      options[REPLY_OPERATION_RUN_STATE].admission = { status: "accepted", mode: "steer" };
      options.turnAdoptionLifecycle.onSettled();
      return undefined;
    });
    expect(await replyToConversationInput(fixture.params)).toEqual({ kind: "steered" });
    expect(fixture.params.speech.onSpeakableText).not.toHaveBeenCalled();
  });

  it.each(["indeterminate", "aborted"] as const)(
    "does not turn %s native injection into successful steering",
    async (outcome) => {
      const fixture = setup("steering");
      mocks.getReplyFromConfig.mockImplementation(async (_context, options) => {
        options.turnAdoptionLifecycle.onDeferred();
        options[REPLY_OPERATION_RUN_STATE].admission =
          outcome === "indeterminate"
            ? { status: "skipped", reason: "question-response-indeterminate" }
            : { status: "accepted", mode: "steer" };
        options.turnAdoptionLifecycle.onSettled();
        if (outcome === "aborted")
          options[REPLY_OPERATION_RUN_STATE].messageInjectionAborted = true;
        return undefined;
      });
      await expect(replyToConversationInput(fixture.params)).rejects.toThrow("completion receipt");
    },
  );

  it("fails before context or model preparation when the original source is unavailable", async () => {
    const fixture = setup();
    fixture.source.current = false;
    await expect(replyToConversationInput(fixture.params)).rejects.toThrow("unavailable");
    expect(fixture.prepareContext).not.toHaveBeenCalled();
    expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
  });

  it("prepares an unplayed greeting through the auxiliary owner, never the normal user-turn path", async () => {
    const fixture = setup("greeting");
    mocks.prepareGreeting.mockResolvedValue({ text: "Hello!" });
    expect(await replyToConversationInput(fixture.params)).toEqual({
      kind: "reply",
      reply: { text: "Hello!" },
    });
    expect(fixture.prepareContext).toHaveBeenCalledOnce();
    expect(mocks.prepareGreeting).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ scope: fixture.scope }),
        context: fixture.context,
        text: "Original speech",
      }),
    );
    expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
  });

  it("acquires speech only after original admission, and releases it after queued work settles", async () => {
    const fixture = setup();
    const queued = createDeferred();
    let options: InternalGetReplyOptions | undefined;
    const release = vi.fn(async () => {});
    const prepareSpeech = vi.fn(async () => {
      expect(fixture.prepareContext).toHaveBeenCalledOnce();
      expect(() =>
        consumeConversationInputAdmission(fixture.params.admission, fixture.scope),
      ).toThrow();
      return { presentation: fixture.params.speech, release };
    });
    mocks.getReplyFromConfig.mockImplementation(async (_context, opts) => {
      options = opts;
      opts.turnAdoptionLifecycle.onDeferred();
      queued.resolve();
      return undefined;
    });
    const result = replyToConversationInput({ ...fixture.params, prepareSpeech });
    await queued.promise;
    expect(release).not.toHaveBeenCalled();
    await options!.onQueuedFollowupReplyBatch!({
      kind: "queued-followup",
      runId: "actual-run",
      originatingChannel: "example-channel",
      payloads: [{ text: "Completed later." }],
      completion: { kind: "completed" },
    });
    expect(await result).toEqual({ kind: "reply", reply: { text: "Completed later." } });
    expect(prepareSpeech).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("retains accepted work with quiet speech and the original model profile when preparation fails", async () => {
    const fixture = setup();
    const profile = { kind: "speech" as const, channelId: "example-channel" };
    const prepareSpeech = vi.fn(async () => {
      throw new Error("Output unavailable");
    });
    mocks.getReplyFromConfig.mockImplementation(async (_context, options) => {
      expect(options.speechPresentation.modelRequestProfile).toBe(profile);
      await present(options);
      return { text: "Completed work." };
    });
    expect(
      await replyToConversationInput({
        ...fixture.params,
        speech: { ...fixture.params.speech, modelRequestProfile: profile },
        prepareSpeech,
      }),
    ).toEqual({ kind: "reply", reply: { text: "" } });
    expect(fixture.onError).toHaveBeenCalledOnce();
    expect(fixture.params.speech.onSpeakableText).not.toHaveBeenCalled();
    expect(mocks.getReplyFromConfig).toHaveBeenCalledOnce();
  });

  it("does not convert a preparer-time permission revocation into quiet model execution", async () => {
    const fixture = setup();
    const release = vi.fn();
    await expect(
      replyToConversationInput({
        ...fixture.params,
        prepareSpeech: async () => {
          fixture.source.current = false;
          return { presentation: fixture.params.speech, release };
        },
      }),
    ).rejects.toThrow("Original source unavailable");
    expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not claim greeting readiness when speech preparation fails", async () => {
    const fixture = setup("greeting");
    await expect(
      replyToConversationInput({
        ...fixture.params,
        prepareSpeech: async () => {
          throw new Error("No speech output");
        },
      }),
    ).rejects.toThrow("Greeting speech preparation is unavailable");
    expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
    expect(mocks.prepareGreeting).not.toHaveBeenCalled();
  });

  it("publishes the committed steer only after native dispatch returns", async () => {
    const fixture = setup("steering");
    const onInputDisposition = vi.fn();
    mocks.getReplyFromConfig.mockImplementation(async (_context, options) => {
      options.turnAdoptionLifecycle.onDeferred();
      options[REPLY_OPERATION_RUN_STATE].admission = { status: "accepted", mode: "steer" };
      options.turnAdoptionLifecycle.onSettled();
      expect(onInputDisposition).not.toHaveBeenCalled();
      options[REPLY_OPERATION_RUN_STATE].steeredRunId = "exact-active-run";
      return undefined;
    });
    expect(await replyToConversationInput({ ...fixture.params, onInputDisposition })).toEqual({
      kind: "steered",
    });
    expect(onInputDisposition).toHaveBeenCalledExactlyOnceWith({
      mode: "steer",
      committed: true,
      runId: "exact-active-run",
    });
  });

  it("binds the actual native run, not the early dispatch callback, without observer-triggered replay", async () => {
    const fixture = setup();
    const onNativeRunBound = vi.fn(() => {
      throw new Error("Observer failed");
    });
    const onInputDisposition = vi.fn();
    mocks.getReplyFromConfig.mockImplementation(async (_context, options) => {
      expect(onNativeRunBound).not.toHaveBeenCalled();
      await present(options);
      return { text: "A complete answer." };
    });
    expect(
      await replyToConversationInput({ ...fixture.params, onInputDisposition, onNativeRunBound }),
    ).toMatchObject({
      kind: "reply",
      reply: { text: "A complete answer.", delivered: true },
    });
    expect(onNativeRunBound).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "actual-native-run" }),
    );
    expect(onInputDisposition).toHaveBeenCalledExactlyOnceWith({ mode: "owned", committed: true });
    expect(fixture.onError).toHaveBeenCalledOnce();
    expect(mocks.getReplyFromConfig).toHaveBeenCalledOnce();
  });

  it("does not downgrade an already executing queued run back to followup acceptance", async () => {
    const fixture = setup();
    const onInputDisposition = vi.fn();
    mocks.getReplyFromConfig.mockImplementation(async (_context, options) => {
      options.turnAdoptionLifecycle.onDeferred();
      options[REPLY_OPERATION_RUN_STATE].admission = { status: "accepted", mode: "followup" };
      await present(options);
      await options.onQueuedFollowupReplyBatch({
        kind: "queued-followup",
        runId: "actual-native-run",
        originatingChannel: "example-channel",
        payloads: [{ text: "A complete answer." }],
        completion: { kind: "completed" },
      });
      return undefined;
    });
    await replyToConversationInput({ ...fixture.params, onInputDisposition });
    expect(onInputDisposition).toHaveBeenCalledExactlyOnceWith({ mode: "owned", committed: true });
  });
});
