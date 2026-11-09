// Gateway Protocol tests cover channels.schema behavior.
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
  ChannelsStatusResultSchema,
  TalkSessionCancelOutputResultSchema,
  TalkSessionAppendAudioParamsSchema,
  TalkSessionCreateParamsSchema,
  TalkEventSchema,
  WebLoginStartParamsSchema,
  WebLoginWaitParamsSchema,
} from "./schema/channels.js";

/**
 * Channel schema regressions for browser login and status diagnostics.
 * These payloads are consumed by dashboard/operator UI, so QR payload bounds
 * and event-loop diagnostic shape are part of the public gateway contract.
 */

describe("WebLoginWaitParamsSchema", () => {
  /** Compiled validator reused across QR bounds cases. */
  const validate = Compile(WebLoginWaitParamsSchema);

  it("bounds caller-provided QR data URLs", () => {
    expect(
      validate.Check({
        currentQrDataUrl: "data:image/png;base64,qr",
      }),
    ).toBe(true);

    expect(
      validate.Check({
        currentQrDataUrl: "x".repeat(16_385),
      }),
    ).toBe(false);
    expect(
      validate.Check({
        currentQrDataUrl: "https://example.com/qr.png",
      }),
    ).toBe(false);
  });
});

it("keeps channel sampling intervals integral while accepting fractional metrics", () => {
  const eventLoop = Compile(ChannelsStatusResultSchema.properties.eventLoop);
  for (const intervalMs of [0, 1, 0.5, -1]) {
    expect(
      eventLoop.Check({
        degraded: false,
        reasons: [],
        intervalMs,
        delayP99Ms: 1.25,
        delayMaxMs: 2.5,
        utilization: 0.2,
        cpuCoreRatio: 1.5,
      }),
      `intervalMs=${intervalMs}`,
    ).toBe(intervalMs === 0 || intervalMs === 1);
  }
});

describe("TalkSessionAppendAudioParamsSchema", () => {
  const validate = Compile(TalkSessionAppendAudioParamsSchema);

  it("permits empty audio only for an explicit input boundary", () => {
    expect(validate.Check({ sessionId: "speech-1", audioBase64: "", endOfInput: true })).toBe(true);
    expect(validate.Check({ sessionId: "speech-1", audioBase64: "AAAA", endOfInput: true })).toBe(
      true,
    );
    expect(validate.Check({ sessionId: "speech-1", audioBase64: "" })).toBe(false);
    expect(validate.Check({ sessionId: "speech-1", audioBase64: "", endOfInput: false })).toBe(
      false,
    );
  });

  it("bounds optional capture correlation on both audio forms", () => {
    for (const audio of [{ audioBase64: "AAAA" }, { audioBase64: "", endOfInput: true }]) {
      for (const captureId of ["capture-1", "x".repeat(128)]) {
        expect(validate.Check({ sessionId: "speech-1", ...audio, captureId })).toBe(true);
      }
      for (const captureId of ["", " ", "x".repeat(129), 1]) {
        expect(validate.Check({ sessionId: "speech-1", ...audio, captureId })).toBe(false);
      }
    }
  });
});

describe("Talk activity extension", () => {
  it("accepts optional negotiation and requires capture correlation only for input outcomes", () => {
    expect(
      Compile(TalkSessionCreateParamsSchema).Check({ capabilities: ["activity-v1", "input-end"] }),
    ).toBe(true);
    const validate = Compile(TalkEventSchema);
    const event = {
      id: "speech-1:1",
      sessionId: "speech-1",
      seq: 1,
      timestamp: "2026-01-01T00:00:00Z",
      mode: "stt-tts",
      transport: "gateway-relay",
      brain: "agent-consult",
      payload: { version: 1 },
    };
    expect(validate.Check({ ...event, type: "session.activity" })).toBe(true);
    expect(validate.Check({ ...event, type: "input.outcome", captureId: "capture-1" })).toBe(true);
    expect(validate.Check({ ...event, type: "input.outcome" })).toBe(false);
    expect(validate.Check({ ...event, type: "input.outcome", captureId: "" })).toBe(false);
    expect(validate.Check({ ...event, type: "input.outcome", captureId: " " })).toBe(false);
  });
});

describe("WebLoginStartParamsSchema", () => {
  const validate = Compile(WebLoginStartParamsSchema);

  it("accepts an explicit QR-login channel", () => {
    expect(validate.Check({ channel: "openclaw-weixin" })).toBe(true);
  });
});

describe("TalkSessionCancelOutputResultSchema", () => {
  const validate = Compile(TalkSessionCancelOutputResultSchema);

  it("accepts only closed cancellation outcomes with an explicit ok field", () => {
    for (const value of [
      { ok: true },
      { ok: true, status: "applied", turnId: "turn-7" },
      { ok: true, status: "stale" },
      { ok: true, status: "idle" },
    ]) {
      expect(validate.Check(value)).toBe(true);
    }
    for (const value of [
      {},
      { status: "applied" },
      { ok: false },
      { ok: true, status: "unknown" },
      { ok: true, turnId: "" },
      { ok: true, extra: true },
    ]) {
      expect(validate.Check(value)).toBe(false);
    }
  });
});
