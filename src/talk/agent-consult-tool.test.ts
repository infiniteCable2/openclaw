import { describe, expect, it } from "vitest";
import {
  buildRealtimeVoiceAgentConsultChatMessage as buildChatMessage,
  buildRealtimeVoiceAgentConsultPrompt,
  buildRealtimeVoiceSessionInstructions as buildSessionInstructions,
  collectRealtimeVoiceAgentConsultVisibleText as collectVisibleText,
  parseRealtimeVoiceAgentConsultArgs as parseArgs,
  REALTIME_VOICE_AGENT_CONSULT_TOOL as consultTool,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME as consultName,
  resolveRealtimeVoiceAgentConsultTools as resolveTools,
  type RealtimeVoiceAgentConsultToolPolicy as ToolPolicy,
} from "./agent-consult-tool.js";
import type { RealtimeVoiceTool } from "./provider-types.js";

function sessionInstructions(options: Partial<Parameters<typeof buildSessionInstructions>[0]>) {
  return buildSessionInstructions({
    base: "Voice base.",
    isAgentProxy: true,
    toolPolicy: "owner",
    consultPolicy: "auto",
    ...options,
  });
}

const customTool: RealtimeVoiceTool = { ...consultTool, name: "custom_lookup" };
const duplicateConsultTool = { ...customTool, name: consultName };
const baseInstructions =
  "You are OpenClaw's Discord voice interface.\nKeep spoken replies concise, natural, and suitable for a live Discord voice channel.";
const backchannel =
  'While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as "yeah", "mm-hmm", "got it", or "one sec"; vary it and do not treat it as the final answer.';
const unreadableNameTool: RealtimeVoiceTool = {
  ...customTool,
  get name(): string {
    throw new Error("unreadable tool name");
  },
};
const nonStringNameTool = { ...customTool, name: undefined } as unknown as RealtimeVoiceTool;

describe("realtime voice agent consult tool", () => {
  it("normalizes shared tool arguments for browser chat forwarding", () => {
    expect(
      buildChatMessage({
        question: "  What changed? ",
        context: "  PR #123 ",
        responseStyle: " concise ",
      }),
    ).toBe("What changed?\n\nContext:\nPR #123\n\nSpoken style:\nconcise");
  });

  it("does not accept a model-supplied spoken confirmation as authority", () => {
    const args = { question: "Send it now", confirmationId: " confirm-123 " };
    expect(parseArgs(args)).toStrictEqual({
      question: "Send it now",
      context: undefined,
      responseStyle: undefined,
    });
  });

  it("accepts provider question aliases from realtime tool calls", () => {
    expect(parseArgs({ prompt: "  Check the repo. " })).toStrictEqual({
      context: undefined,
      question: "Check the repo.",
      responseStyle: undefined,
    });
    expect(parseArgs({ query: "  Send a Discord message. " })).toStrictEqual({
      context: undefined,
      question: "Send a Discord message.",
      responseStyle: undefined,
    });
  });

  it("builds a delegated voice request prompt with recent transcript", () => {
    const prompt = buildRealtimeVoiceAgentConsultPrompt({
      args: { question: "Do we support realtime tools?" },
      transcript: [
        { role: "user", text: "Can you check the repo?" },
        { role: "assistant", text: "I'll verify." },
      ],
      surface: "a private Google Meet",
      userLabel: "Participant",
      assistantLabel: "Agent",
      questionSourceLabel: "participant",
    });

    expect(prompt).toBe(
      [
        "Live voice request from the participant during a private Google Meet.",
        "Act as the configured OpenClaw agent on behalf of this user. Use available tools when the request asks you to do work.",
        "A later caller utterance does not by itself cancel an earlier request. Keep relevant earlier context and avoid repeating completed actions.",
        "Generated assistant text and completed tool work are not proof that their spoken answer reached the caller; use voice transcript delivery markers.",
        "When an earlier result was not spoken or its audio was interrupted, address its still-relevant unanswered parts along with the latest request. Reuse completed results; do not repeat completed actions. An explicit caller cancellation or correction takes precedence.",
        "Speech-onset annotations associate a caller's addition with the request active when they began speaking, not when transcription finished. Unless explicitly corrected or cancelled, address both requests in their requested order using completed results; do not treat the addition as replacing the preceding request.",
        "When finished, return only the concise result the realtime voice agent should speak back.",
        "Report a security or approval block only when an actual tool result says so. Distinguish tool errors from permission denials; do not invent a blocked attempt. If a read-only call fails, correct the tool or arguments and continue when possible.",
        "Do not include markdown, tool logs, or private reasoning. Include citations only when the spoken answer needs them.",
        "Recent voice transcript for context:\nParticipant: Can you check the repo?\nAgent: I'll verify.",
        "User request:\nDo we support realtime tools?",
      ].join("\n\n"),
    );
  });

  it("keeps the final result separate when spoken commentary is enabled", () => {
    const prompt = buildRealtimeVoiceAgentConsultPrompt({
      args: { question: "Check the device." },
      transcript: [],
      surface: "a live voice session",
      userLabel: "Caller",
      commentaryEnabled: true,
    });

    expect(prompt).toContain("When finished, return a separate concise result");
    expect(prompt).not.toContain("return only the concise result");
  });

  it("carries the onset association into the native prompt without replacing either request", () => {
    const prompt = buildRealtimeVoiceAgentConsultPrompt({
      args: { question: "And Dresden afterwards." },
      transcript: [
        { role: "assistant", text: "Berlin is sunny.", audioDelivery: "unplayed" },
        {
          role: "user",
          text: "And Dresden afterwards.",
          speechStart: {
            at: "2026-01-01T12:00:00.000Z",
            precedingRequest: "Weather in Berlin?",
          },
        },
      ],
      surface: "a live call",
      userLabel: "Caller",
    });
    expect(prompt).toContain("speech began at 2026-01-01T12:00:00.000Z");
    expect(prompt).toContain(
      'preceding request was still being handled or spoken: "Weather in Berlin?"',
    );
    expect(prompt).toContain("transcript arrived later");
    expect(prompt).toContain("this result has not been spoken to the user]: Berlin is sunny.");
    expect(prompt).toContain(
      "address both requests in their requested order using completed results",
    );
    expect(prompt).toContain("User request:\nAnd Dresden afterwards.");
  });

  it("preserves transcript text but distinguishes partial audio from remote playout", () => {
    const prompt = buildRealtimeVoiceAgentConsultPrompt({
      args: { question: "Please continue." },
      transcript: [
        { role: "assistant", text: "First sentence.", audioDelivery: "submitted" },
        { role: "assistant", text: "Second sentence.", audioDelivery: "interrupted" },
        { role: "assistant", text: "Third sentence.", audioDelivery: "started" },
        { role: "assistant", text: "Fourth sentence.", audioDelivery: "unplayed" },
      ],
      surface: "a live call",
      userLabel: "Caller",
    });
    expect(prompt).toContain(
      "Agent [audio submitted; remote playout unconfirmed]: First sentence.",
    );
    expect(prompt).toContain(
      "Agent [audio interrupted; the user may not have heard this completely]: Second sentence.",
    );
    expect(prompt).toContain("Agent [audio started; not yet fully submitted]: Third sentence.");
    expect(prompt).toContain(
      "Agent [audio not played; this result has not been spoken to the user]: Fourth sentence.",
    );
  });

  it("filters reasoning and error payloads from visible consult output", () => {
    expect(
      collectVisibleText([
        { text: "thinking", isReasoning: true },
        { text: "first" },
        { text: "error", isError: true },
        { text: "second" },
      ]),
    ).toBe("first\n\nsecond");
  });

  it("builds byte-stable agent-proxy session instructions", () => {
    expect(
      sessionInstructions({
        base: baseInstructions,
        bootstrapContextInstructions: "  Profile context.  ",
        consultPolicy: "always",
      }),
    ).toBe(
      [
        baseInstructions,
        "Profile context.",
        "Mode: OpenClaw agent proxy.",
        "You are the realtime voice surface for the same OpenClaw agent the user can message directly.",
        "Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
        "Delegate substantive requests, actions, tool work, current facts, memory, workspace context, and user-specific context with openclaw_agent_consult.",
        "Do not block, refuse, or downscope at the voice layer. Delegate to OpenClaw and treat its result as authoritative.",
        "Answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting.",
        backchannel,
        "When OpenClaw sends an internal exact answer to speak, do not call tools. Say only that answer.",
        [
          "Consult behavior:",
          "- Call openclaw_agent_consult before every substantive answer.",
          "- You may answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting for the consult result.",
          "- After the consult result arrives, speak that result concisely.",
        ].join("\n"),
      ].join("\n\n"),
    );
    expect(sessionInstructions({ toolPolicy: "none" })).toContain(
      "Voice base.\n\n\n\nMode: OpenClaw agent proxy.",
    );
  });

  it("filters empty optional blocks from non-proxy session instructions", () => {
    expect(
      sessionInstructions({
        isAgentProxy: false,
        bootstrapContextInstructions: "   ",
        toolPolicy: "safe-read-only",
      }),
    ).toBe(`Voice base.\n\n${backchannel}`);
  });

  it.each<[ToolPolicy, RealtimeVoiceTool[] | undefined, RealtimeVoiceTool[]]>([
    ["none", undefined, []],
    [
      "safe-read-only",
      [duplicateConsultTool, unreadableNameTool, nonStringNameTool, customTool],
      [consultTool, customTool],
    ],
    ["none", [unreadableNameTool, customTool], [customTool]],
  ])(
    "resolves %s tools with built-in precedence and malformed-name quarantine (%#)",
    (policy, custom, expected) => {
      expect(resolveTools(policy, custom)).toStrictEqual(expected);
    },
  );
});
