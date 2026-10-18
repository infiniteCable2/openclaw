import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import * as nativeQueue from "../../../auto-reply/reply/queue.js";
import { replyRunRegistry } from "../../../auto-reply/reply/reply-run-registry.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
} from "../../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { getUnifiedTalkSession } from "../../../talk/session-registry.js";
import {
  context,
  createSpeechRelayCall,
  dispatch,
  installSyntheticSpeechHardware,
  mocks,
  publishNativeSpeechModelRun,
  testState,
} from "./native-consult-target.test-support.js";

// The existing fixture substitutes only STT/TTS hardware and the model runtime.
// Admission, source capabilities, Speech/V2/getReply, native follow-up queue and
// transcript writes remain real. Model counts are NOT proof of actual tool effects.
it.for([false, true])(
  "native Speech serializes two original inputs exactly once after audio-close=%s",
  async (closeAudio, { signal }) => {
    testState.config.session = { mainKey: "scenario", scope: "global" };
    const hardware = installSyntheticSpeechHardware();
    const firstStarted = createDeferredCore();
    const secondStarted = createDeferredCore();
    const queued = createDeferredCore();
    const releaseFirst = createDeferredCore();
    const turnEnded = createDeferredCore();
    const ownerSettlements: Promise<void>[] = [];
    const questions = ["Inspect the first synthetic item.", "Also inspect the second item."];
    const answers = ["The first inspection completed.", "The second inspection completed."];
    const modelPrompts: string[] = [];
    let audioEvents = 0;
    let closed = false;
    let calls = 0;
    let audioAtClose = 0;
    const enqueue = nativeQueue.enqueueFollowupRun;
    const observeEnqueue = vi
      .spyOn(nativeQueue, "enqueueFollowupRun")
      .mockImplementation((...args) => {
        const accepted = enqueue(...args);
        if (accepted) queued.resolve();
        return accepted;
      });
    vi.mocked(context.broadcastToConnIds).mockImplementation((_name, payload) => {
      if (!isRecord(payload)) return;
      if (payload.type === "audio") audioEvents++;
      if (isRecord(payload.talkEvent) && payload.talkEvent.type === "turn.ended")
        turnEnded.resolve();
    });
    mocks.runEmbeddedAgent.mockImplementation(async (params) =>
      publishNativeSpeechModelRun(params, async () => {
        const index = calls++;
        if (index > 1) throw new Error("Accepted native input was replayed");
        modelPrompts.push(params.prompt);
        params.onExecutionPhase?.({ phase: "model_call_started" });
        const operation = replyRunRegistry.get(params.sessionKey!);
        if (!operation?.ownerSettlement) throw new Error("Actual native reply owner is missing");
        ownerSettlements.push(operation.ownerSettlement);
        if (index === 0) {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          secondStarted.resolve();
        }
        // A media close is not an explicit cancellation of accepted native work.
        params.abortSignal?.throwIfAborted();
        await params.onBlockReply?.({ text: answers[index] });
        await params.waitForPendingInput?.(params.abortSignal);
        return { payloads: [{ text: answers[index]! }], meta: { durationMs: 0 } };
      }),
    );
    const { sessionId, readyMark, target } = await createSpeechRelayCall();
    try {
      expect(
        await dispatch("talk.session.acknowledgeMark", { sessionId, markName: readyMark }),
      ).toHaveBeenCalledWith(true, { ok: true }, undefined);
      const stt = vi.mocked(hardware.provider.createSession).mock.calls[0]?.[0];
      if (!stt?.onTranscript || !stt.onSpeechActivity)
        throw new Error("Actual STT capture callbacks are missing");
      stt.onTranscript(questions[0]!, { utteranceId: "scenario-input-one" });
      // The second utterance begins while the first input is still preparing,
      // before a model run exists. Its delayed final transcript must follow up,
      // not steer whichever backend happens to be active when decoding finishes.
      stt.onSpeechActivity({ utteranceId: "scenario-input-two", state: "candidate" });
      await withinTest(firstStarted.promise, signal);
      stt.onTranscript(questions[1]!, { utteranceId: "scenario-input-two" });
      // The native enqueue return, not the earlier transcript event, proves acceptance.
      await withinTest(queued.promise, signal);
      expect(calls).toBe(1);
      expect(nativeQueue.getFollowupQueueDepth(target.canonicalKey)).toBe(1);
      if (closeAudio) {
        expect(await dispatch("talk.session.close", { sessionId })).toHaveBeenCalledWith(
          true,
          { ok: true },
          undefined,
        );
        closed = true;
        audioAtClose = audioEvents;
        expect(() => getUnifiedTalkSession(sessionId)).toThrow();
      }
      releaseFirst.resolve();
      await withinTest(secondStarted.promise, signal);
      await withinTest(Promise.all(ownerSettlements), signal);
      if (!closeAudio) await withinTest(turnEnded.promise, signal);
      expect(calls).toBe(2);
      expect(modelPrompts[0]).toContain(questions[0]);
      expect(modelPrompts[1]).toContain(questions[1]);
      const entry = loadSessionEntry({
        agentId: target.agentId,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
      });
      if (!entry) throw new Error("Native conversation disappeared after accepted work");
      const messages = readSessionTranscriptMessageEvents({
        agentId: target.agentId,
        sessionId: entry.sessionId,
        storePath: target.storePath,
      }).flatMap(({ event }) => {
        if (!isRecord(event) || !isRecord(event.message)) return [];
        const content = event.message.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .flatMap((part) =>
                    isRecord(part) && typeof part.text === "string" ? [part.text] : [],
                  )
                  .join("")
              : "";
        return [{ role: event.message.role, text }];
      });
      expect(
        messages.filter((message) => message.role === "user").map((message) => message.text),
      ).toEqual(questions);
      for (const answer of answers) {
        expect(
          messages.filter((message) => message.role === "assistant" && message.text === answer),
        ).toHaveLength(1);
      }
      if (closeAudio) expect(audioEvents).toBe(audioAtClose);
      else expect(audioEvents).toBeGreaterThan(0);
    } finally {
      releaseFirst.resolve();
      try {
        // Vitest may already have aborted its signal; cleanup must still join
        // the released real owners before the shared fixture closes SQLite.
        await Promise.all(ownerSettlements);
      } finally {
        observeEnqueue.mockRestore();
        if (!closed) await dispatch("talk.session.close", { sessionId });
      }
    }
  },
);
