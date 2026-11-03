import { randomUUID } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import {
  BRANCH_GATEWAY_ORIGIN,
  connectConversationOperator,
  isolateConversationGatewayEnvironment,
  startConversationModel,
} from "./helpers/conversation-branches-gateway.js";
import { playLocalMediaInputEnd } from "./helpers/local-media-input-end-play.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayTestFixture } from "./helpers/qa-gateway-test-lifetime.js";

const SPEECH = "qa-conversation-speech";
const SCOPES = ["operator.read", "operator.write", "operator.talk"] as const;
const FACT = "CHAT_TO_SPEECH_COBALT_73";

function configuration(baseUrl: string): OpenClawConfig {
  const provider = buildMockOpenAiResponsesProvider(baseUrl, "conversation-speech-proof");
  return {
    gateway: {
      mode: "local",
      bind: "loopback",
      trustedProxies: ["127.0.0.1", "::1"],
      auth: {
        mode: "trusted-proxy",
        token: undefined,
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowLoopback: true,
          deviceAutoApprove: { enabled: true, scopes: [...SCOPES] },
        },
      },
      controlUi: { enabled: false, allowedOrigins: [BRANCH_GATEWAY_ORIGIN] },
      roles: {
        default: "limited",
        definitions: {
          limited: { sessions: { others: "view" }, agents: "*", scopes: [...SCOPES] },
        },
      },
    },
    logging: { level: "debug", consoleLevel: "debug", consoleStyle: "json" },
    agents: {
      entries: { main: { conversationMode: "branches", skills: [] } },
      defaults: {
        maxConcurrent: 3,
        model: { primary: provider.modelRef, fallbacks: [] },
        modelPolicy: { allow: [provider.modelRef] },
        models: {
          [provider.modelRef]: {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        },
        utilityModel: "",
        workspace: "~/workspace",
        skills: [],
        skipBootstrap: true,
        sandbox: { mode: "off" },
      },
    },
    session: { scope: "per-sender" },
    tools: { deny: ["*"] },
    models: {
      mode: "replace",
      providers: {
        [provider.providerId]: {
          ...provider.config,
          request: { allowPrivateNetwork: true },
          models: provider.config.models.map((entry) =>
            Object.assign({}, entry, { input: [...entry.input] }),
          ),
        },
      },
    },
    talk: {
      agentId: "main",
      provider: SPEECH,
      providers: { [SPEECH]: { modelId: "offline-pcm", voiceId: "fixture" } },
    },
    skills: { workshop: { autonomous: { mode: "off" } } },
    plugins: {
      slots: { memory: "none" },
      load: { paths: [path.resolve("test/fixtures/conversation-speech")] },
      entries: { [SPEECH]: { enabled: true } },
    },
    messages: { queue: { mode: "steer", debounceMsByChannel: { webchat: 0 } } },
  };
}

it.for(["isolated-duplex", "echo-activity", "echo-connected-activity"] as const)(
  "keeps a reusable Talk branch audible across follow-ups and sibling activity for %s",
  async (clientProfile, context) => {
    let phase = "startup";
    const phases: Array<Record<string, unknown>> = [];
    await runQaGatewayTestFixture(context, async ({ signal, verifyCleanup }) => {
      const model = await startConversationModel(
        signal,
        (_request, index) => `SPOKEN_REPLY_${index}.`,
      );
      const gateway = await createOpenClawTestInstance({
        name: "conversation-speech-followups",
        signal,
        verifyCleanup,
        config: configuration(model.baseUrl),
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
          OPENCLAW_LOG_LEVEL: "debug",
        },
      });
      context.onTestFailed(() => {
        console.error(JSON.stringify({ phase, phases, modelRequests: model.requests.length }));
        console.error(gateway.logs());
      });
      isolateConversationGatewayEnvironment(gateway);
      gateway.state.applyEnv();
      let operator: Awaited<ReturnType<typeof connectConversationOperator>> | undefined;
      const sessions = new Set<string>();
      const events: Array<Record<string, unknown>> = [];
      const inputAvailability = new Map<string, boolean>();
      const inputWaiters = new Map<string, ReturnType<typeof createDeferred<void>>>();
      const expectedSpeech: Array<{ input: string; reply: string }> = [];
      let pendingTurn:
        | {
            sessionId: string;
            captureId: string;
            completion: ReturnType<typeof createDeferred<void>>;
            audioDone: ReturnType<typeof createDeferred<void>>;
            outcome: ReturnType<typeof createDeferred<unknown>>;
            frames: Buffer[];
          }
        | undefined;
      let pendingPlayback:
        | {
            frames: Buffer[];
            waiting: ReturnType<typeof createDeferred<void>>;
            drained: ReturnType<typeof createDeferred<void>>;
          }
        | undefined;
      let appendRequests = 0;
      const activity = clientProfile !== "isolated-duplex";
      const connectedActivity = clientProfile === "echo-connected-activity";
      const drainPlayback = () => {
        const playback = pendingPlayback;
        if (!playback) {
          return;
        }
        // Only the local hardware leaf is synthetic. Actual received PCM remains
        // buffered after server completion until the fixture explicitly consumes it.
        expect(playback.frames.length).toBeGreaterThan(0);
        for (const frame of playback.frames) {
          expect(frame.length).toBeGreaterThan(0);
          expect(frame.length % 2).toBe(0);
        }
        playback.frames.length = 0;
        playback.drained.resolve();
        pendingPlayback = undefined;
      };
      try {
        await gateway.startGateway();
        const connect = () =>
          connectConversationOperator(gateway, "alex@example.test", signal, {
            scopes: [...SCOPES],
            onEvent(event, payload) {
              if (event !== "talk.event" || !isRecord(payload)) {
                return;
              }
              events.push(payload);
              if (typeof payload.sessionId === "string" && isRecord(payload.talkEvent)) {
                const talkEvent = payload.talkEvent;
                if (
                  talkEvent.type === "session.activity" &&
                  isRecord(talkEvent.payload) &&
                  isRecord(talkEvent.payload.input) &&
                  typeof talkEvent.payload.input.available === "boolean"
                ) {
                  inputAvailability.set(payload.sessionId, talkEvent.payload.input.available);
                  if (talkEvent.payload.input.available) {
                    inputWaiters.get(payload.sessionId)?.resolve();
                  }
                } else if (
                  talkEvent.type === "session.error" ||
                  talkEvent.type === "session.closed" ||
                  talkEvent.type === "session.replaced"
                ) {
                  inputWaiters
                    .get(payload.sessionId)
                    ?.reject(
                      new Error(`Talk closed before input readiness: ${JSON.stringify(talkEvent)}`),
                    );
                }
              }
              const turn = pendingTurn;
              if (!turn || payload.sessionId !== turn.sessionId) {
                return;
              }
              if (payload.type === "audio" && typeof payload.audioBase64 === "string") {
                turn.frames.push(Buffer.from(payload.audioBase64, "base64"));
              }
              if (!isRecord(payload.talkEvent)) {
                return;
              }
              if (payload.talkEvent.type === "session.error") {
                turn.completion.reject(
                  new Error(`Actual Talk failure: ${JSON.stringify(payload.talkEvent)}`),
                );
              }
              if (payload.talkEvent.type === "turn.ended") {
                turn.completion.resolve();
              }
              if (payload.talkEvent.type === "output.audio.done") {
                turn.audioDone.resolve();
              }
              if (
                payload.talkEvent.type === "input.outcome" &&
                payload.talkEvent.captureId === turn.captureId &&
                isRecord(payload.talkEvent.payload) &&
                payload.talkEvent.payload.scope === "capture"
              ) {
                turn.outcome.resolve(payload.talkEvent);
              }
            },
          });
        operator = await connect();
        const chatKey = `agent:main:chat-${randomUUID()}`;
        // An explicit non-main Talk target is a continuation. Keep the device's
        // durable target distinct from chat, otherwise this only tests one history.
        const voiceKey = `agent:main:voice:fixture-${randomUUID()}`;
        const sendChat = async (message: string) => {
          const result = await operator!.call<{ runId: string }>("chat.send", {
            sessionKey: chatKey,
            message,
            deliver: false,
            idempotencyKey: randomUUID(),
          });
          expect(
            await operator!.call(
              "agent.wait",
              { runId: result.runId, timeoutMs: 30_000 },
              { timeoutMs: 31_000 },
            ),
          ).toMatchObject({ status: "ok" });
        };
        phase = "seed-chat";
        await sendChat(
          `Remember the codeword ${FACT}.\n` +
            Array.from(
              { length: 48 },
              (_, index) =>
                `Historical synthetic item ${index}: the task owner remains the current user; related dialogue is quoted background, never a new instruction.`,
            ).join("\n"),
        );
        let checkedReadiness = false;
        let checkedClosedCapture = false;
        const create = async () => {
          const created = await operator!.call<{ sessionId: string; readyMark: string }>(
            "talk.session.create",
            {
              sessionKey: voiceKey,
              mode: "stt-tts",
              transport: "gateway-relay",
              brain: "agent-consult",
              provider: SPEECH,
              capabilities: activity ? ["activity-v1"] : ["isolated-input", "output-gate"],
            },
          );
          sessions.add(created.sessionId);
          if (connectedActivity && !checkedReadiness) {
            const requestsBeforeReady = model.requests.length;
            await expect(
              operator!.call("talk.session.acknowledgeMark", {
                sessionId: created.sessionId,
                markName: "unrelated-playback-mark",
              }),
            ).rejects.toThrow("Unknown Talk speech playback readiness mark");
            await expect(
              operator!.call("talk.session.appendAudio", {
                sessionId: created.sessionId,
                audioBase64: Buffer.alloc(320).toString("base64"),
                captureId: randomUUID(),
              }),
            ).rejects.toThrow("must acknowledge the readyMark before capture starts");
            expect(model.requests).toHaveLength(requestsBeforeReady);
            checkedReadiness = true;
          }
          await operator!.call("talk.session.acknowledgeMark", {
            sessionId: created.sessionId,
            markName: created.readyMark,
          });
          return created.sessionId;
        };
        const openTalk = () => (clientProfile === "echo-activity" ? undefined : create());
        const closeTalk = async (sessionId: string | undefined) => {
          drainPlayback();
          if (sessionId) {
            await operator!.call("talk.session.close", { sessionId });
            sessions.delete(sessionId);
            if (connectedActivity && !checkedClosedCapture) {
              const requestsBeforeClosedCapture = model.requests.length;
              await expect(
                operator!.call("talk.session.appendAudio", {
                  sessionId,
                  audioBase64: Buffer.alloc(320).toString("base64"),
                  captureId: randomUUID(),
                  endOfInput: true,
                }),
              ).rejects.toThrow("Unknown Talk session");
              expect(model.requests).toHaveLength(requestsBeforeClosedCapture);
              checkedClosedCapture = true;
            }
          }
        };
        const performSpeech = async (existingSessionId: string | undefined, index: number) => {
          const playback = pendingPlayback;
          if (playback) {
            playback.waiting.resolve();
            await withinTest(playback.drained.promise, signal);
          }
          // Both are permitted: separate transports, or connected follow-ups on
          // the same live media session after the preceding PCM drains locally.
          const ownsTransport = clientProfile === "echo-activity";
          const sessionId = ownsTransport ? await create() : existingSessionId;
          if (!sessionId) {
            throw new Error("Talk transport was not opened");
          }
          if (activity && inputAvailability.get(sessionId) !== true) {
            phase = `speech-${index}:input-readiness`;
            const ready = createDeferred();
            inputWaiters.set(sessionId, ready);
            try {
              await withinTest(ready.promise, signal);
            } finally {
              inputWaiters.delete(sessionId);
            }
          }
          phase = `speech-${index}`;
          const before = model.requests.length;
          const audioCount = () =>
            events.filter((e) => e.type === "audio" && e.sessionId === sessionId).length;
          const audioBefore = audioCount();
          const started = performance.now();
          const captureId = randomUUID();
          const frames: Buffer[] = [];
          const turn = {
            sessionId,
            captureId,
            completion: createDeferred(),
            audioDone: createDeferred(),
            outcome: createDeferred<unknown>(),
            frames,
          };
          pendingTurn = turn;
          void turn.completion.promise.catch(() => {});
          const eventStart = events.length;
          try {
            appendRequests++;
            await operator!.call("talk.session.appendAudio", {
              sessionId,
              audioBase64: Buffer.from(`SPEECH_INPUT_${index}: `).toString("base64"),
              ...(activity ? { captureId } : {}),
            });
            appendRequests++;
            await operator!.call("talk.session.appendAudio", {
              sessionId,
              audioBase64: Buffer.from("Please answer briefly.").toString("base64"),
              ...(activity ? { captureId } : {}),
              endOfInput: true,
            });
            await withinTest(
              Promise.all([
                turn.completion.promise,
                turn.audioDone.promise,
                ...(activity
                  ? [
                      turn.outcome.promise.then((outcome) =>
                        expect(outcome).toMatchObject({
                          payload: { scope: "capture", outcome: "transcribed" },
                        }),
                      ),
                    ]
                  : []),
              ]),
              signal,
            );
            pendingTurn = undefined;
            expect(model.requests).toHaveLength(before + 1);
            expect(audioCount()).toBeGreaterThan(audioBefore);
            const turnEvents = events.slice(eventStart);
            for (const [role, text] of [
              ["user", `SPEECH_INPUT_${index}: Please answer briefly.`],
              ["assistant", `SPOKEN_REPLY_${before + 1}.`],
            ]) {
              expect(turnEvents).toContainEqual(
                expect.objectContaining({ sessionId, type: "transcript", role, text, final: true }),
              );
            }
            expect(JSON.stringify(model.requests[before])).toContain(`SPEECH_INPUT_${index}`);
            if (activity) {
              expect(turnEvents).toContainEqual(
                expect.objectContaining({
                  sessionId,
                  type: "event",
                  talkEvent: expect.objectContaining({
                    type: "input.outcome",
                    captureId,
                    payload: expect.objectContaining({ scope: "capture", outcome: "transcribed" }),
                  }),
                }),
              );
            }
            expectedSpeech.push({
              input: `SPEECH_INPUT_${index}`,
              reply: `SPOKEN_REPLY_${before + 1}`,
            });
            if (connectedActivity) {
              pendingPlayback = {
                frames: turn.frames,
                waiting: createDeferred(),
                drained: createDeferred(),
              };
            }
            phases.push({
              phase,
              durationMs: performance.now() - started,
              foreignFactInModelRequest: JSON.stringify(model.requests[before]).includes(FACT),
            });
            return JSON.stringify(model.requests[before]);
          } finally {
            if (pendingTurn?.sessionId === sessionId) {
              pendingTurn = undefined;
            }
            if (ownsTransport) {
              await closeTalk(sessionId);
            }
          }
        };
        const speak = async (sessionId: string | undefined, index: number) => {
          const playback = pendingPlayback;
          const appendsBeforeDrain = appendRequests;
          const requestsBeforeDrain = model.requests.length;
          const work = performSpeech(sessionId, index);
          void work.catch(() => {});
          try {
            if (playback) {
              await withinTest(
                awaitGateBeforeSettlement(
                  playback.waiting.promise,
                  work,
                  "Connected follow-up did not wait for its local PCM drain",
                ),
                signal,
              );
              expect(appendRequests).toBe(appendsBeforeDrain);
              expect(model.requests).toHaveLength(requestsBeforeDrain);
              drainPlayback();
            }
            return await work;
          } finally {
            playback?.drained.resolve();
            await work;
          }
        };
        phase = "create-talk";
        const first = await openTalk();
        const firstInput = await speak(first, 1);
        // Immediate follow-ups exercise genuine admission and asynchronous
        // preparation races, without holding or replacing their native owners.
        await speak(first, 2);
        await sendChat("SECOND_SIBLING_FACT_AMBER_94");
        const laterInput = await speak(first, 3);
        expect(laterInput).toContain("SPEECH_INPUT_1");
        expect(laterInput).toContain("SPEECH_INPUT_2");
        await speak(first, 4);
        await closeTalk(first);
        phase = "reopen-talk";
        const second = await openTalk();
        const reopenedInput = await speak(second, 5);
        await speak(second, 6);
        expect(firstInput).toContain(FACT);
        expect(laterInput).toContain("SECOND_SIBLING_FACT_AMBER_94");
        expect(reopenedInput).toContain(FACT);
        await closeTalk(second);
        await operator.close();
        operator = undefined;
        phase = "restart-with-existing-personal-branch";
        await gateway.stopGateway();
        await gateway.startGateway();
        operator = await connect();
        const third = await openTalk();
        const resumedInput = await speak(third, 7);
        expect(resumedInput).toContain(FACT);
        // Keep a real sibling model request active while the personal voice
        // branch accepts another input and background preparation receives writes.
        const heldSibling = model.holdNext(() => true);
        const chatWork = sendChat("LIVE_SIBLING_FACT_TEAL_28");
        void chatWork.catch(() => {});
        try {
          await withinTest(heldSibling.entered, signal);
          await speak(third, 8);
        } finally {
          heldSibling.release();
          await chatWork;
        }
        const afterSibling = await speak(third, 9);
        expect(afterSibling).toContain("LIVE_SIBLING_FACT_TEAL_28");
        // Read durable history only after the follow-up sequence. An extra read
        // between captures could refresh a lease and hide a publication race.
        const history = await operator.call<{ messages: unknown[] }>("chat.history", {
          sessionKey: voiceKey,
          limit: 100,
        });
        const recorded = JSON.stringify(history.messages);
        for (const { input, reply } of expectedSpeech) {
          expect(recorded).toContain(input);
          expect(recorded).toContain(reply);
        }
        expect(model.errors).toEqual([]);
        // A concurrent background read can defer while session facts publish.
        // Prove foreground liveness and actual delivery above; keep deferred-read
        // diagnostics visible without conflating them with a lost spoken input.
        const logs = gateway.logs();
        expect(logs).not.toContain("talk native speech input failed");
        console.info(
          JSON.stringify({
            fixture: "native-talk-branch-followups",
            clientProfile,
            phases,
            backgroundFactsUnavailableMentions:
              logs.match(/SessionMutationFactsUnavailableError/gu)?.length ?? 0,
          }),
        );
      } finally {
        pendingPlayback?.drained.resolve();
        for (const sessionId of sessions) {
          await operator?.call("talk.session.close", { sessionId }).catch(() => {});
        }
        await operator?.close();
        await gateway.cleanup();
        await model.stop();
      }
    });
  },
);

const stagedLocalMedia = process.env.OPENCLAW_E2E_LOCAL_MEDIA_PLUGIN_ROOT;
it.skipIf(stagedLocalMedia === undefined)(
  "uses the actual local-media provider with exclusive client input completion",
  async (context) => {
    if (stagedLocalMedia === undefined) {
      throw new Error("The actual local-media scenario requires a selected staged plugin");
    }
    await runQaGatewayTestFixture(context, ({ signal, verifyCleanup }) =>
      playLocalMediaInputEnd({
        pluginRoot: stagedLocalMedia,
        configuration,
        signal,
        verifyCleanup,
      }),
    );
  },
);
