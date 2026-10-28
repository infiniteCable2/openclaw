import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { createPluginTtsRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-tts-mock.js";
import { createConversationInputAdmission } from "../talk/conversation-input-admission.js";
import type { ConversationInputSourceV1 } from "../talk/conversation-input.types.js";
import { bindAdmittedSpeechInput } from "../talk/speech/native-control.js";
import {
  createMeetingRealtimeEngineBindingsV2,
  type MeetingRealtimeBindingsV2Params,
} from "./conversation-bindings.js";

const mocks = vi.hoisted(() => ({
  getReplyFromConfig: vi.fn(),
  prepareExpression: vi.fn(),
  prepareGreeting: vi.fn(),
}));
// mock-isolation: Native model/storage execution is the boundary, not part of this host adapter test.
vi.mock("../auto-reply/reply/get-reply.js", () => ({
  getReplyFromConfig: mocks.getReplyFromConfig,
}));
// mock-isolation: No reply-operation owner is started in these adapter fixtures.
vi.mock("../auto-reply/reply/reply-operation-abort.js", () => ({
  isReplyOperationSuperseded: () => false,
}));
// mock-isolation: Readiness is explicitly controlled without loading a provider or GPU worker.
vi.mock("../tts/expression-preparation.js", () => ({
  prepareSpeechExpressionContext: mocks.prepareExpression,
}));
// mock-isolation: Greeting model execution is outside this input-admission adapter.
vi.mock("../talk/conversation-greeting.js", () => ({
  prepareConversationGreeting: mocks.prepareGreeting,
}));

function fixture() {
  let current = true;
  const release = vi.fn();
  const tts = createPluginTtsRuntimeMock();
  const ttsRelease = vi.fn(async () => {});
  vi.mocked(tts.prepareTextToSpeechTelephony).mockResolvedValue({
    success: true,
    release: ttsRelease,
  });
  const inputSource: ConversationInputSourceV1 = {
    version: 1,
    admitInput: vi.fn(async (scope) =>
      createConversationInputAdmission({
        scope,
        source: { channelId: "example", sessionKey: "agent:example:call" },
        assertCurrent() {
          if (!current) {
            throw new Error("Original source revoked");
          }
        },
        assertInputCurrent() {
          scope.signal?.throwIfAborted();
        },
        release,
        prepareContext(text) {
          return { AgentId: scope.agentId, SessionKey: "agent:example:call", Body: text };
        },
      }),
    ),
  };
  const params: MeetingRealtimeBindingsV2Params = {
    platform: {
      id: "example",
      displayName: "Example",
      logScope: "example",
      agentConsult: {
        surface: "an example call",
        userLabel: "User",
        assistantLabel: "Assistant",
        questionSourceLabel: "user",
        workingResponseLabel: "the request",
        extraSystemPrompt: "Respond naturally.",
      },
      session: { idPrefix: "example", participantIdentity: () => "example-caller" },
    },
    config: { realtime: { agentId: "example", toolPolicy: "owner", speakCommentary: true } },
    fullConfig: {},
    runtime: { tts },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    agentId: "example",
    conversationId: "example-call",
    inputSource,
    ttsContext: { agentId: "example", channelId: "example" },
    assertOutputCurrent: vi.fn(),
  };
  return {
    params,
    release,
    tts,
    ttsRelease,
    revoke: () => {
      current = false;
    },
  };
}

describe("original speech binding to native reply", () => {
  beforeEach(() => {
    mocks.getReplyFromConfig.mockReset();
    mocks.prepareExpression.mockReset().mockResolvedValue(undefined);
    mocks.prepareGreeting.mockReset().mockResolvedValue({ text: "Hello." });
  });

  it.each(["user", "greeting"] as const)(
    "settles connection enrollment before admitting a %s input",
    async (purpose) => {
      const f = fixture();
      const started = Promise.withResolvers<void>();
      const created = Promise.withResolvers<void>();
      f.params.inputSource = {
        ...f.params.inputSource,
        prepareConnection: async () => {
          started.resolve();
          await created.promise;
        },
      };
      mocks.getReplyFromConfig.mockResolvedValue({ text: "Native answer." });
      const bindings = createMeetingRealtimeEngineBindingsV2(f.params);
      const reply = bindings.nativeInput({
        sessionId: "example-call",
        inputId: "example-input",
        purpose,
        args: { question: "A question" },
        transcript: [],
        bufferReply: true,
        queueMode: "followup",
        onNativeRunBound: vi.fn(),
        onInputDisposition: vi.fn(),
        onQueueAccepted: vi.fn(),
        ...(purpose === "greeting" ? { speechExpressionCaptureOnly: true as const } : {}),
      });
      try {
        await started.promise;
        expect(f.params.inputSource.admitInput).not.toHaveBeenCalled();
        expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
        expect(mocks.prepareGreeting).not.toHaveBeenCalled();
      } finally {
        created.resolve();
        await reply;
        await bindings.connectionPreparation?.close();
      }
      expect(f.params.inputSource.admitInput).toHaveBeenCalledOnce();
      expect(
        purpose === "greeting" ? mocks.prepareGreeting : mocks.getReplyFromConfig,
      ).toHaveBeenCalledOnce();
    },
  );

  it("refuses a source revoked while connection enrollment is settling", async () => {
    const f = fixture();
    const started = Promise.withResolvers<void>();
    const created = Promise.withResolvers<void>();
    f.params.inputSource = {
      ...f.params.inputSource,
      prepareConnection: async () => {
        started.resolve();
        await created.promise;
      },
    };
    const bindings = createMeetingRealtimeEngineBindingsV2(f.params);
    const reply = bindings.consultAgent({
      meetingSessionId: "example-call",
      inputId: "example-greeting",
      purpose: "greeting",
      args: { question: "Greet briefly." },
      transcript: [],
    });
    await started.promise;
    f.revoke();
    created.resolve();
    await expect(reply).rejects.toThrow("Original source revoked");
    expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
    expect(mocks.prepareGreeting).not.toHaveBeenCalled();
    await bindings.connectionPreparation?.close();
  });

  it("starts connection preparation without waiting or admitting a synthetic input", async () => {
    const f = fixture();
    const { promise, resolve } = Promise.withResolvers<void>();
    const prepareConnection = vi.fn<NonNullable<ConversationInputSourceV1["prepareConnection"]>>(
      () => promise,
    );
    f.params.inputSource = { ...f.params.inputSource, prepareConnection };
    const bindings = createMeetingRealtimeEngineBindingsV2(f.params);
    expect(bindings.nativeInput).toBeTypeOf("function");
    await Promise.resolve();
    expect(prepareConnection).toHaveBeenCalledOnce();
    expect(f.params.inputSource.admitInput).not.toHaveBeenCalled();
    expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
    let closed = false;
    const closing = bindings.connectionPreparation?.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(prepareConnection.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
    resolve();
    await promise;
    await closing;
    expect(closed).toBe(true);
  });

  it("retries failed connection custody cleanup without restarting opening", async () => {
    const f = fixture();
    const prepareConnection = vi.fn(async () => {});
    const closeConnection = vi.fn(async () => {});
    closeConnection.mockRejectedValueOnce(new Error("Retained cleanup pending"));
    f.params.inputSource = { ...f.params.inputSource, prepareConnection, closeConnection };
    const bindings = createMeetingRealtimeEngineBindingsV2(f.params);
    await Promise.resolve();
    await expect(bindings.connectionPreparation?.close()).rejects.toThrow("cleanup pending");
    await bindings.connectionPreparation?.close();
    expect(prepareConnection).toHaveBeenCalledOnce();
    expect(closeConnection).toHaveBeenCalledTimes(2);
  });

  it("keeps preparation failure content-free and does not disable the original input source", async () => {
    const f = fixture();
    const { promise, resolve } = Promise.withResolvers<void>();
    f.params.logger.warn = vi.fn(() => resolve());
    f.params.inputSource = {
      ...f.params.inputSource,
      prepareConnection: vi.fn(async () => {
        throw new Error("sensitive source failure");
      }),
    };
    createMeetingRealtimeEngineBindingsV2(f.params);
    await promise;
    expect(f.params.logger.warn).toHaveBeenCalledExactlyOnceWith(
      "Related conversation preparation deferred at connection opening",
    );
    expect(f.params.inputSource.admitInput).not.toHaveBeenCalled();
    expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
  });

  it("uses the original host input and native queue with no task-subagent dispatch", async () => {
    const f = fixture();
    const onRunStarted = vi.fn();
    const onOriginalInputCommitted = vi.fn();
    mocks.getReplyFromConfig.mockImplementation(
      async (context, options: InternalGetReplyOptions) => {
        expect(context.SessionKey).toBe("agent:example:call");
        expect(context.Body).toBe("A question");
        expect(context.ChannelStructuredContext).toEqual([
          {
            label: "Speech input context",
            source: "speech",
            type: "media-context",
            payload: { text: "Untrusted visual source data" },
          },
        ]);
        expect(options.speechPresentation?.guidance).toContain("Speak briefly.");
        expect(options.speechPresentation?.guidance).not.toContain("Untrusted visual source data");
        expect(options.onAgentRunStart).toBe(onRunStarted);
        expect(options.onOriginalInputCommitted).toBe(onOriginalInputCommitted);
        options.assertConversationTarget?.({ agentId: "example", sessionKey: context.SessionKey });
        expect(() =>
          options.assertConversationTarget?.({
            agentId: "example",
            sessionKey: "agent:example:other",
          }),
        ).toThrow("target changed");
        expect(options.queueModeOverride).toBe("followup");
        expect(options.toolsAllow).toBeUndefined();
        expect(options.abortSignal).toBeUndefined();
        return { text: "Native answer." };
      },
    );
    const bindings = createMeetingRealtimeEngineBindingsV2(f.params);
    const onSpeakableText = vi.fn();
    expect(
      await bindings.nativeInput({
        sessionId: "example-call",
        inputId: "example-input",
        purpose: "user",
        args: {
          question: "A question",
          context: "Untrusted visual source data",
          responseStyle: "Speak briefly.",
        },
        transcript: [],
        queueMode: "followup",
        bufferReply: true,
        onNativeRunBound: vi.fn(),
        onInputDisposition: vi.fn(),
        onQueueAccepted: vi.fn(),
        onSpeakableText,
        onRunStarted,
        onOriginalInputCommitted,
      }),
    ).toEqual({ kind: "reply", reply: { text: "Native answer." } });
    expect(f.params.inputSource.admitInput).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.ttsRelease).toHaveBeenCalledOnce();
    expect(onSpeakableText).not.toHaveBeenCalled();
  });

  it.for([false, true])(
    "consumes the original Gateway control admission, revoked=%s",
    async (revoked) => {
      const f = fixture();
      const scope = {
        agentId: "example",
        conversationId: "example-call",
        inputId: "authenticated-control",
        purpose: "steering" as const,
      };
      const admission = await f.params.inputSource.admitInput(scope);
      const input = bindAdmittedSpeechInput(
        {
          sessionId: "example-call",
          inputId: scope.inputId,
          purpose: scope.purpose,
          args: { question: "An authenticated addition" },
          transcript: [],
          queueMode: "steer" as const,
          bufferReply: true,
          onNativeRunBound: vi.fn(),
          onInputDisposition: vi.fn(),
          onQueueAccepted: vi.fn(),
        },
        { admission, scope, text: "An authenticated addition", mode: "steer" },
      );
      mocks.getReplyFromConfig.mockResolvedValue({ text: "Combined answer" });
      if (revoked) {
        f.revoke();
        await expect(
          createMeetingRealtimeEngineBindingsV2(f.params).nativeInput(input),
        ).rejects.toThrow("Original source revoked");
        expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
      } else {
        await expect(
          createMeetingRealtimeEngineBindingsV2(f.params).nativeInput(input),
        ).resolves.toMatchObject({ kind: "reply" });
        expect(mocks.getReplyFromConfig).toHaveBeenCalledWith(
          expect.objectContaining({ Body: "An authenticated addition" }),
          expect.objectContaining({ queueModeOverride: "steer" }),
          f.params.fullConfig,
        );
      }
      expect(f.params.inputSource.admitInput).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it("refuses changed connection scope before acquiring provider resources", async () => {
    const f = fixture();
    const bindings = createMeetingRealtimeEngineBindingsV2(f.params);
    await expect(
      bindings.consultAgent({
        meetingSessionId: "other-call",
        args: { question: "A question" },
        transcript: [],
      }),
    ).rejects.toThrow("binding changed");
    expect(f.params.inputSource.admitInput).not.toHaveBeenCalled();
    expect(mocks.prepareExpression).not.toHaveBeenCalled();
    expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
  });

  it("does not acquire TTS or run work after original admission is revoked", async () => {
    const f = fixture();
    f.revoke();
    await expect(
      createMeetingRealtimeEngineBindingsV2(f.params).consultAgent({
        meetingSessionId: "example-call",
        args: { question: "A question" },
        transcript: [],
      }),
    ).rejects.toThrow("Original source revoked");
    expect(mocks.prepareExpression).not.toHaveBeenCalled();
    expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
  });

  it("retains accepted native work if TTS acquisition fails and cleans its resources", async () => {
    const f = fixture();
    vi.mocked(f.tts.prepareTextToSpeechTelephony).mockResolvedValue({
      success: false,
      error: "Provider unavailable",
      release: f.ttsRelease,
    });
    mocks.getReplyFromConfig.mockResolvedValue({ text: "Completed work." });
    const bindings = createMeetingRealtimeEngineBindingsV2(f.params);
    expect(
      await bindings.consultAgent({
        meetingSessionId: "example-call",
        args: { question: "A question" },
        transcript: [],
        onSpeakableText: vi.fn(),
      }),
    ).toEqual({ text: "" });
    expect(mocks.getReplyFromConfig).toHaveBeenCalledOnce();
    expect(f.ttsRelease).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
});
