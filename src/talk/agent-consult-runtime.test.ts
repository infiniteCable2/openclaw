import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { consultRealtimeVoiceAgent } from "./agent-consult-runtime.js";
import {
  createAgentRuntime,
  requireEmbeddedAgentCall,
  sessionForkMocks,
  testTempPath,
  useConsultRuntimeTestHooks,
  type ForkSessionEntryFromParentParams,
  type ForkSessionEntryFromParentResult,
} from "./agent-consult-runtime.test-support.js";
import { checkClientVoiceToolConfirmationPolicy } from "./client-voice-confirmation.js";
import {
  createOrResumeClientVoiceSession,
  isClientVoiceSessionConfirmable,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "./client-voice-session.js";
type ConsultParams = Parameters<typeof consultRealtimeVoiceAgent>[0];
type RequiredConsultParams = "agentRuntime" | "sessionKey" | "runIdPrefix" | "args";

function runConsult(
  params: Pick<ConsultParams, RequiredConsultParams> &
    Partial<Omit<ConsultParams, RequiredConsultParams>>,
) {
  return consultRealtimeVoiceAgent({
    cfg: {},
    logger: { warn: vi.fn() },
    messageProvider: "voice",
    lane: "voice",
    transcript: [],
    surface: "a live phone call",
    userLabel: "Caller",
    ...params,
  });
}

function expectPositiveTimestamp(value: unknown) {
  expect(typeof value).toBe("number");
  expect(value as number).toBeGreaterThan(0);
}

function expectNonEmptyString(value: unknown) {
  expect(typeof value).toBe("string");
  expect((value as string).trim()).not.toBe("");
}

describe("realtime voice agent consult runtime", () => {
  useConsultRuntimeTestHooks();

  it("does not start a consult after its caller has closed", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const controller = new AbortController();
    controller.abort(new Error("voice session closed"));

    await expect(
      runConsult({
        agentRuntime: runtime as never,
        sessionKey: "voice:closed",
        runIdPrefix: "voice-realtime-consult:closed",
        args: { question: "Do work" },
        surface: "a live voice session",
        userLabel: "User",
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("voice session closed");
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("binds GPT-Live delegated runs to spoken confirmation until completion", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const started = createDeferred();
    const release = createDeferred();
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      transcriptCapable: true,
      voiceSessionId: "voice-gpt-live",
    });
    let runId: string | undefined;
    runEmbeddedAgent.mockImplementationOnce(async (params?: RunEmbeddedAgentParams) => {
      if (!params) {
        throw new Error("Expected embedded agent params");
      }
      const binding = resolveClientVoiceRunBinding(params.runId);
      expect(binding).toMatchObject({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
      });
      expect(
        checkClientVoiceToolConfirmationPolicy({
          agentId: binding?.agentId,
          voiceSessionId: binding?.voiceSessionId,
          runId: params.runId,
          toolName: "message",
          toolParams: { action: "send", message: "Ship it" },
          isConfirmable: () => Boolean(binding && isClientVoiceSessionConfirmable(binding)),
        }),
      ).toMatchObject({ allowed: false });
      started.resolve();
      await release.promise;
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        runId: params.runId,
        durationMs: 5,
        outcome: "completed",
      });
      return { payloads: [{ text: "Done." }], meta: {} };
    });

    const consult = runConsult({
      agentRuntime: runtime as never,
      agentId: "main",
      sessionKey: "agent:main:main",
      messageProvider: "webchat",
      lane: "talk",
      runIdPrefix: "talk-realtime-consult",
      args: { question: "Ship it" },
      surface: "a browser Talk session",
      userLabel: "User",
      onRunStarted: (startedRun) => {
        runId = startedRun.runId;
        registerClientVoiceConsultRun({
          agentId: "main",
          sessionKey: "agent:main:main",
          voiceSessionId,
          runId: startedRun.runId,
        });
      },
    });

    await started.promise;
    expect(runId).toEqual(expect.any(String));
    release.resolve();
    await expect(consult).resolves.toEqual({ text: "Done." });
    await waitForDiagnosticEventsDrained();
    expect(resolveClientVoiceRunBinding(runId)).toBeUndefined();
  });

  it("runs an embedded agent using the shared session and prompt contract", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime([
      setReplyPayloadMetadata({ text: "Earlier answer." }, { precedingInputAnswer: true }),
      { text: "Speak this." },
      { text: "Then this." },
    ]);

    const result = await runConsult({
      cfg: { agents: { entries: { operator: {} } } },
      agentRuntime: runtime as never,
      sessionKey: "voice:15550001234",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "What should I say?", context: "Caller asked about PR #123." },
      transcript: [{ role: "user", text: "Can you check this?" }],
      questionSourceLabel: "caller",
      senderId: "+15550001234",
      senderIsOwner: true,
      toolsAllow: ["read"],
      toolBindings: { voice_call: { kind: "active-call", callId: "call-1" } },
      provider: "openai",
      model: "gpt-5.4",
      thinkLevel: "high",
      fastMode: true,
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ text: "Speak this.\n\nThen this." });
    const voiceSession = sessionStore["voice:15550001234"];
    if (!voiceSession) {
      throw new Error("Expected voice consult session entry");
    }
    expect(Object.keys(voiceSession).toSorted()).toStrictEqual([
      "createdAt",
      "createdVia",
      "sessionId",
      "updatedAt",
    ]);
    expect(voiceSession.createdVia).toBe("talk");
    expectPositiveTimestamp(voiceSession.createdAt);
    expectNonEmptyString(voiceSession.sessionId);
    expectPositiveTimestamp(voiceSession.updatedAt);
    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionId).toBe(voiceSession.sessionId);
    expect(call.sessionKey).toBe("voice:15550001234");
    expect(call.sandboxSessionKey).toBe("agent:operator:voice:15550001234");
    expect(call.agentId).toBe("operator");
    expect(call.senderId).toBe("+15550001234");
    expect(call.senderIsOwner).toBe(true);
    expect(call.messageProvider).toBe("voice");
    expect(call.lane).toBe("voice");
    expect(call.toolsAllow).toStrictEqual(["read"]);
    expect(call.toolBindings).toStrictEqual({
      voice_call: { kind: "active-call", callId: "call-1" },
    });
    expect(call.provider).toBe("openai");
    expect(call.model).toBe("gpt-5.4");
    expect(call.thinkLevel).toBe("high");
    expect(call.fastMode).toBe(true);
    expect(call.timeoutMs).toBe(10_000);
    expect(call.enforceFinalTag).toBeUndefined();
    expect(call.onBlockReply).toBeUndefined();
    expect(call.prompt).toBe(
      [
        "Live voice request from the caller during a live phone call.",
        "Act as the configured OpenClaw agent on behalf of this user. Use available tools when the request asks you to do work.",
        "A later caller utterance does not by itself cancel an earlier request. Keep relevant earlier context and avoid repeating completed actions.",
        "Generated assistant text and completed tool work are not proof that their spoken answer reached the caller; use voice transcript delivery markers.",
        "When an earlier result was not spoken or its audio was interrupted, address its still-relevant unanswered parts along with the latest request. Reuse completed results; do not repeat completed actions. An explicit caller cancellation or correction takes precedence.",
        "Speech-onset annotations associate a caller's addition with the request active when they began speaking, not when transcription finished. Unless explicitly corrected or cancelled, address both requests in their requested order using completed results; do not treat the addition as replacing the preceding request.",
        "When finished, return only the concise result the realtime voice agent should speak back.",
        "Report a security or approval block only when an actual tool result says so. Distinguish tool errors from permission denials; do not invent a blocked attempt. If a read-only call fails, correct the tool or arguments and continue when possible.",
        "Do not include markdown, tool logs, or private reasoning. Include citations only when the spoken answer needs them.",
        "Recent voice transcript for context:\nCaller: Can you check this?",
        "Additional realtime context:\nCaller asked about PR #123.",
        "User request:\nWhat should I say?",
      ].join("\n\n"),
    );
    expect(call.extraSystemPrompt).toBe(
      "You are the configured OpenClaw agent receiving delegated requests from a live voice bridge. Act on behalf of the user, use available tools when appropriate, and return a brief speakable result.",
    );
  });

  it("carries current voice session permissions without enabling owner trace", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["agent:main:voice"] = {
      sessionId: "voice-session",
      permissionMode: "workspace",
      toolOverrides: { webSearch: false },
    };
    await runConsult({
      agentRuntime: runtime as never,
      agentId: "main",
      sessionKey: "agent:main:voice",
      runIdPrefix: "voice-permissions",
      args: { question: "Read the report" },
      surface: "a phone call",
      senderIsOwner: true,
    });
    expect(requireEmbeddedAgentCall(runEmbeddedAgent)).toMatchObject({
      permissionMode: "workspace",
      toolOverrides: { webSearch: false },
      traceAuthorized: false,
    });
  });

  it("fails closed before dispatching a model for a locked Codex consult session", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["voice:locked"] = {
      sessionId: "locked-session",
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    };

    await expect(
      runConsult({
        agentRuntime: runtime as never,
        sessionKey: "voice:locked",
        runIdPrefix: "voice-realtime-consult:locked",
        args: { question: "Continue this session." },
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
    expect(runtime.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("fails closed before forking or dispatching from a locked requester session", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["agent:main:main"] = {
      sessionId: "locked-requester",
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    };
    const forkSessionEntryFromParent = sessionForkMocks.forkSessionEntryFromParent;

    await expect(
      runConsult({
        agentRuntime: runtime as never,
        sessionKey: "agent:main:subagent:google-meet:meet-locked",
        spawnedBy: "agent:main:main",
        contextMode: "fork",
        messageProvider: "google-meet",
        lane: "google-meet",
        runIdPrefix: "google-meet:meet-locked",
        args: { question: "Continue this session." },
        surface: "a private Google Meet",
        userLabel: "Participant",
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
    expect(forkSessionEntryFromParent).not.toHaveBeenCalled();
    expect(runtime.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("allows an independent consult when only the requester session is locked", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["agent:main:main"] = {
      sessionId: "locked-requester",
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    };

    await expect(
      consultRealtimeVoiceAgent({
        cfg: {} as never,
        agentRuntime: runtime as never,
        logger: { warn: vi.fn() },
        agentId: "meet-consult",
        sessionKey: "agent:meet-consult:subagent:google-meet:meet-independent",
        spawnedBy: "agent:main:main",
        contextMode: "fork",
        messageProvider: "google-meet",
        lane: "google-meet",
        runIdPrefix: "google-meet:meet-independent",
        args: { question: "Check the meeting." },
        transcript: [],
        surface: "a private Google Meet",
        userLabel: "Participant",
      }),
    ).resolves.toEqual({ text: "Speak this." });
    expect(sessionForkMocks.forkSessionEntryFromParent).not.toHaveBeenCalled();
    expect(requireEmbeddedAgentCall(runEmbeddedAgent).agentId).toBe("meet-consult");
  });

  it("fresh-checks archive state after a queued lifecycle mutation", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    const sessionKey = "voice:archive-race";
    sessionStore[sessionKey] = {
      sessionId: "active-session",
      updatedAt: 1,
    };
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation("patch", {
      scope: testTempPath("sessions.json"),
      identities: [sessionKey, "active-session"],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        const entry = sessionStore[sessionKey];
        if (entry) {
          entry.archivedAt = 2;
        }
      },
    });
    await mutationStarted.promise;

    const consult = runConsult({
      agentRuntime: runtime as never,
      sessionKey,
      runIdPrefix: "voice-realtime-consult:archive-race",
      args: { question: "What should I say?" },
    });
    await Promise.resolve();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();

    releaseMutation.resolve();
    await mutation;
    await expect(consult).rejects.toThrow(
      'Session "voice:archive-race" is archived. Restore it before starting new work.',
    );
    expect(runtime.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it.each([
    { label: "cancellation", meta: { aborted: true }, errorName: "AbortError" },
    {
      label: "timeout",
      meta: {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      errorName: "TimeoutError",
    },
  ])("preserves $label instead of speaking a partial result", async ({ meta, errorName }) => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const cleanup = vi.fn();
    runEmbeddedAgent.mockResolvedValueOnce({ payloads: [{ text: "Partial answer." }], meta });

    await expect(
      runConsult({
        agentRuntime: runtime as never,
        sessionKey: "agent:main:voice-interruption",
        runIdPrefix: "voice-interruption",
        args: { question: "Read the project." },
        surface: "a live voice session",
        userLabel: "User",
        onRunStarted: () => ({ cleanup }),
      }),
    ).rejects.toMatchObject({ name: errorName });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("returns a speakable fallback when the embedded agent has no visible text", async () => {
    const warn = vi.fn();
    const { runtime } = createAgentRuntime([
      setReplyPayloadMetadata({ text: "Earlier answer." }, { precedingInputAnswer: true }),
      { text: "hidden", isReasoning: true },
    ]);

    const result = await runConsult({
      agentRuntime: runtime as never,
      logger: { warn },
      sessionKey: "google-meet:meet-1",
      messageProvider: "google-meet",
      lane: "google-meet",
      runIdPrefix: "google-meet:meet-1",
      args: { question: "What now?" },
      surface: "a private Google Meet",
      userLabel: "Participant",
      fallbackText: "Let me verify that first.",
    });

    expect(result).toEqual({ text: "Let me verify that first." });
    expect(warn).toHaveBeenCalledWith(
      "[talk] agent consult produced no answer: agent returned no speakable text",
    );
  });

  it("returns a yielded acknowledgement immediately without waiting for a visible final", async () => {
    const warn = vi.fn();
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    runEmbeddedAgent.mockResolvedValueOnce({
      payloads: [],
      meta: {
        yielded: true,
        yieldAcknowledgment: "  Working on it.   I will report back.  ",
      },
    });

    const result = await runConsult({
      agentRuntime: runtime as never,
      logger: { warn },
      sessionKey: "voice:yielded",
      runIdPrefix: "voice:yielded",
      args: { question: "Investigate this" },
      surface: "a live voice session",
    });

    expect(result).toEqual({
      text: "Working on it. I will report back.",
      yielded: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("forks requester context and inherits its required creator isolation", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["agent:main:main"] = {
      sessionId: "parent-session",
      totalTokens: 100,
      createdActor: { type: "human", source: "profile", id: "profile-required" },
      sandbox: "required",
      updatedAt: 1,
    };
    const forkSessionEntryFromParent = sessionForkMocks.forkSessionEntryFromParent;
    forkSessionEntryFromParent.mockImplementation(
      async (
        params: ForkSessionEntryFromParentParams,
      ): Promise<ForkSessionEntryFromParentResult> => {
        const fork = {
          sessionId: "forked-session",
          sessionFile: testTempPath("forked.jsonl"),
        };
        const parentEntry = sessionStore["agent:main:main"];
        if (!parentEntry?.sessionId) {
          return { status: "missing-parent" };
        }
        const typedParentEntry: SessionEntry = {
          ...parentEntry,
          sessionId: parentEntry.sessionId,
          updatedAt: parentEntry.updatedAt ?? Date.now(),
        };
        const decision = {
          status: "fork" as const,
          maxTokens: 100_000,
        };
        const entry = params.fallbackEntry ?? { sessionId: "", updatedAt: Date.now() };
        const sessionEntry: SessionEntry = {
          ...entry,
          ...params.entryPatch?.forked,
          sessionId: fork.sessionId,
          forkedFromParent: true,
        };
        sessionStore[params.sessionKey] = sessionEntry;
        return {
          status: "forked" as const,
          fork,
          parentEntry: typedParentEntry,
          sessionEntry,
          decision,
        };
      },
    );

    await runConsult({
      agentRuntime: runtime as never,
      agentId: "main",
      sessionKey: "agent:main:subagent:google-meet:meet-1",
      spawnedBy: "agent:main:main",
      contextMode: "fork",
      messageProvider: "google-meet",
      lane: "google-meet",
      runIdPrefix: "google-meet:meet-1",
      args: { question: "What should I say?" },
      surface: "a private Google Meet",
      userLabel: "Participant",
    });

    expect(forkSessionEntryFromParent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionKey: "agent:main:main",
        agentId: "main",
        config: {},
        sessionKey: "agent:main:subagent:google-meet:meet-1",
      }),
    );
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    const forkedEntry = sessionStore["agent:main:subagent:google-meet:meet-1"];
    if (!forkedEntry) {
      throw new Error("Expected forked consult session entry");
    }
    expect(forkedEntry).toStrictEqual({
      sessionId: "forked-session",
      spawnedBy: "agent:main:main",
      // The consult child's lineage receipt; the fixture parent has no lifecycle revision.
      spawnedBySessionId: "parent-session",
      parentSessionLifecycleRevision: undefined,
      spawnedBySenderIsOwner: false,
      forkedFromParent: true,
      createdVia: "talk",
      createdActor: { type: "human", source: "profile", id: "profile-required" },
      sandbox: "required",
      createdAt: forkedEntry.createdAt,
      updatedAt: forkedEntry.updatedAt,
    });
    expectPositiveTimestamp(forkedEntry.updatedAt);
    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionId).toBe("forked-session");
    expect(call.sessionFile).toBeUndefined();
    expect(call.sessionTarget).toMatchObject({
      agentId: "main",
      sessionId: "forked-session",
      sessionKey: "agent:main:subagent:google-meet:meet-1",
      storePath: testTempPath("sessions.json"),
    });
    expect(call.spawnedBy).toBe("agent:main:main");
  });

  it("falls back to a fresh isolated consult session when requester context is too large", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const warn = vi.fn();
    const forkSessionEntryFromParent = sessionForkMocks.forkSessionEntryFromParent;
    forkSessionEntryFromParent.mockImplementation(
      async (
        params: ForkSessionEntryFromParentParams,
      ): Promise<ForkSessionEntryFromParentResult> => ({
        status: "skipped",
        reason: "decision-skip",
        sessionEntry: {
          ...(params.fallbackEntry ?? { sessionId: "", updatedAt: Date.now() }),
          sessionId: "",
          updatedAt: Date.now(),
        },
        decision: {
          status: "skip",
          reason: "parent-too-large",
          maxTokens: 100_000,
          parentTokens: 150_000,
          message:
            "Parent context is too large to fork (150000/100000 tokens); starting with isolated context instead.",
        },
      }),
    );

    await runConsult({
      agentRuntime: runtime as never,
      logger: { warn },
      agentId: "main",
      sessionKey: "agent:main:subagent:google-meet:meet-1",
      spawnedBy: "agent:main:main",
      contextMode: "fork",
      messageProvider: "google-meet",
      lane: "google-meet",
      runIdPrefix: "google-meet:meet-1",
      args: { question: "What should I say?" },
      surface: "a private Google Meet",
      userLabel: "Participant",
    });

    expect(warn).toHaveBeenCalledWith(
      "[talk] Parent context is too large to fork (150000/100000 tokens); starting with isolated context instead.",
    );
    expect(runtime.session.patchSessionEntry).toHaveBeenCalled();
    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expectNonEmptyString(call.sessionId);
    expect(call.sessionFile).toBeUndefined();
    expect(call.sessionTarget).toMatchObject({
      agentId: "main",
      sessionId: call.sessionId,
      sessionKey: "agent:main:subagent:google-meet:meet-1",
      storePath: testTempPath("sessions.json"),
    });
    expect(call.spawnedBy).toBe("agent:main:main");
  });

  it("reuses the call session delivery context when requester metadata is absent", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["voice:google-meet:meet-1"] = {
      sessionId: "call-session",
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: "discord",
          to: "channel:123",
          accountId: "default",
          threadId: "thread-456",
        },
      }),
      updatedAt: 1,
    };

    await runConsult({
      agentRuntime: runtime as never,
      agentId: "main",
      sessionKey: "voice:google-meet:meet-1",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "Send this to the original chat." },
    });

    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionId).toBe("call-session");
    expect(call.sessionKey).toBe("voice:google-meet:meet-1");
    expect(call.messageProvider).toBe("discord");
    expect(call.agentAccountId).toBe("default");
    expect(call.messageTo).toBe("channel:123");
    expect(call.messageThreadId).toBe("thread-456");
    expect(call.currentChannelId).toBe("channel:123");
    expect(call.currentThreadTs).toBe("thread-456");
  });
});
