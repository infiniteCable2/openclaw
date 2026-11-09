import { randomUUID } from "node:crypto";
import path from "node:path";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { workshopPluginConfig } from "../src/skills/test-support/workshop-config.test-support.js";
import {
  BRANCH_GATEWAY_ORIGIN,
  connectConversationOperator,
  isolateConversationGatewayEnvironment,
  startConversationModel,
  waitForConversationTransfer,
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
  return workshopPluginConfig(
    { autonomous: { mode: "off" } },
    {
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
      plugins: {
        slots: { memory: "none" },
        load: { paths: [path.resolve("test/fixtures/conversation-speech")] },
        entries: { [SPEECH]: { enabled: true } },
      },
      messages: { queue: { mode: "steer", debounceMsByChannel: { webchat: 0 } } },
    },
  );
}

function completeGatewayLogLines(logs: string) {
  return logs
    .split("\n")
    .filter((line) => {
      // The bounded log tail may start inside an older JSON record.
      try {
        return isRecord(JSON.parse(line));
      } catch {
        return false;
      }
    })
    .map((line) => line.replaceAll('\\"', '"'));
}

function restartPreparationCounts(
  gateway: Awaited<ReturnType<typeof createOpenClawTestInstance>>,
  recipientId: string,
  excludedLines: ReadonlySet<string> = new Set(),
) {
  const recipient = redactIdentifier(recipientId);
  const lines = completeGatewayLogLines(gateway.logs()).filter((line) => !excludedLines.has(line));
  return {
    restored: lines.filter(
      (line) =>
        line.includes("Reusable conversation recipient restored") && line.includes(recipient),
    ).length,
    prepared: lines.filter(
      (line) =>
        line.includes("Related-history source preparation settled") &&
        line.includes(recipient) &&
        /"preparingSources"\s*:\s*true/u.test(line) &&
        /"hasContinuation"\s*:\s*false/u.test(line) &&
        /"saturated"\s*:\s*false/u.test(line),
    ).length,
  };
}

/** Observe native enrollment or settled preparation without dispatching input. */
function waitForRestartPreparations(
  gateway: Awaited<ReturnType<typeof createOpenClawTestInstance>>,
  signal: AbortSignal,
  before: Array<{ sessionId: string; restored: number; prepared: number }>,
  options: { prepared?: boolean; excludedLines?: ReadonlySet<string> } = {},
) {
  const child = gateway.child;
  if (!child) {
    throw new Error("Restart preparation observer requires the running Gateway");
  }
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      child.stdout.off("data", inspect);
      child.stderr.off("data", inspect);
      child.off("exit", exited);
      deadline.removeEventListener("abort", aborted);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const inspect = () => {
      if (
        before.every((previous) => {
          const current = restartPreparationCounts(
            gateway,
            previous.sessionId,
            options.excludedLines,
          );
          return (
            current.restored > previous.restored &&
            (options.prepared === false || current.prepared > previous.prepared)
          );
        })
      ) {
        finish();
      }
    };
    const exited = () => finish(new Error("Gateway exited before reusable recipients restored"));
    const aborted = () =>
      finish(
        new Error("Reusable recipient startup did not settle", {
          cause: deadline.reason,
        }),
      );
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", exited);
    deadline.addEventListener("abort", aborted, { once: true });
    if (deadline.aborted) {
      aborted();
    } else {
      inspect();
    }
  });
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
      const expectedSpeech: Array<{ conversationKey: string; input: string; reply: string }> = [];
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
        const create = async (sessionKey = voiceKey) => {
          const created = await operator!.call<{ sessionId: string; readyMark: string }>(
            "talk.session.create",
            {
              sessionKey,
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
        const performSpeech = async (
          existingSessionId: string | undefined,
          index: number,
          conversationKey = voiceKey,
        ) => {
          const playback = pendingPlayback;
          if (playback) {
            playback.waiting.resolve();
            await withinTest(playback.drained.promise, signal);
          }
          // Both are permitted: separate transports, or connected follow-ups on
          // the same live media session after the preceding PCM drains locally.
          const ownsTransport = clientProfile === "echo-activity";
          const sessionId = ownsTransport ? await create(conversationKey) : existingSessionId;
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
          const inputText = `SPEECH_INPUT_${index}: Please answer briefly.`;
          // The offline provider decodes text, but the real relay still requires
          // complete PCM16 samples in every frame, including two-digit rounds.
          const inputAudio = Buffer.from(inputText + (Buffer.byteLength(inputText) % 2 ? " " : ""));
          try {
            appendRequests++;
            await operator!.call("talk.session.appendAudio", {
              sessionId,
              audioBase64: inputAudio.subarray(0, 16).toString("base64"),
              ...(activity ? { captureId } : {}),
            });
            appendRequests++;
            await operator!.call("talk.session.appendAudio", {
              sessionId,
              audioBase64: inputAudio.subarray(16).toString("base64"),
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
              conversationKey,
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
        const speak = async (
          sessionId: string | undefined,
          index: number,
          conversationKey = voiceKey,
        ) => {
          const playback = pendingPlayback;
          const appendsBeforeDrain = appendRequests;
          const requestsBeforeDrain = model.requests.length;
          const work = performSpeech(sessionId, index, conversationKey);
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
        const userSequence = async (sessionKey: string, marker: string) => {
          const history = await operator!.call<{
            messages: Array<{
              role: string;
              content: unknown;
              __openclaw?: { transcriptPosition?: { rawSeq?: number } };
            }>;
          }>("chat.history", { sessionKey, limit: 100 });
          const sequence = history.messages.find(
            (message) =>
              message.role === "user" && JSON.stringify(message.content).includes(marker),
          )?.["__openclaw"]?.transcriptPosition?.rawSeq;
          if (typeof sequence !== "number") {
            throw new Error("Native user transcript sequence unavailable");
          }
          return sequence;
        };
        const chatRecipient = await operator.call<{ session: { sessionId: string } }>(
          "sessions.describe",
          { key: chatKey },
        );
        phase = "create-talk";
        const first = await openTalk();
        const firstInput = await speak(first, 1);
        // Observe the logical recipient before a further real speech round.
        // No recipient read may refresh its facts during the idle proof below.
        const idleRecipient = await operator.call<{ session: { sessionId: string } | null }>(
          "sessions.describe",
          { key: voiceKey },
        );
        expect(idleRecipient.session).not.toBeNull();
        // Immediate follow-ups exercise genuine admission and asynchronous
        // preparation races, without holding or replacing their native owners.
        await speak(first, 2);
        const secondFact = "SECOND_SIBLING_FACT_AMBER_94";
        const idleStartedAt = performance.now();
        const requestsBeforeSibling = model.requests.length;
        if (connectedActivity) {
          phase = "speech-to-idle-chat-admission";
          drainPlayback();
          if (!chatRecipient || !idleRecipient?.session) {
            throw new Error("Native conversation recipient unavailable");
          }
          // Speech and its answer have separate source entries. A later assistant
          // packet cannot acknowledge the spoken user input in the idle chat.
          await waitForConversationTransfer(gateway, signal, {
            recipientId: chatRecipient.session.sessionId,
            sourceId: idleRecipient.session.sessionId,
            sequence: await userSequence(voiceKey, "SPEECH_INPUT_2"),
            exactSequence: true,
            phase: "admitted",
          });
          expect(model.requests).toHaveLength(requestsBeforeSibling);
        }
        await sendChat(secondFact);
        if (connectedActivity) {
          if (!chatRecipient || !idleRecipient?.session) {
            throw new Error("Native conversation recipient unavailable");
          }
          expect(JSON.stringify(model.requests[requestsBeforeSibling])).toContain("SPEECH_INPUT_2");
          phase = "chat-to-idle-speech-admission";
          // Keep the Talk connection open with no new capture or model boundary.
          // Ordinary output/foreground settlement must admit the prepared packet.
          await waitForConversationTransfer(gateway, signal, {
            recipientId: idleRecipient.session.sessionId,
            sourceId: chatRecipient.session.sessionId,
            sequence: await userSequence(chatKey, secondFact),
            phase: "admitted",
          });
          expect(model.requests).toHaveLength(requestsBeforeSibling + 1);
          phases.push({
            phase,
            durationMs: performance.now() - idleStartedAt,
            idleModelRequests: model.requests.length - requestsBeforeSibling - 1,
          });
        } else {
          if (!idleRecipient.session) {
            throw new Error("Native conversation recipient unavailable");
          }
          phase = "chat-to-speech-preparation";
          const preparationStartedAt = performance.now();
          // A foreground turn consumes ready packets; it must not wait for source
          // hydration. Observe that native preparation before verifying its content,
          // without another capture, a forced catch-up, or a recipient refresh.
          await waitForConversationTransfer(gateway, signal, {
            recipientId: idleRecipient.session.sessionId,
            sourceId: chatRecipient.session.sessionId,
            sequence: await userSequence(chatKey, secondFact),
            phase: "prepared",
          });
          expect(model.requests).toHaveLength(requestsBeforeSibling + 1);
          phases.push({
            phase,
            durationMs: performance.now() - preparationStartedAt,
            idleModelRequests: model.requests.length - requestsBeforeSibling - 1,
          });
        }
        const laterInput = await speak(first, 3);
        expect(laterInput).toContain("SPEECH_INPUT_1");
        expect(laterInput).toContain("SPEECH_INPUT_2");
        if (connectedActivity) {
          expect(laterInput.split(secondFact)).toHaveLength(2);
        }
        await speak(first, 4);
        await closeTalk(first);
        phase = "reopen-talk";
        const second = await openTalk();
        const reopenedInput = await speak(second, 5);
        await speak(second, 6);
        expect(firstInput).toContain(FACT);
        expect(laterInput).toContain(secondFact);
        expect(reopenedInput).toContain(FACT);
        await closeTalk(second);
        const restartRecipients: Array<{ sessionId: string; restored: number; prepared: number }> =
          [];
        let priorGatewayLines = new Set<string>();
        const dormantKeys: string[] = [];
        const restartFact = "RESTART_SIBLING_FACT_SILVER_52";
        const coldFact = "COLD_IDLE_DELIVERY_INDIGO_83";
        const unrelatedFact = "OTHER_PERSON_PRIVATE_FACT_MAUVE_16";
        if (connectedActivity) {
          phase = "prepare-dormant-personal-recipients";
          const originalRecipient = idleRecipient?.session;
          if (!originalRecipient) {
            throw new Error("Original personal recipient unavailable before restart");
          }
          const ids = [originalRecipient.sessionId];
          for (let index = 0; index < 2; index++) {
            const key = `agent:main:voice:dormant-${index}-${randomUUID()}`;
            dormantKeys.push(key);
            const dormant = await create(key);
            const described = await operator.call<{ session: { sessionId: string } }>(
              "sessions.describe",
              { key },
            );
            ids.push(described.session.sessionId);
            await waitForRestartPreparations(
              gateway,
              signal,
              [
                {
                  sessionId: described.session.sessionId,
                  restored: 0,
                  prepared: 0,
                },
              ],
              { prepared: false },
            );
            // Native initial-context packets are display:false. Their content is
            // checked in this destination's first real model prompt after restart.
            await closeTalk(dormant);
          }
          const other = await connectConversationOperator(gateway, "blair@example.test", signal, {
            scopes: [...SCOPES],
          });
          try {
            const started = await other.call<{ runId: string }>("chat.send", {
              sessionKey: `agent:main:other-person-${randomUUID()}`,
              message: unrelatedFact,
              deliver: false,
              idempotencyKey: randomUUID(),
            });
            expect(
              await other.call(
                "agent.wait",
                {
                  runId: started.runId,
                  timeoutMs: 30_000,
                },
                { timeoutMs: 31_000 },
              ),
            ).toMatchObject({ status: "ok" });
          } finally {
            await other.close();
          }
          await sendChat(restartFact);
          restartRecipients.push(
            ...ids.map((sessionId) => ({ sessionId, restored: 0, prepared: 0 })),
          );
        }
        await operator.close();
        operator = undefined;
        phase = "restart-with-existing-personal-branch";
        const requestsBeforeRestart = model.requests.length;
        await gateway.stopGateway();
        if (connectedActivity) {
          // Exclude the joined old process's lines; rolling tails cannot preserve counts.
          priorGatewayLines = new Set(completeGatewayLogLines(gateway.logs()));
        }
        await gateway.startGateway();
        if (connectedActivity) {
          await waitForRestartPreparations(gateway, signal, restartRecipients, {
            excludedLines: priorGatewayLines,
          });
          expect(restartRecipients).toHaveLength(3);
          // No new login, Talk creation or model input has re-enrolled these recipients.
          expect(model.requests).toHaveLength(requestsBeforeRestart);
        }
        operator = await connect();
        if (connectedActivity) {
          if (!chatRecipient) {
            throw new Error("Expected the original chat donor");
          }
          // New donor data rules out a pre-restart receipt. All three recipients
          // are still disconnected and have no post-restart foreground budget.
          phase = "cold-idle-recipient-admission";
          await sendChat(coldFact);
          const sequence = await userSequence(chatKey, coldFact);
          await Promise.all(
            restartRecipients.map(({ sessionId }) =>
              waitForConversationTransfer(gateway, signal, {
                recipientId: sessionId,
                sourceId: chatRecipient.session.sessionId,
                sequence,
                exactSequence: true,
                phase: "admitted",
              }),
            ),
          );
          expect(model.requests).toHaveLength(requestsBeforeRestart + 1);
        }
        const third = await openTalk();
        const resumedInput = await speak(third, 7);
        expect(resumedInput).toContain(FACT);
        if (connectedActivity) {
          expect(resumedInput.split(restartFact)).toHaveLength(2);
          expect(resumedInput.split(coldFact)).toHaveLength(2);
          expect(resumedInput).not.toContain(unrelatedFact);
        }
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
        if (connectedActivity) {
          await closeTalk(third);
          for (const [index, conversationKey] of dormantKeys.entries()) {
            const resumed = await create(conversationKey);
            const input = await speak(resumed, 10 + index, conversationKey);
            expect(input).toContain(FACT);
            expect(input.split(restartFact)).toHaveLength(2);
            expect(input.split(coldFact)).toHaveLength(2);
            expect(input).not.toContain(unrelatedFact);
            await closeTalk(resumed);
          }
        }
        // Read durable history only after the follow-up sequence. An extra read
        // between captures could refresh a lease and hide a publication race.
        for (const conversationKey of new Set(expectedSpeech.map((item) => item.conversationKey))) {
          const history = await operator.call<{ messages: unknown[] }>("chat.history", {
            sessionKey: conversationKey,
            limit: 100,
          });
          const recorded = JSON.stringify(history.messages);
          for (const { input, reply } of expectedSpeech.filter(
            (item) => item.conversationKey === conversationKey,
          )) {
            expect(recorded).toContain(input);
            expect(recorded).toContain(reply);
          }
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
      } catch (error) {
        const diagnostics = gateway
          .logs()
          .split("\n")
          .filter((line) =>
            /conversation-knowledge|Reusable conversation|talk native speech|lane task error/u.test(
              line,
            ),
          )
          .join("\n");
        throw new Error(
          `Conversation speech fixture failed during ${phase}\n${diagnostics.slice(-24_000)}`,
          { cause: error },
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
