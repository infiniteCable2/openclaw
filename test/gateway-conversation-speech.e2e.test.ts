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
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
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

it.for(["isolated-duplex", "echo-activity"] as const)(
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
      let pendingTurn:
        | { sessionId: string; completion: ReturnType<typeof createDeferred<void>> }
        | undefined;
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
              if (payload.sessionId !== pendingTurn?.sessionId || !isRecord(payload.talkEvent)) {
                return;
              }
              if (payload.talkEvent.type === "session.error") {
                pendingTurn?.completion.reject(
                  new Error(`Actual Talk failure: ${JSON.stringify(payload.talkEvent)}`),
                );
              }
              if (payload.talkEvent.type === "turn.ended") {
                pendingTurn?.completion.resolve();
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
        const create = async () => {
          const created = await operator!.call<{ sessionId: string; readyMark: string }>(
            "talk.session.create",
            {
              sessionKey: voiceKey,
              mode: "stt-tts",
              transport: "gateway-relay",
              brain: "agent-consult",
              provider: SPEECH,
              capabilities:
                clientProfile === "echo-activity"
                  ? ["activity-v1"]
                  : ["isolated-input", "output-gate"],
            },
          );
          sessions.add(created.sessionId);
          await operator!.call("talk.session.acknowledgeMark", {
            sessionId: created.sessionId,
            markName: created.readyMark,
          });
          return created.sessionId;
        };
        const openTalk = () => (clientProfile === "echo-activity" ? undefined : create());
        const closeTalk = async (sessionId: string | undefined) => {
          if (sessionId) {
            await operator!.call("talk.session.close", { sessionId });
            sessions.delete(sessionId);
          }
        };
        const speak = async (existingSessionId: string | undefined, index: number) => {
          // Echo retains the durable branch, but opens and closes its audio transport
          // per utterance. Its real client requests activity-v1 without duplex gates.
          const ownsTransport = clientProfile === "echo-activity";
          const sessionId = ownsTransport ? await create() : existingSessionId;
          if (!sessionId) {
            throw new Error("Talk transport was not opened");
          }
          phase = `speech-${index}`;
          const before = model.requests.length;
          const audioCount = () =>
            events.filter((e) => e.type === "audio" && e.sessionId === sessionId).length;
          const audioBefore = audioCount();
          pendingTurn = { sessionId, completion: createDeferred() };
          void pendingTurn.completion.promise.catch(() => {});
          const started = performance.now();
          const captureId = randomUUID();
          try {
            await operator!.call("talk.session.appendAudio", {
              sessionId,
              audioBase64: Buffer.from(`SPEECH_INPUT_${index}: `).toString("base64"),
              ...(ownsTransport ? { captureId } : {}),
            });
            await operator!.call("talk.session.appendAudio", {
              sessionId,
              audioBase64: Buffer.from("Please answer briefly.").toString("base64"),
              ...(ownsTransport ? { captureId } : {}),
              endOfInput: true,
            });
            await withinTest(pendingTurn.completion.promise, signal);
            pendingTurn = undefined;
            expect(model.requests).toHaveLength(before + 1);
            expect(audioCount()).toBeGreaterThan(audioBefore);
            if (ownsTransport) {
              expect(events).toContainEqual(
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
