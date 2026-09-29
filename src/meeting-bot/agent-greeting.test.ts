import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { prepareMeetingAgentGreeting } from "./agent-greeting.js";
import type { MeetingAgentConsultParams } from "./realtime-engine.js";

describe("meeting agent greeting preparation", () => {
  it("uses admitted identity and local time, then prepares speech without playback", async () => {
    const consultAgent = vi.fn(async (_request: MeetingAgentConsultParams) => ({
      text: "Guten Morgen, Alex!",
    }));
    const tts = vi.fn(async () => ({
      success: true,
      sampleRate: 24_000,
      outputFormat: "pcm" as const,
      audioStream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 0, 2, 0]));
          controller.close();
        },
      }),
    }));
    const greeting = await prepareMeetingAgentGreeting({
      cfg: {},
      runtime: { tts: { streamTextToSpeechTelephony: tts } } as unknown as PluginRuntime,
      consultAgent,
      meetingSessionId: "call-1",
      requesterSessionKey: "agent:example:matrix:direct:owner",
      callerId: "@owner:example.test",
      prompt: "Greet briefly.",
      timeZone: "Europe/Berlin",
      audioFormat: "pcm16-24khz",
      signal: new AbortController().signal,
      now: new Date("2026-09-29T07:00:00Z"),
    });
    expect(consultAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingSessionId: "call-1",
        requesterSessionKey: "agent:example:matrix:direct:owner",
        args: expect.objectContaining({
          question: expect.stringContaining("09:00"),
        }),
      }),
    );
    expect(JSON.stringify(consultAgent.mock.calls[0]?.[0].args)).toContain("@owner:example.test");
    expect(tts).toHaveBeenCalledWith(expect.objectContaining({ text: "Guten Morgen, Alex!" }));
    expect(greeting.text).toBe("Guten Morgen, Alex!");
    expect(greeting.audio.byteLength).toBeGreaterThan(0);
  });

  it("releases a stalled greeting stream when the call is aborted", async () => {
    let startedRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      startedRead = resolve;
    });
    const release = vi.fn(async () => {});
    const audioStream = new ReadableStream<Uint8Array>(
      {
        pull() {
          startedRead();
        },
      },
      { highWaterMark: 0 },
    );
    const abort = new AbortController();
    const pending = prepareMeetingAgentGreeting({
      cfg: {},
      runtime: {
        tts: {
          streamTextToSpeechTelephony: async () => ({
            success: true,
            sampleRate: 24_000,
            outputFormat: "pcm",
            audioStream,
            release,
          }),
        },
      } as unknown as PluginRuntime,
      consultAgent: async () => ({ text: "Guten Tag!" }),
      meetingSessionId: "call-2",
      callerId: "@owner:example.test",
      prompt: "Greet briefly.",
      timeZone: "Europe/Berlin",
      audioFormat: "pcm16-24khz",
      signal: abort.signal,
    });
    await reading;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(release).toHaveBeenCalledOnce();
  });
});
