import { describe, expect, it, vi } from "vitest";
import type { RealtimeTranscriptionSession } from "../../realtime-transcription/provider-types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSpeechTranscriptionInput } from "./session-input.js";

function fixture(
  finishInput: NonNullable<RealtimeTranscriptionSession["finishInput"]>,
  inputEndMode?: "server" | "client",
) {
  const session = {
    connect: async () => {},
    close: vi.fn(),
    sendAudio: vi.fn(),
    isConnected: () => true,
    finishInput,
  };
  const started = vi.fn();
  const ended = vi.fn();
  const input = createSpeechTranscriptionInput({
    inputAudioFormat: "pcm16-16khz",
    inputEndMode,
    transcription: {
      provider: {
        id: "synthetic",
        label: "Synthetic",
        isConfigured: () => true,
        createSession: () => session,
        resolveInputAudioFormat: () => "pcm16-16khz",
      },
      providerConfig: {},
    },
    getSession: () => session,
    isReady: () => true,
    assertCurrent() {},
    acceptAudio: () => true,
    onCaptureStarted: started,
    onCaptureEnded: ended,
  });
  return { input, session, started, ended };
}

describe("speech capture boundary identity", () => {
  it("requires capture identity before accepting any client-ended audio or boundary", async () => {
    const finish = vi.fn();
    const { input, session, started } = fixture(finish, "client");
    expect(() => input.sendAudio(Buffer.alloc(2))).toThrow("requires a captureId");
    await expect(input.finishInput()).rejects.toThrow("requires a captureId");
    expect(session.sendAudio).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    input.sendAudio(Buffer.alloc(2), { captureId: "capture-a" });
    await input.finishInput({ captureId: "capture-a" });
    expect(finish).toHaveBeenCalledExactlyOnceWith({ captureId: "capture-a" });
  });
  it("retains the boundary result without finalizing a newer capture", async () => {
    const finish = vi.fn(async () => ({ activity: "none" as const }));
    const { input, started, ended } = fixture(finish);
    await input.finishInput({ captureId: "capture-a" });
    input.sendAudio(Buffer.alloc(32), { captureId: "capture-b" });
    await input.finishInput({ captureId: "capture-a" });
    expect(finish).toHaveBeenCalledExactlyOnceWith({ captureId: "capture-a" });
    expect(ended).toHaveBeenCalledExactlyOnceWith("capture-a", { activity: "none" });
    await input.finishInput({ captureId: "capture-b" });
    expect(started.mock.calls).toEqual([["capture-a"], ["capture-b"]]);
    expect(finish).toHaveBeenLastCalledWith({ captureId: "capture-b" });
    expect(() => input.sendAudio(Buffer.alloc(2), { captureId: "capture-a" })).toThrow(
      "already ended",
    );
  });

  it("rejects a mismatched boundary before touching converter or provider", async () => {
    const finish = vi.fn();
    const { input, session } = fixture(finish);
    input.sendAudio(Buffer.alloc(1), { captureId: "capture-a" });
    await expect(input.finishInput({ captureId: "capture-b" })).rejects.toThrow("active capture");
    expect(finish).not.toHaveBeenCalled();
    input.sendAudio(Buffer.alloc(1), { captureId: "capture-a" });
    await input.finishInput({ captureId: "capture-a" });
    expect(Buffer.concat(session.sendAudio.mock.calls.map(([audio]) => audio))).toEqual(
      Buffer.alloc(2),
    );
  });

  it("joins concurrent boundaries and preserves unsupported provider evidence as unknown", async () => {
    const release = createDeferredCore();
    const finish = vi.fn(async () => release.promise);
    const { input, ended } = fixture(finish);
    const first = input.finishInput({ captureId: "capture-a" });
    const duplicate = input.finishInput({ captureId: "capture-a" });
    await expect(input.finishInput({ captureId: "capture-b" })).rejects.toThrow("closing capture");
    expect(() => input.sendAudio(Buffer.alloc(2))).toThrow("still being processed");
    release.resolve();
    await Promise.all([first, duplicate]);
    expect(finish).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledExactlyOnceWith("capture-a", undefined);
  });

  it("reports boundary failure once and does not retry the provider on duplicate end", async () => {
    const error = new Error("synthetic flush failure");
    const finish = vi.fn(async () => {
      throw error;
    });
    const { input, ended } = fixture(finish);
    await expect(input.finishInput({ captureId: "capture-a" })).rejects.toBe(error);
    await expect(input.finishInput({ captureId: "capture-a" })).rejects.toBe(error);
    expect(finish).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledExactlyOnceWith("capture-a", undefined, true);
  });
});
