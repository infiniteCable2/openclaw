import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSpeechBargeInGate } from "./output-gate.js";
import type { SpeechAudioTransport, SpeechOutputGate } from "./transport.js";

afterEach(() => vi.restoreAllMocks());

function fixture(clearOutput: SpeechAudioTransport["clearOutput"]) {
  const setOutputGate = vi.fn(async (_mode: SpeechOutputGate) => {});
  const onFailure = vi.fn();
  const gate = createSpeechBargeInGate({
    transport: {
      clearOutput,
      setOutputGate,
      onFatal: vi.fn(),
      startInput: vi.fn(),
      writeOutput: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    },
    isStopped: () => false,
    hasActiveOutput: () => true,
    onFailure,
  });
  const pause = (utteranceId: string) => {
    gate.onSpeechActivity({ utteranceId, state: "candidate" });
    gate.onSpeechActivity({ utteranceId, state: "sustained" });
  };
  return { gate, pause, setOutputGate, onFailure };
}

describe("native output gate ownership during clear", () => {
  it("does not release a newer paused input after an older clear completes", async () => {
    const clear = createDeferredCore();
    const f = fixture(() => clear.promise);
    f.pause("first");
    const pending = f.gate.clearOutput();
    f.pause("second");
    clear.resolve();
    await pending;
    expect(f.setOutputGate.mock.calls.map(([mode]) => mode)).toEqual([
      "duck",
      "paused",
      "duck",
      "paused",
    ]);
    expect(f.gate.canResumeWaitingAudio()).toBe(false);
    f.gate.onProcessing({ utteranceId: "second", state: "empty" });
    expect(f.setOutputGate).toHaveBeenLastCalledWith("normal");
  });

  it("releases only its current owner after a successful confirmed clear", async () => {
    const f = fixture(async () => {});
    f.pause("first");
    await f.gate.clearOutput();
    expect(f.setOutputGate).toHaveBeenLastCalledWith("normal");
    expect(f.gate.canResumeWaitingAudio()).toBe(true);
  });

  it("does not erase a later rejected input's native post-pause drain", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const clear = createDeferredCore();
    const f = fixture(() => clear.promise);
    f.pause("first");
    const pending = f.gate.clearOutput();
    f.pause("second");
    f.gate.onProcessing({ utteranceId: "second", state: "empty" });
    clear.resolve();
    await pending;
    expect(f.gate.canResumeWaitingAudio()).toBe(false);
    expect(f.setOutputGate.mock.calls.filter(([mode]) => mode === "normal")).toHaveLength(1);
  });

  it("keeps playback paused and reports a failed transport clear", async () => {
    const error = new Error("clear failed");
    const f = fixture(async () => {
      throw error;
    });
    f.pause("first");
    await expect(f.gate.clearOutput()).rejects.toBe(error);
    expect(f.setOutputGate.mock.calls.map(([mode]) => mode)).toEqual(["duck", "paused"]);
    expect(f.gate.canResumeWaitingAudio()).toBe(false);
    expect(f.onFailure).toHaveBeenCalledExactlyOnceWith(error);
  });
});
