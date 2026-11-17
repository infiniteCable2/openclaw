import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { createHostIngressFixture } from "../channels/message-access/host-ingress.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendExpectedSessionTranscriptTurn } from "../config/sessions/session-accessor.sqlite-transcript-turn.js";
import { bindSessionRowProjection } from "../gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../gateway/session-row-projection.js";
import { createMeetingRealtimeEngineBindingsV2 } from "../meeting-bot/conversation-bindings.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import "./conversation-greeting.js";
import {
  greetingConfiguration,
  greetingEventsFor,
} from "./conversation-greeting.native.test-support.js";
import type { ConversationInputSourceV1 } from "./conversation-input.types.js";
import { prepareSpeechGreeting } from "./speech/greeting.js";

// Real host admission, bindings, inference adapter, SQLite target and publication;
// only connection timing, loopback model output and TTS bytes are synthetic.
it("buffers isolated greeting audio before enrollment finishes and preserves the early history boundary", async ({
  signal,
}) => {
  let modelCalls = 0;
  const listener = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          modelCalls++;
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of greetingEventsFor("Hello.")) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          }
          res.end();
        });
      }),
  });
  try {
    await withOpenClawTestState(
      {
        scenario: "minimal",
        label: "parallel-greeting",
        prepareProfileCatalog: true,
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
      async (state) => {
        const cfg = greetingConfiguration(
          `http://127.0.0.1:${listener.claim.port}/v1`,
          state.workspaceDir,
        );
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const host = createHostIngressFixture("matrix", cfg, {
          getCommittedRuntimeConfig: () => cfg,
        });
        const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
        bindSessionRowProjection(host.gateway, () => projection);
        const sessionId = randomUUID();
        const sessionKey = "agent:main:matrix:direct:parallel";
        const target = {
          agentId: "main",
          sessionId,
          sessionKey,
          storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
        };
        const connectionStarted = Promise.withResolvers<void>();
        const connectionGate = Promise.withResolvers<void>();
        const buffered = Promise.withResolvers<void>();
        const ttsStarted = Promise.withResolvers<void>();
        const ttsGate = Promise.withResolvers<void>();
        let live = true;
        let admissions = 0;
        let created = false;
        let holdTts = false;
        let releases = 0;
        const assertLive = () => assert(live, "Synthetic connection retired");
        const inputSource: ConversationInputSourceV1 = {
          version: 1,
          async prepareConnection() {
            connectionStarted.resolve();
            await connectionGate.promise;
            assertLive();
            await upsertSessionEntryCore(target, {
              sessionId,
              updatedAt: Date.now(),
              chatType: "direct",
            });
            await projection.ensureMaterialized();
            created = true;
          },
          async admitInput(input) {
            admissions++;
            const scope = {
              channelId: "matrix",
              accountId: "default",
              rawPrincipalRef: "@caller:example.test",
              conversation: { kind: "direct" as const, id: "!fixture:example.test" },
              binding: {
                agentId: "main",
                sessionKey,
                messageId: input.inputId,
                nativeChannelId: "!fixture:example.test",
                inboundEventKind: "user_request" as const,
              },
            };
            const ingress = await host.ingress.resolveStable({
              channelId: scope.channelId,
              accountId: scope.accountId,
              identity: {
                authentication: "verified",
                resolveParticipant: () => ({
                  domain: "example.test",
                  idKind: "user-id",
                  id: scope.rawPrincipalRef,
                }),
              },
              subject: { stableId: scope.rawPrincipalRef },
              conversation: scope.conversation,
              contextBinding: scope.binding,
              dmPolicy: "allowlist",
              allowFrom: [scope.rawPrincipalRef],
              useDefaultPairingStore: false,
            });
            return host.ingress.conversation.admitInput({
              ingress,
              scope,
              input,
              assertCurrent: assertLive,
              signal: input.signal,
              context: {
                channel: "matrix",
                accountId: "default",
                from: "matrix:@caller:example.test",
                sender: { id: scope.rawPrincipalRef },
                conversation: scope.conversation,
                route: { agentId: "main", routeSessionKey: sessionKey },
                reply: { to: scope.conversation.id, nativeChannelId: scope.conversation.id },
              },
            });
          },
        };
        const runtime = createPluginRuntimeMock({
          tts: {
            async streamTextToSpeechTelephony() {
              if (holdTts) {
                ttsStarted.resolve();
              }
              return {
                success: true,
                sampleRate: 24_000,
                outputFormat: "pcm",
                audioStream: new ReadableStream<Uint8Array>({
                  async start(controller) {
                    if (holdTts) {
                      await ttsGate.promise;
                    }
                    controller.enqueue(Uint8Array.from([1, 0, 2, 0]));
                    controller.close();
                  },
                }),
                async release() {
                  releases++;
                  buffered.resolve();
                },
              };
            },
          },
        });
        const bindings = createMeetingRealtimeEngineBindingsV2({
          platform: {
            id: "example",
            displayName: "Example",
            logScope: "example",
            agentConsult: {
              surface: "a call",
              userLabel: "User",
              assistantLabel: "Assistant",
              questionSourceLabel: "user",
              workingResponseLabel: "request",
              extraSystemPrompt: "Respond naturally.",
            },
            session: { idPrefix: "example", participantIdentity: () => "caller" },
          },
          config: { realtime: { agentId: "main", toolPolicy: "owner" } },
          fullConfig: cfg,
          runtime,
          logger: { info() {}, warn() {}, error() {} },
          agentId: "main",
          conversationId: sessionId,
          inputSource,
          ttsContext: { agentId: "main", channelId: "matrix" },
          assertOutputCurrent: assertLive,
        });
        const prepare = (preparePublication = bindings.prepareGreetingPublication) =>
          prepareSpeechGreeting({
            cfg,
            runtime,
            sessionId,
            callerId: "@caller:example.test",
            prompt: "Greet briefly.",
            timeZone: "UTC",
            audioFormat: "pcm16-24khz",
            signal,
            consultAgent: ({ sessionId: meetingSessionId, ...request }) =>
              bindings.consultAgent({ ...request, meetingSessionId }),
            preparePublication,
            onSubmitted: bindings.onGreetingSubmitted,
          });
        const first = prepare();
        void first.catch(() => {});
        let ready = false;
        void first.then(
          () => {
            ready = true;
          },
          () => {},
        );
        try {
          await withinTest(connectionStarted.promise, signal);
          // Red on the serialized implementation, before releasing the enrollment gate.
          expect(admissions).toBeGreaterThan(0);
          await withinTest(Promise.race([buffered.promise, first]), signal);
          expect(releases).toBe(1);
          expect(modelCalls).toBe(1);
          expect(created).toBe(false);
          expect(ready).toBe(false);
          connectionGate.resolve();
          const greeting = await withinTest(first, signal);
          assert(greeting.recordSubmitted);
          await greeting.recordSubmitted({ audioDelivery: "submitted" });
          await greeting.recordSubmitted({ audioDelivery: "submitted" });
          const published = await SessionManager.openAsync(
            target,
            state.workspaceDir,
            undefined,
            signal,
          );
          expect(published.getBranch()).toHaveLength(1);
          expect(published.getBranch().at(-1)).toMatchObject({
            message: { role: "assistant", content: [{ type: "text", text: "Hello." }] },
          });

          holdTts = true;
          const bound = Promise.withResolvers<void>();
          const second = prepare(async (params) => {
            const publication = await bindings.prepareGreetingPublication(params);
            bound.resolve();
            return publication;
          });
          void second.catch(() => {});
          try {
            await withinTest(
              Promise.race([Promise.all([bound.promise, ttsStarted.promise]), second]),
              signal,
            );
            const user = await appendExpectedSessionTranscriptTurn(target, {
              config: cfg,
              keyFormat: "agent-qualified",
              expectedSessionId: sessionId,
              selectedSessionId: sessionId,
              selectedLifecycleRevision: null,
              sessionFile: sessionKey,
              assertCurrent: assertLive,
              messages: [
                {
                  eventId: "intervening-user",
                  message: {
                    role: "user",
                    content: "A new question while audio is preparing.",
                    timestamp: Date.now(),
                  },
                },
              ],
            });
            expect(user.appendedMessages).toHaveLength(1);
            ttsGate.resolve();
            const lateGreeting = await withinTest(second, signal);
            assert(lateGreeting.recordSubmitted);
            await expect(
              lateGreeting.recordSubmitted({ audioDelivery: "submitted" }),
            ).rejects.toMatchObject({ name: "SqliteTranscriptMutationConflictError" });
            const afterUser = await SessionManager.openAsync(
              target,
              state.workspaceDir,
              undefined,
              signal,
            );
            expect(afterUser.getBranch()).toHaveLength(2);
            expect(afterUser.getBranch().at(-1)).toMatchObject({
              message: { role: "user", content: "A new question while audio is preparing." },
            });
            expect(modelCalls).toBe(2);
          } finally {
            ttsGate.resolve();
            await second.catch(() => {});
          }
        } finally {
          connectionGate.resolve();
          ttsGate.resolve();
          await first.catch(() => {});
          await bindings.connectionPreparation?.close();
          live = false;
          host.retire();
          projection.dispose();
          await closeSkillsWatchers(true);
        }
      },
    );
  } finally {
    listener.listener.closeAllConnections();
    try {
      await listener.releaseListener();
    } finally {
      await listener.claim.release();
    }
  }
}, 30_000);
