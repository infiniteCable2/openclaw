import "../../../config/sessions/session-accessor.sqlite-replacement-publication.test-support.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../../../agents/test-helpers/agent-message-fixtures.js";
import type { InternalGetReplyFromConfig } from "../../../auto-reply/reply/get-reply.types.js";
import * as nativeQueue from "../../../auto-reply/reply/queue.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
} from "../../../config/sessions/session-accessor.js";
import {
  pendingSessionEntryPublications,
  preparedSharingReads,
} from "../../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { assertSessionConversationRootEntry } from "../../../config/sessions/session-conversation-admission.js";
import { ensureAgentConversationRoot } from "../../../config/sessions/session-conversation-root.js";
import { resolveAgentSpeechConversationRoute } from "../../../routing/conversation-mode.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { getSessionControllerOperation } from "../../../sessions/session-controller.js";
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
} from "./native-speech.test-support.js";

const { getReplacementPublicationDelivery } =
  await import("../../../config/sessions/session-accessor.sqlite-replacement-publication.test-support.js");

const replyObservation = vi.hoisted(() => ({
  invoke: undefined as
    | ((
        original: InternalGetReplyFromConfig,
        ...args: Parameters<InternalGetReplyFromConfig>
      ) => ReturnType<InternalGetReplyFromConfig>)
    | undefined,
}));
// Keep the real reply resolver, including its source guard, behind a stable
// observation boundary even after the Talk runtime caches its lazy import.
vi.mock("../../../auto-reply/reply/get-reply.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../auto-reply/reply/get-reply.js")>();
  return {
    ...actual,
    getReplyFromConfig: (...args: Parameters<InternalGetReplyFromConfig>) =>
      replyObservation.invoke
        ? replyObservation.invoke(actual.getReplyFromConfig, ...args)
        : actual.getReplyFromConfig(...args),
  };
});

// The existing fixture substitutes only STT/TTS hardware and the model runtime.
// Admission, source capabilities, Speech/V2/getReply, native follow-up queue and
// transcript writes remain real. Model counts are NOT proof of actual tool effects.
afterEach(() => {
  replyObservation.invoke = undefined;
  vi.restoreAllMocks();
});

it.for([
  { conversationMode: "native", closeAudio: false, sequential: false },
  { conversationMode: "native", closeAudio: true, sequential: false },
  { conversationMode: "branches", closeAudio: false, sequential: false },
  { conversationMode: "branches", closeAudio: true, sequential: false },
  { conversationMode: "native", closeAudio: false, sequential: true },
  { conversationMode: "branches", closeAudio: false, sequential: true },
  { conversationMode: "branches", closeAudio: false, sequential: true, overlap: true },
] as const)(
  "native Speech serializes two original inputs exactly once in $conversationMode after audio-close=$closeAudio sequential=$sequential overlap=$overlap",
  async (scenario, { signal }) => {
    const { conversationMode, closeAudio, sequential } = scenario;
    const overlap = "overlap" in scenario && scenario.overlap;
    let root: Awaited<ReturnType<typeof ensureAgentConversationRoot>> | undefined;
    if (conversationMode === "branches") {
      const cfg = testState.config;
      testState.config = {
        ...cfg,
        session: { scope: "per-sender" },
        agents: {
          ...cfg.agents,
          entries: {
            ...cfg.agents?.entries,
            voice: { ...cfg.agents?.entries?.voice, conversationMode },
          },
        },
      };
      // Use the actual Host infrastructure owner, never fabricated topology or
      // a private-history donor. The same authenticated caller then creates its branch.
      root = await ensureAgentConversationRoot({
        cfg: testState.config,
        agentId: "voice",
        getConfig: () => testState.config,
        signal,
      });
    } else {
      testState.config.session = { mainKey: "scenario", scope: "global" };
    }
    const ttsReleases = [createDeferredCore(), createDeferredCore()];
    let ttsReleaseCount = 0;
    const hardware = installSyntheticSpeechHardware({
      onTurnTtsReleased: () => ttsReleases[ttsReleaseCount++]?.resolve(),
    });
    const firstStarted = createDeferredCore();
    const secondStarted = createDeferredCore();
    const queued = createDeferredCore();
    const releaseFirst = createDeferredCore();
    const turnEnds = [createDeferredCore(), createDeferredCore()];
    let turnEndCount = 0;
    const nativeFailure = createDeferredCore<never>();
    void nativeFailure.promise.catch(() => {});
    const progress = (stage: string) =>
      console.info(
        `[native-speech-scenario mode=${conversationMode} close=${closeAudio}] ${stage}`,
      );
    // The shared fixture normally silences the real runtime logger. Preserve
    // its exact synthetic failure before Speech emits its intentionally generic
    // session.error; otherwise an admission failure looks like a queue timeout.
    vi.mocked(context.logGateway.warn).mockImplementation((...args) => {
      console.warn(
        `[native-speech-scenario mode=${conversationMode} close=${closeAudio}] native-warning`,
        ...args,
      );
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
    let sessionErrors = 0;
    let closed = false;
    let calls = 0;
    let audioAtClose = 0;
    const releaseOverlap = createDeferredCore();
    const overlapCommitted = createDeferredCore();
    let overlapMutation: Promise<unknown> | undefined;
    let overlapReads = 0;
    let overlapPublications = 0;
    let replyCalls = 0;
    const delivery = getReplacementPublicationDelivery();
    if (overlap) {
      replyObservation.invoke = async (original, ctx, options, cfg) => {
        if (++replyCalls !== 2) {
          return original(ctx, options, cfg);
        }
        const assertCurrent = options?.assertSourceCurrent;
        if (!assertCurrent) {
          throw new Error("Native reply source guard is missing");
        }
        delivery.afterResult = async (result) => {
          const current =
            isRecord(result) && isRecord(result.publication)
              ? result.publication.current
              : undefined;
          const entry = current instanceof Map ? current.get(target.canonicalKey) : undefined;
          if (!isRecord(entry) || entry.category !== "reviewed") {
            return;
          }
          delivery.afterResult = undefined;
          overlapPublications++;
          overlapCommitted.resolve();
          await releaseOverlap.promise;
        };
        overlapMutation = applySessionEntryExactReplacements({
          ...target,
          sessionKeys: [target.canonicalKey],
          assertCommitAllowed: assertCurrent,
          update: ([row]) => ({
            result: undefined,
            replacements: [
              { sessionKey: target.canonicalKey, entry: { ...row!.entry, category: "reviewed" } },
            ],
          }),
        });
        await waitAt(
          "overlap-native-commit",
          awaitGateBeforeSettlement(
            overlapCommitted.promise,
            overlapMutation,
            "Native overlap write settled before delayed delivery",
          ),
        );
        // Observe the original prepared authority, preserving its native writer
        // hooks. Release delivery after its first real assertion, even on red.
        const observeCurrent = Object.assign(() => {
          try {
            assertCurrent();
          } finally {
            overlapReads++;
            releaseOverlap.resolve();
          }
        }, assertCurrent);
        try {
          return await original(ctx, { ...options, assertSourceCurrent: observeCurrent }, cfg);
        } finally {
          releaseOverlap.resolve();
          await overlapMutation;
          delivery.afterResult = undefined;
        }
      };
    }
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
      if (!isRecord(payload)) {
        return;
      }
      if (payload.type === "audio") {
        audioEvents++;
      }
      if (isRecord(payload.talkEvent) && payload.talkEvent.type === "session.error") {
        sessionErrors++;
        progress("native-session-error");
        nativeFailure.reject(
          new Error("Native speech reported session.error", {
            cause: { payload, warnings: vi.mocked(context.logGateway.warn).mock.calls },
          }),
        );
      }
      if (isRecord(payload.talkEvent) && payload.talkEvent.type === "turn.ended") {
        turnEnds[turnEndCount++]?.resolve();
      }
    });
    mocks.runEmbeddedAgent.mockImplementation(async (params) =>
      publishNativeSpeechModelRun(params, async (persistAssistantMessage) => {
        const index = calls++;
        progress(`actual-model-start:${index + 1}`);
        if (index > 1) {
          throw new Error("Accepted native input was replayed");
        }
        expect(params.sessionKey).toBe(target.canonicalKey);
        modelPrompts.push(params.prompt);
        params.onExecutionPhase?.({ phase: "model_call_started" });
        const operation = getSessionControllerOperation(params.sessionKey!);
        if (!operation?.ownerSettlement) {
          throw new Error("Actual native reply owner is missing");
        }
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
        const modelMessage = makeAgentAssistantMessage({
          model: "synthetic-native-consult",
          content: [{ type: "text", text: answers[index]! }],
        });
        await persistAssistantMessage(modelMessage);
        await params.onBlockReply?.({ text: answers[index] });
        await params.waitForPendingInput?.(params.abortSignal);
        return { payloads: [{ text: answers[index]! }], meta: { durationMs: 0 } };
      }),
    );
    progress("before-create");
    const { sessionId, readyMark, target } = await createSpeechRelayCall();
    progress("after-create");
    try {
      if (root) {
        const route = resolveAgentSpeechConversationRoute({
          cfg: testState.config,
          agentId: target.agentId,
          channel: "talk",
          accountId: "gateway",
          sourceSessionKey: root.sessionKey,
          conversationId: testState.client.connId,
        });
        expect(target.canonicalKey).toBe(route.sessionKey);
        expect(target.canonicalKey).not.toBe(root.sessionKey);
        expect(isSubagentSessionKey(target.canonicalKey)).toBe(false);
        const branch = loadSessionEntry({
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
          storePath: target.storePath,
        });
        expect(branch?.conversationTopology).toEqual({
          version: 1,
          role: "branch",
          rootSessionKey: root.sessionKey,
          rootSessionId: root.entry.sessionId,
          rootSessionLifecycleRevision: root.entry.lifecycleRevision,
        });
        expect(branch?.parentSessionKey).toBeUndefined();
        expect(branch?.spawnedBy).toBeUndefined();
      }
      expect(
        await dispatch("talk.session.acknowledgeMark", { sessionId, markName: readyMark }),
      ).toHaveBeenCalledWith(true, { ok: true }, undefined);
      const stt = vi.mocked(hardware.provider.createSession).mock.calls[0]?.[0];
      if (!stt?.onTranscript || !stt.onSpeechActivity) {
        throw new Error("Actual STT capture callbacks are missing");
      }
      stt.onTranscript(questions[0]!, { utteranceId: "scenario-input-one" });
      // The second utterance begins while the first input is still preparing,
      // before a model run exists. Its delayed final transcript must follow up,
      // not steer whichever backend happens to be active when decoding finishes.
      if (!sequential) {
        stt.onSpeechActivity({ utteranceId: "scenario-input-two", state: "candidate" });
      }
      await waitAt(
        "first-model-start",
        awaitGateBeforeSettlement(
          firstStarted.promise,
          turnEnds[0]!.promise,
          "Native speech ended before starting the first model run",
        ),
      );
      if (sequential) {
        // A completed speech turn must leave this logical session ready for a
        // later utterance, independently of the in-flight follow-up queue.
        releaseFirst.resolve();
        await waitAt("first-owner-settlement", ownerSettlements[0]!);
        await waitAt("first-turn-ended", turnEnds[0]!.promise);
        await waitAt("first-tts-release", ttsReleases[0]!.promise);
        expect(calls).toBe(1);
        expect(nativeQueue.getFollowupQueueDepth(target.canonicalKey)).toBe(0);
        stt.onSpeechActivity({ utteranceId: "scenario-input-two", state: "candidate" });
        stt.onTranscript(questions[1]!, { utteranceId: "scenario-input-two" });
      } else {
        stt.onTranscript(questions[1]!, { utteranceId: "scenario-input-two" });
        // The native enqueue return, not the earlier transcript event, proves acceptance.
        await waitAt("actual-enqueue", queued.promise);
        expect(calls).toBe(1);
        expect(nativeQueue.getFollowupQueueDepth(target.canonicalKey)).toBe(1);
      }
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
      if (!closeAudio) {
        const lastTurn = sequential ? 1 : 0;
        await waitAt("turn-ended", turnEnds[lastTurn]!.promise);
        await waitAt("tts-release", ttsReleases[lastTurn]!.promise);
      }
      expect(calls).toBe(2);
      expect(modelPrompts[0]).toContain(questions[0]);
      expect(modelPrompts[1]).toContain(questions[1]);
      const entry = loadSessionEntry({
        agentId: target.agentId,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
      });
      if (!entry) {
        throw new Error("Native conversation disappeared after accepted work");
      }
      const messages = readSessionTranscriptMessageEvents({
        agentId: target.agentId,
        sessionId: entry.sessionId,
        storePath: target.storePath,
      }).flatMap(({ event }) => {
        if (!isRecord(event) || !isRecord(event.message)) {
          return [];
        }
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
      if (root) {
        const currentRoot = loadSessionEntry({
          agentId: target.agentId,
          sessionKey: root.sessionKey,
          storePath: target.storePath,
        });
        assertSessionConversationRootEntry(currentRoot, root.sessionKey);
        expect(currentRoot.sessionId).toBe(root.entry.sessionId);
        expect(currentRoot.lifecycleRevision).toBe(root.entry.lifecycleRevision);
        expect(
          readSessionTranscriptMessageEvents({
            agentId: target.agentId,
            sessionId: currentRoot.sessionId,
            storePath: target.storePath,
          }),
        ).toHaveLength(0);
      }
      if (closeAudio) {
        expect(audioEvents).toBe(audioAtClose);
      } else {
        expect(audioEvents).toBeGreaterThan(0);
        expect(
          mocks.streamSpeech.mock.calls
            .map(([request]) => request.text)
            .filter((text) => text === answers[1]),
        ).toEqual([answers[1]]);
        expect(hardware.releaseStream).toHaveBeenCalledTimes(mocks.streamSpeech.mock.calls.length);
        if (sequential) {
          expect(turnEndCount).toBe(2);
          expect(ttsReleaseCount).toBe(2);
          for (const answer of answers) {
            expect(
              mocks.streamSpeech.mock.calls
                .map(([request]) => request.text)
                .filter((text) => text === answer),
            ).toEqual([answer]);
          }
        }
      }
      expect(sessionErrors).toBe(0);
      if (overlap) {
        expect(overlapPublications).toBe(1);
        expect(overlapReads).toBeGreaterThan(0);
        expect(entry.category).toBe("reviewed");
      }
    } finally {
      progress("cleanup-release-first");
      releaseFirst.resolve();
      releaseOverlap.resolve();
      try {
        // Vitest may already have aborted its signal; cleanup must still join
        // the released real owners before the shared fixture closes SQLite.
        await Promise.all([...ownerSettlements, overlapMutation]);
        progress("cleanup-owners-settled");
      } finally {
        observeFacts.mockRestore();
        delivery.afterResult = undefined;
        replyObservation.invoke = undefined;
        observeEnqueue.mockRestore();
        if (!closed) {
          await dispatch("talk.session.close", { sessionId });
        }
        progress("cleanup-closed");
      }
    }
  },
);
