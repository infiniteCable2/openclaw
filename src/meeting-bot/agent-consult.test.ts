import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";

const {
  consultRealtimeVoiceAgent,
  prepareRealtimeVoiceAgentExecutionContext,
  controlRealtimeVoiceAgentRun,
} = vi.hoisted(() => ({
  consultRealtimeVoiceAgent: vi.fn<
    typeof import("../talk/agent-consult-runtime.js").consultRealtimeVoiceAgent
  >(async () => ({ text: "done" })),
  prepareRealtimeVoiceAgentExecutionContext: vi.fn(),
  controlRealtimeVoiceAgentRun:
    vi.fn<typeof import("../talk/agent-run-control.js").controlRealtimeVoiceAgentRun>(),
}));

vi.mock("../talk/agent-consult-runtime.js", () => ({
  consultRealtimeVoiceAgent,
  prepareRealtimeVoiceAgentExecutionContext,
}));
vi.mock("../talk/agent-run-control.js", () => ({ controlRealtimeVoiceAgentRun }));

import { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import type {
  MeetingAgentConsultSurface,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";
import type { MeetingAgentConsultParams } from "./realtime-engine.js";

const surface: MeetingAgentConsultSurface = {
  id: "test-meeting",
  provider: "test-meeting",
  lane: "test-meeting",
  surface: "a test meeting",
  userLabel: "Participant",
  assistantLabel: "Agent",
  questionSourceLabel: "participant",
  workingResponseLabel: "participant",
  extraSystemPrompt: "Answer briefly.",
};

const platform: MeetingPlatformRuntimeMetadata = {
  id: "test-meeting",
  displayName: "Test Meeting",
  logScope: "[test-meeting]",
  agentConsult: {
    surface: surface.surface,
    userLabel: surface.userLabel,
    assistantLabel: surface.assistantLabel,
    questionSourceLabel: surface.questionSourceLabel,
    workingResponseLabel: surface.workingResponseLabel,
    extraSystemPrompt: surface.extraSystemPrompt,
  },
  session: {
    idPrefix: "test_meeting",
    participantIdentity: () => "Test participant",
  },
};

function createBindings(agentId: string | undefined) {
  return createMeetingRealtimeEngineBindings({
    platform,
    config: {
      realtime: { ...(agentId ? { agentId } : {}), toolPolicy: "safe-read-only" },
    },
    fullConfig: {
      agents: {
        defaults: { thinkingDefault: "low" },
        list: [{ id: "operator", default: true }],
      },
    },
    runtime: { agent: {} } as never,
    logger: {} as never,
  });
}

function makeSession(
  submitToolResult: RealtimeVoiceBridgeSession["submitToolResult"],
  supportsToolResultContinuation = false,
): RealtimeVoiceBridgeSession {
  return {
    bridge: { supportsToolResultContinuation },
    submitToolResult,
  } as unknown as RealtimeVoiceBridgeSession;
}

describe("createMeetingRealtimeEngineBindings", () => {
  beforeEach(() => {
    consultRealtimeVoiceAgent.mockClear();
    prepareRealtimeVoiceAgentExecutionContext.mockReset();
    controlRealtimeVoiceAgentRun.mockReset();
  });

  it("binds follow-up steering to the exact run and refreshes its unchanged caller authority", async () => {
    const published = vi.fn<NonNullable<MeetingAgentConsultParams["onRunControl"]>>();
    const includePrecedingInputAnswers = () => true;
    let retainedControl: Parameters<NonNullable<MeetingAgentConsultParams["onRunControl"]>>[0];
    const overlay = { toolsAllow: ["read"], messageProvider: "matrix", senderIsOwner: false };
    prepareRealtimeVoiceAgentExecutionContext.mockReturnValue({
      sessionEntry: { sessionId: "session-1" },
      toolAuthorityOverlay: overlay,
    });
    const outcome = {
      ok: false,
      mode: "followup" as const,
      sessionKey: "agent:support:subagent:test-meeting:meeting-control",
      active: true,
      queued: true,
      reason: "delivery_unconfirmed",
      message: "Input adopted but transcript commit unconfirmed; do not replay.",
      speak: true,
      show: true,
      suppress: false,
    };
    controlRealtimeVoiceAgentRun.mockImplementation(async (control) => {
      expect(control.runTarget?.runId).toBe("run-1");
      expect(control.runTarget?.isCurrent("session-1")).toBe(true);
      expect(control.runTarget?.isCurrent("other-session")).toBe(false);
      expect(control.mode).toBe("followup");
      expect(control.waitForTranscriptCommit).toBe(true);
      expect(control.getToolAuthorityOverlay?.()).toBe(overlay);
      return outcome;
    });
    consultRealtimeVoiceAgent.mockImplementationOnce(async (consult) => {
      expect(consult.includePrecedingInputAnswers).toBe(includePrecedingInputAnswers);
      const registration = consult.onRunStarted?.({
        runId: "run-1",
        sessionId: "session-1",
        timeoutMs: 1000,
      });
      retainedControl = published.mock.calls[0]?.[0];
      expect(retainedControl).toBeTypeOf("function");
      expect(await retainedControl!("Bitte zusätzlich B beachten")).toBe(outcome);
      expect(await retainedControl!("Und C")).toBe(outcome);
      expect(prepareRealtimeVoiceAgentExecutionContext).toHaveBeenCalledTimes(2);
      expect(prepareRealtimeVoiceAgentExecutionContext).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agentId: "support",
          sessionKey: outcome.sessionKey,
          spawnedBy: "agent:support:matrix:dm:caller",
          messageProvider: "test-meeting",
          toolsAllow: expect.arrayContaining(["read"]),
        }),
      );
      expect(prepareRealtimeVoiceAgentExecutionContext.mock.calls[0]?.[0]).not.toHaveProperty(
        "senderIsOwner",
      );
      registration?.cleanup?.();
      expect(controlRealtimeVoiceAgentRun.mock.calls[0]?.[0].runTarget?.isCurrent()).toBe(false);
      return { text: "A and B done" };
    });
    await createBindings("Support").consultAgent({
      meetingSessionId: "meeting-control",
      requesterSessionKey: "agent:support:matrix:dm:caller",
      args: { question: "A" },
      transcript: [],
      onRunControl: published,
      includePrecedingInputAnswers,
    });
    expect(published.mock.calls.map(([control]) => typeof control)).toEqual([
      "function",
      "undefined",
    ]);
    expect(controlRealtimeVoiceAgentRun).toHaveBeenCalledTimes(2);
    expect(consultRealtimeVoiceAgent).toHaveBeenCalledTimes(1);
  });

  it("revokes the exact run control immediately on abort and does not revive a retained callback", async () => {
    const abort = new AbortController();
    const published = vi.fn<NonNullable<MeetingAgentConsultParams["onRunControl"]>>();
    controlRealtimeVoiceAgentRun.mockImplementation(async (control) => {
      expect(control.runTarget?.signal.aborted).toBe(true);
      expect(control.runTarget?.isCurrent()).toBe(false);
      return {
        ok: false,
        active: false,
        mode: "followup",
        sessionKey: control.sessionKey,
        reason: "no_active_run",
        message: "No active run",
        speak: true,
        show: true,
        suppress: false,
      };
    });
    consultRealtimeVoiceAgent.mockImplementationOnce(async (consult) => {
      const registration = consult.onRunStarted?.({
        runId: "run-abort",
        sessionId: "session-abort",
        timeoutMs: 1000,
      });
      const retainedControl = published.mock.calls[0]?.[0];
      abort.abort();
      expect(published).toHaveBeenLastCalledWith(undefined);
      expect(registration?.abortSignal?.aborted).toBe(true);
      await retainedControl!("B");
      registration?.cleanup?.();
      return { text: "" };
    });
    await createBindings("Support").consultAgent({
      meetingSessionId: "abort",
      args: { question: "A" },
      transcript: [],
      abortSignal: abort.signal,
      onRunControl: published,
    });
    expect(published).toHaveBeenCalledTimes(2);
    expect(prepareRealtimeVoiceAgentExecutionContext).not.toHaveBeenCalled();
  });

  it("rejects changed session authority rather than redirecting a follow-up to a replacement run", async () => {
    const published = vi.fn<NonNullable<MeetingAgentConsultParams["onRunControl"]>>();
    prepareRealtimeVoiceAgentExecutionContext.mockReturnValue({
      sessionEntry: { sessionId: "replacement" },
      toolAuthorityOverlay: {},
    });
    controlRealtimeVoiceAgentRun.mockImplementation(async (control) => {
      control.getToolAuthorityOverlay?.();
      throw new Error("must not reach injection");
    });
    consultRealtimeVoiceAgent.mockImplementationOnce(async (consult) => {
      consult.onRunStarted?.({ runId: "original", sessionId: "session-original", timeoutMs: 1000 });
      const control = published.mock.calls[0]?.[0];
      await expect(control!("B")).rejects.toThrow("session has changed");
      throw new Error("consult failed");
    });
    await expect(
      createBindings("Support").consultAgent({
        meetingSessionId: "changed",
        args: { question: "A" },
        transcript: [],
        onRunControl: published,
      }),
    ).rejects.toThrow("consult failed");
    expect(published.mock.calls.map(([control]) => typeof control)).toEqual([
      "function",
      "undefined",
    ]);
    expect(controlRealtimeVoiceAgentRun.mock.calls[0]?.[0].runTarget?.isCurrent()).toBe(false);
  });

  it("does not install a control registration for callers that did not request one", async () => {
    await createBindings("Support").consultAgent({
      meetingSessionId: "no-control",
      args: { question: "A" },
      transcript: [],
    });
    expect(consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({ onRunStarted: undefined }),
    );
    expect(controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();
  });

  it("targets the configured default agent when agentId is omitted", async () => {
    await createBindings(undefined).consultAgent({
      meetingSessionId: "meeting-1",
      args: { question: "What should I say?" },
      transcript: [],
    });

    expect(consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "operator",
        sessionKey: "agent:operator:subagent:test-meeting:meeting-1",
        spawnedBy: "agent:operator:main",
        thinkLevel: "low",
      }),
    );
  });

  it("keeps an explicit agentId ahead of the configured default", async () => {
    await createBindings("Support").consultAgent({
      meetingSessionId: "meeting-2",
      args: { question: "What should I say?" },
      transcript: [],
    });

    expect(consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support",
        sessionKey: "agent:support:subagent:test-meeting:meeting-2",
        spawnedBy: "agent:support:main",
      }),
    );
  });

  it("uses a call-scoped thinking override without changing the agent default", async () => {
    const bindings = createMeetingRealtimeEngineBindings({
      platform,
      config: {
        realtime: {
          agentId: "operator",
          toolPolicy: "owner",
          agentThinkingLevel: "off",
          speakCommentary: true,
        },
      },
      fullConfig: {
        agents: {
          defaults: { thinkingDefault: "low" },
          list: [{ id: "operator", default: true }],
        },
      },
      runtime: { agent: {} } as never,
      logger: {} as never,
    });
    await bindings.consultAgent({
      meetingSessionId: "meeting-override",
      args: { question: "Read the fixture" },
      transcript: [],
    });
    expect(consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "operator",
        thinkLevel: "off",
        speakCommentary: true,
        toolsAllow: undefined,
      }),
    );
  });

  it("derives realtime engine bindings from platform metadata", async () => {
    const bindings = createBindings("Support");

    expect(bindings.platform).toEqual({
      displayName: "Test Meeting",
      logScope: "[test-meeting]",
      sessionIdPrefix: "test-meeting",
    });
    await bindings.consultAgent({
      meetingSessionId: "meeting-3",
      args: { question: "What should I say?" },
      transcript: [],
    });

    expect(consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support",
        messageProvider: "test-meeting",
        lane: "test-meeting",
        surface: "a test meeting",
        sessionKey: "agent:support:subagent:test-meeting:meeting-3",
      }),
    );
  });

  it("emits a final tool event only after the bridge accepts the result", async () => {
    let acceptResult = () => {};
    const accepted = new Promise<void>((resolve) => {
      acceptResult = resolve;
    });
    const submitToolResult = vi.fn(() => accepted);
    const events: Array<{ type: string; final?: boolean }> = [];

    const handled = createBindings("Support").handleToolCall({
      strategy: "agent",
      session: makeSession(submitToolResult),
      event: {
        itemId: "item-1",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "What should I say?" },
      },
      meetingSessionId: "meeting-4",
      transcript: [],
      onTalkEvent: (event) => events.push(event),
    });

    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    acceptResult();
    await handled;
    expect(events).toEqual([expect.objectContaining({ type: "tool.error", final: true })]);
  });

  it("does not retry a rejected result submission as a second tool error", async () => {
    const submitToolResult = vi.fn(async () => {
      throw new Error("result delivery failed");
    });
    const events: Array<{ type: string }> = [];

    await expect(
      createBindings("Support").handleToolCall({
        strategy: "bidi",
        session: makeSession(submitToolResult),
        event: {
          itemId: "item-1",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: { question: "What should I say?" },
        },
        meetingSessionId: "meeting-5",
        transcript: [],
        onTalkEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow("result delivery failed");

    expect(consultRealtimeVoiceAgent).toHaveBeenCalledTimes(1);
    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(["tool.progress"]);
  });
});
