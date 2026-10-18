import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { createPluginTtsRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-tts-mock.js";
import { createConversationInputAdmission } from "../talk/conversation-input-admission.js";
import type { ConversationInputSourceV1 } from "../talk/conversation-input.types.js";
import {
  createMeetingRealtimeEngineBindingsV2,
  type MeetingRealtimeBindingsV2Params,
} from "./conversation-bindings.js";

const mocks = vi.hoisted(() => ({ getReplyFromConfig: vi.fn(), prepareExpression: vi.fn() }));
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
