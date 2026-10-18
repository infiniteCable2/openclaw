import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { AgentTurnInternalResult } from "../auto-reply/reply/agent-runner-execution.types.js";
import {
  withReplySpeechPresentation,
  type ReplySpeechPresentationRun,
} from "../auto-reply/reply/reply-speech-presentation.js";
import type { RealtimeVoiceAgentConsultSpeechEvent } from "./agent-consult-runtime.js";
import { createReplySpeechPresentation } from "./reply-speech-presentation.js";

function setup() {
  const events: RealtimeVoiceAgentConsultSpeechEvent[] = [];
  const onResult = vi.fn();
  const onError = vi.fn();
  const output = { available: true };
  const assertCurrent = vi.fn();
  const controller = new AbortController();
  const binding = {
    runId: "native-run",
    sessionId: "selected-session",
    abortSignal: controller.signal,
    assertCurrent,
  };
  const source = createReplySpeechPresentation({
    assertOutputCurrent() {
      if (!output.available) throw new Error("Output closed");
    },
    speechExpressionContext: { guidance: "Use admitted speech facts.", assertCurrent },
    onSpeakableText: (event) => {
      events.push(event);
    },
    speakCommentary: true,
    onResult,
    onError,
    logger: { warn: vi.fn() },
  });
  return { source, binding, events, onResult, onError, output, controller };
}

function completed(
  text: string,
): Extract<AgentTurnInternalResult, { kind: "settled"; status: "ok" }> {
  return {
    kind: "settled",
    status: "ok",
    result: { payloads: [{ text }], meta: { durationMs: 1 } },
    resolved: { provider: "example-provider", model: "example-model" },
    fallback: { exhausted: false, attempts: [] },
    autoCompactionCount: 0,
    didLogHeartbeatStrip: false,
  } satisfies AgentTurnInternalResult;
}

describe("native turn-owned speech presentation", () => {
  it("opens with actual execution identity, retains expression metadata and retires retained callbacks", async () => {
    const fixture = setup();
    const open = vi.fn(fixture.source.openRun);
    const source = { ...fixture.source, openRun: open };
    const text = "The final answer.";
    const expression = { parts: [{ text }] };
    const payload = setReplyPayloadMetadata({ text }, { tts: { tagged: true, text, expression } });
    const outcome = completed(text);
    outcome.result.payloads = [payload];
    let retained: ReplySpeechPresentationRun | undefined;
    const result = await withReplySpeechPresentation(source, fixture.binding, async (run) => {
      retained = run;
      expect(run?.currentSourceReplyTarget).toMatchObject({
        runId: "native-run",
        sessionId: "selected-session",
      });
      await run?.onBlockReply(payload);
      return outcome;
    });
    expect(result).toBe(outcome);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(fixture.binding);
    const chunks = fixture.events.filter((event) => event.type === "chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.speech?.expression).toBe(expression);
    expect(fixture.onResult).toHaveBeenCalledOnce();
    expect(() => retained?.onBlockReply(payload)).toThrow("no longer active");
    expect(() => retained?.currentSourceReplyTarget?.beginInput?.({})).toThrow("no longer active");
  });

  it("joins output before closing the actual turn rather than ending at dispatch return", async () => {
    const gate = createDeferred();
    const entered = createDeferred();
    const fixture = setup();
    const source = createReplySpeechPresentation({
      assertOutputCurrent() {},
      onSpeakableText: async () => {
        entered.resolve();
        await gate.promise;
      },
      onResult: fixture.onResult,
      onError: fixture.onError,
      logger: { warn: vi.fn() },
    });
    let settled = false;
    const run = withReplySpeechPresentation(source, fixture.binding, async () =>
      completed("Answer."),
    );
    void run.then(() => {
      settled = true;
    });
    await entered.promise;
    expect(settled).toBe(false);
    expect(fixture.onResult).not.toHaveBeenCalled();
    gate.resolve();
    await run;
    expect(fixture.onResult).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
  });

  it("fences retained input callbacks before an awaited terminal result observer", async () => {
    const fixture = setup();
    const entered = createDeferred();
    const gate = createDeferred();
    const source = createReplySpeechPresentation({
      assertOutputCurrent() {},
      speechExpressionContext: { guidance: "Speech facts.", assertCurrent() {} },
      onSpeakableText: (event) => {
        fixture.events.push(event);
      },
      onResult: async () => {
        entered.resolve();
        await gate.promise;
      },
      onError: fixture.onError,
      logger: { warn: vi.fn() },
    });
    let retained: ReplySpeechPresentationRun | undefined;
    const pending = withReplySpeechPresentation(source, fixture.binding, async (run) => {
      retained = run;
      return completed("Answer.");
    });
    await entered.promise;
    expect(() => retained?.onBlockReply({ text: "Late." })).toThrow("settling");
    expect(() => retained?.currentSourceReplyTarget?.beginInput?.({})).toThrow("settling");
    await expect(
      retained?.currentSourceReplyTarget?.deliver(
        { text: "Late." },
        { final: true, phase: "final_answer" },
      ),
    ).rejects.toThrow("settling");
    gate.resolve();
    await pending;
    expect(fixture.events.filter((event) => event.type === "chunk")).toEqual([]);
    expect(fixture.events).toEqual([{ type: "done", text: "Answer." }]);
    expect(fixture.onError).not.toHaveBeenCalled();
  });

  it("does not recategorize completed work as failed when its output has disappeared", async () => {
    const fixture = setup();
    const outcome = completed("Finished work.");
    const result = await withReplySpeechPresentation(fixture.source, fixture.binding, async () => {
      fixture.output.available = false;
      return outcome;
    });
    expect(result).toBe(outcome);
    expect(fixture.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Output closed" }),
    );
    expect(fixture.onResult).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([{ type: "abort" }]);
  });

  it.each(["before admission", "during work"])(
    "keeps input and stream authority when output closes %s",
    async (when) => {
      const fixture = setup();
      if (when === "before admission") fixture.output.available = false;
      const outcome = completed("Work finished.");
      const work = vi.fn(async (run: ReplySpeechPresentationRun | undefined) => {
        fixture.output.available = false;
        expect(() => run?.nativeSpeechPresentation?.assertCurrent()).not.toThrow();
        expect(() => run?.currentSourceReplyTarget?.assertCurrent()).not.toThrow();
        expect(() => run?.currentSourceReplyTarget?.beginInput?.({})).not.toThrow();
        expect(() => run?.onBlockReply({ text: "Work in progress." })).not.toThrow();
        await expect(
          run?.currentSourceReplyTarget?.deliver(
            { text: "Not delivered." },
            { final: true, phase: "final_answer" },
          ),
        ).rejects.toThrow("Output closed");
        return outcome;
      });
      expect(await withReplySpeechPresentation(fixture.source, fixture.binding, work)).toBe(
        outcome,
      );
      expect(work).toHaveBeenCalledOnce();
      expect(fixture.events).toEqual([{ type: "abort" }]);
      expect(fixture.onResult).not.toHaveBeenCalled();
      expect(fixture.onError).toHaveBeenCalledOnce();
    },
  );

  it("preserves execution failure, emits one abort and closes retained presentation", async () => {
    const fixture = setup();
    let retained: ReplySpeechPresentationRun | undefined;
    const failure = new Error("Native execution failed");
    await expect(
      withReplySpeechPresentation(fixture.source, fixture.binding, async (run) => {
        retained = run;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(fixture.events).toEqual([{ type: "abort" }]);
    expect(fixture.onResult).not.toHaveBeenCalled();
    expect(() => retained?.onBlockReply({ text: "Too late" })).toThrow("no longer active");
  });

  it("does not open an output or execute work after original authority is lost", async () => {
    const fixture = setup();
    const run = vi.fn(async () => completed("Answer."));
    fixture.binding.assertCurrent.mockImplementation(() => {
      throw new Error("Source revoked");
    });
    await expect(withReplySpeechPresentation(fixture.source, fixture.binding, run)).rejects.toThrow(
      "Source revoked",
    );
    expect(run).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
  });

  it("keeps native yield acknowledgment and work custody separate from final completion", async () => {
    const fixture = setup();
    const outcome = completed("");
    outcome.result.meta = {
      durationMs: 1,
      yielded: true,
      yieldAcknowledgment: "  Work started.\nMore later. ",
    };
    await withReplySpeechPresentation(fixture.source, fixture.binding, async () => outcome);
    expect(fixture.onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Work started. More later.",
        yielded: true,
      }),
    );
  });
});
