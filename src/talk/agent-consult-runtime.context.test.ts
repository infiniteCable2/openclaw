import { describe, expect, it, vi } from "vitest";
import { prepareAgentRunTerminalReply } from "../agents/agent-run-terminal-reply.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
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

describe("voice context and speech profile", () => {
  useConsultRuntimeTestHooks();
  it.each([
    { source: " ", message: "different conversation" },
    { source: "agent:main:voice-context", message: "different conversation" },
    { source: "agent:other:main", message: "admitted agent" },
    { source: "agent:main:missing", message: "context source is unavailable" },
    { source: "agent:main:locked", message: MODEL_SELECTION_LOCKED_MESSAGE },
  ])("refuses an invalid explicit context source: $source", async ({ source, message }) => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["agent:main:locked"] = {
      sessionId: "locked-context",
      updatedAt: 1,
      modelSelectionLocked: true,
    };
    await expect(
      runConsult({
        agentRuntime: runtime as never,
        agentId: "main",
        sessionKey: "agent:main:voice-context",
        contextSourceSessionKey: source,
        contextMode: "fork",
        runIdPrefix: "voice-context",
        args: { question: "Continue" },
      }),
    ).rejects.toThrow(message);
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("refuses a delegated task with a different snapshot source before reading or writing", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    await expect(
      runConsult({
        agentRuntime: runtime as never,
        agentId: "main",
        sessionKey: "agent:main:subagent:voice:task",
        spawnedBy: "agent:main:requester",
        contextSourceSessionKey: "agent:main:another-context",
        contextMode: "fork",
        runIdPrefix: "mixed-context",
        args: { question: "Check" },
      }),
    ).rejects.toThrow("admitted requester");
    expect(sessionForkMocks.withSessionEntryReadOnlyInWorker).not.toHaveBeenCalled();
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
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
      speechChannelId: "matrix",
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
    expect(call.modelRequestProfile).toEqual({ kind: "speech", channelId: "matrix" });
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
      "You are the configured OpenClaw agent participating in a live voice conversation. Respond to the user, use available tools when appropriate, and return a brief speakable result.",
    );
  });

  it("completes deliberate silent legacy consultation without inventing fallback speech", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const prepared = prepareAgentRunTerminalReply({ rawText: SILENT_REPLY_TOKEN });
    runEmbeddedAgent.mockResolvedValueOnce({
      payloads: [],
      meta: {
        finalAssistantRawText: SILENT_REPLY_TOKEN,
        finalAssistantVisibleText: prepared.text,
        terminalReply: prepared.terminalReply,
      },
    });
    const warn = vi.fn();
    const onSpeakableText = vi.fn();
    const result = await runConsult({
      agentRuntime: runtime as never,
      logger: { warn },
      sessionKey: "voice:silent",
      runIdPrefix: "voice:silent",
      args: { question: "Finish without speaking." },
      onSpeakableText,
    });
    expect(result).toEqual({ text: "", delivered: true });
    expect(onSpeakableText).toHaveBeenCalledExactlyOnceWith({ type: "done", text: "" });
    expect(warn).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  });

  it.each([undefined, "no-completed-turn"] as const)(
    "forks requester context with its creator isolation (%s)",
    async (contextStatus) => {
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
            ...(contextStatus ? { contextStatus } : {}),
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
          forkFrom: "last-completed",
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
      if (contextStatus) {
        expect(call.extraSystemPrompt).toContain("without an inherited transcript");
        expect(call.extraSystemPrompt).toContain("do not resume or repeat its unfinished work");
      } else {
        expect(call.extraSystemPrompt).not.toContain("without an inherited transcript");
      }
    },
  );

  it.each(["failed", "missing-parent"] as const)(
    "refuses a changed parent instead of creating an unrelated child (%s)",
    async (status) => {
      const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
      sessionStore["agent:main:main"] = { sessionId: "selected-parent", updatedAt: 1 };
      sessionForkMocks.forkSessionEntryFromParent.mockResolvedValue({ status });
      await expect(
        runConsult({
          agentRuntime: runtime as never,
          sessionKey: "agent:main:subagent:voice:child",
          spawnedBy: "agent:main:main",
          contextMode: "fork",
          runIdPrefix: "voice-test",
          args: { question: "Start a new conversation" },
        }),
      ).rejects.toThrow("could not be safely forked");
      expect(sessionForkMocks.forkSessionEntryFromParent).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedParent: { sessionId: "selected-parent", lifecycleRevision: undefined },
        }),
      );
      expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    },
  );
});
