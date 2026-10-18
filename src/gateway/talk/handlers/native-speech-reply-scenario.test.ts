import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import * as nativeQueue from "../../../auto-reply/reply/queue.js";
import { replyRunRegistry } from "../../../auto-reply/reply/reply-run-registry.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
} from "../../../config/sessions/session-accessor.js";
import {
  pendingSessionEntryPublications,
  preparedSharingReads,
} from "../../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { getUnifiedTalkSession } from "../../../talk/session-registry.js";
import * as sessionSharingPreparation from "../../session-sharing-preparation.js";
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
    const nativeFailure = createDeferredCore<never>();
    void nativeFailure.promise.catch(() => {});
    const progress = (stage: string) =>
      console.info(`[native-speech-scenario close=${closeAudio}] ${stage}`);
    // The shared fixture normally silences the real runtime logger. Preserve
    // its exact synthetic failure before Speech emits its intentionally generic
    // session.error; otherwise an admission failure looks like a queue timeout.
    vi.mocked(context.logGateway.warn).mockImplementation((...args) => {
      console.warn(`[native-speech-scenario close=${closeAudio}] native-warning`, ...args);
    });
    const waitAt = async (stage: string, work: PromiseLike<unknown>) => {
      progress(`waiting:${stage}`);
      await withinTest(Promise.race([work, nativeFailure.promise]), signal);
      progress(`reached:${stage}`);
    };
    const ownerSettlements: Promise<void>[] = [];
    const questions = ["Inspect the first synthetic item.", "Also inspect the second item."];
    const answers = ["The first inspection completed.", "The second inspection completed."];
    const modelPrompts: string[] = [];
    let audioEvents = 0;
    let closed = false;
    let calls = 0;
    let audioAtClose = 0;
    const enqueue = nativeQueue.enqueueFollowupRun;
    const prepareFacts = sessionSharingPreparation.prepareSessionMutationFacts;
    // Observation only: retain the actual storage/admission owner and rethrow
    // its original error, including the exact native frame and nested cause.
    const observeFacts = vi
      .spyOn(sessionSharingPreparation, "prepareSessionMutationFacts")
      .mockImplementation(async (...args) => {
        try {
          const prepared = await prepareFacts(...args);
          return {
            ...prepared,
            readCurrent(cfg) {
              try {
                return prepared.readCurrent(cfg);
              } catch (error) {
                console.warn("[native-speech-scenario] native-access-read-failure", error);
                console.warn(
                  "[native-speech-scenario] native-publication-state",
                  JSON.stringify(
                    [...preparedSharingReads].map(([key, reads]) => ({
                      key,
                      reads: [...reads].map((read) => ({
                        factsPresent: read.facts !== undefined,
                        entryPresent: read.facts?.entry !== undefined,
                        pendingFields: read.pending.size,
                        acquiringInvalidated: read.acquisition?.invalidated,
                      })),
                      publications: [...(pendingSessionEntryPublications.get(key) ?? [])].map(
                        (publication) => ({
                          settled: publication.settled,
                          sharingUnchanged: [...publication.sharingUnchanged],
                          generationUnchanged: [...publication.generationUnchanged],
                          membershipInvalidated: [...publication.membershipInvalidated],
                          superseded: [...publication.superseded.keys()],
                        }),
                      ),
                    })),
                  ),
                );
                throw error;
              }
            },
          };
        } catch (error) {
          console.warn("[native-speech-scenario] native-access-prepare-failure", error);
          throw error;
        }
      });
    const observeEnqueue = vi
      .spyOn(nativeQueue, "enqueueFollowupRun")
      .mockImplementation((...args) => {
        const accepted = enqueue(...args);
        if (accepted) {
          progress("actual-enqueue-accepted");
          queued.resolve();
        }
        return accepted;
      });
    vi.mocked(context.broadcastToConnIds).mockImplementation((_name, payload) => {
      if (!isRecord(payload)) return;
      if (payload.type === "audio") audioEvents++;
      if (isRecord(payload.talkEvent) && payload.talkEvent.type === "session.error") {
        progress("native-session-error");
        nativeFailure.reject(
          new Error("Native speech reported session.error", {
            cause: { payload, warnings: vi.mocked(context.logGateway.warn).mock.calls },
          }),
        );
      }
      if (isRecord(payload.talkEvent) && payload.talkEvent.type === "turn.ended")
        turnEnded.resolve();
    });
    mocks.runEmbeddedAgent.mockImplementation(async (params) =>
      publishNativeSpeechModelRun(params, async () => {
        const index = calls++;
        progress(`actual-model-start:${index + 1}`);
        if (index > 1) throw new Error("Accepted native input was replayed");
        modelPrompts.push(params.prompt);
        params.onExecutionPhase?.({ phase: "model_call_started" });
        const operation = replyRunRegistry.get(params.sessionKey!);
        if (!operation?.ownerSettlement) throw new Error("Actual native reply owner is missing");
        ownerSettlements.push(operation.ownerSettlement);
        if (index === 0) {
          firstStarted.resolve();
          progress("waiting:first-model-release");
          await releaseFirst.promise;
          progress("reached:first-model-release");
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
    progress("before-create");
    const { sessionId, readyMark, target } = await createSpeechRelayCall();
    progress("after-create");
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
      await waitAt(
        "first-model-start",
        awaitGateBeforeSettlement(
          firstStarted.promise,
          turnEnded.promise,
          "Native speech ended before starting the first model run",
        ),
      );
      stt.onTranscript(questions[1]!, { utteranceId: "scenario-input-two" });
      // The native enqueue return, not the earlier transcript event, proves acceptance.
      await waitAt("actual-enqueue", queued.promise);
      expect(calls).toBe(1);
      expect(nativeQueue.getFollowupQueueDepth(target.canonicalKey)).toBe(1);
      if (closeAudio) {
        progress("before-close");
        expect(await dispatch("talk.session.close", { sessionId })).toHaveBeenCalledWith(
          true,
          { ok: true },
          undefined,
        );
        closed = true;
        progress("after-close");
        audioAtClose = audioEvents;
        expect(() => getUnifiedTalkSession(sessionId)).toThrow();
      }
      releaseFirst.resolve();
      await waitAt("second-model-start", secondStarted.promise);
      await waitAt("native-owner-settlement", Promise.all(ownerSettlements));
      if (!closeAudio) await waitAt("turn-ended", turnEnded.promise);
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
      progress("cleanup-release-first");
      releaseFirst.resolve();
      try {
        // Vitest may already have aborted its signal; cleanup must still join
        // the released real owners before the shared fixture closes SQLite.
        await Promise.all(ownerSettlements);
        progress("cleanup-owners-settled");
      } finally {
        observeFacts.mockRestore();
        observeEnqueue.mockRestore();
        if (!closed) await dispatch("talk.session.close", { sessionId });
        progress("cleanup-closed");
      }
    }
  },
);
