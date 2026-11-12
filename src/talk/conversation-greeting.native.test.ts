import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFailed } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import type { ChannelIngressAdmissionScope } from "../channels/message-access/admission-evidence-scope-key.js";
import { createChannelAdmissionAudit } from "../channels/message-access/admission-evidence.js";
import { createHostIngressFixture } from "../channels/message-access/host-ingress.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindSessionRowProjection } from "../gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../gateway/session-row-projection.js";
import type { AssistantMessage } from "../llm/types.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import "./conversation-greeting.js"; // Preload the lazy owner outside the test deadline.
import type { ConversationInputScopeV1 } from "./conversation-input.types.js";
import { replyToConversationInput } from "./conversation-reply.js";

const HISTORY = "The synthetic note says cobalt.";
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "fixture",
    model: "fixture",
    stopReason,
    usage,
    timestamp: 2,
  };
}

function eventsFor(text: string) {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        content: [],
        model: "fixture",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...Array.from(text, (part) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: part },
    })),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ];
}

function configuration(baseUrl: string, workspace: string): OpenClawConfig {
  return {
    gateway: { mode: "local" },
    agents: {
      entries: { main: { workspace } },
      defaults: {
        workspace,
        model: { primary: "fixture/fixture", fallbacks: [] },
        modelPolicy: { allow: ["fixture/fixture"] },
        models: { "fixture/fixture": { agentRuntime: { id: "openclaw" } } },
        utilityModel: "",
        skills: [],
        skipBootstrap: true,
      },
    },
    models: {
      mode: "replace",
      providers: {
        fixture: {
          baseUrl,
          api: "anthropic-messages",
          apiKey: "synthetic-fixture-key",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "fixture",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 128,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    plugins: { slots: { memory: "none" } },
    skills: { load: { watch: false } },
  };
}

// Keep admission, snapshots and runner real; only the loopback model is synthetic.
// This checks native greeting composition, not live Matrix/TTS playback.
it("prepares native detached greetings from fresh and tool-bearing sources without delivery or writes", async ({
  signal,
}) => {
  let stage = "listener";
  let responseText = "Hello.";
  const requests: Array<{ tools: number; hasHistory: boolean }> = [];
  const providerFailures: unknown[] = [];
  const warnings: unknown[][] = [];
  onTestFailed(() => {
    console.error("native greeting boundary", {
      stage,
      requests,
      providerFailures,
      warnings,
    });
  });
  const listener = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((req, res) => {
        void (async () => {
          try {
            assert.equal(req.method, "POST");
            assert(["/v1/messages", "/messages"].includes(req.url ?? ""));
            let size = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              const bytes = Buffer.from(chunk);
              size += bytes.length;
              assert(size <= 1_048_576, "Synthetic request unexpectedly large");
              chunks.push(bytes);
            }
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            assert(isRecord(body));
            assert.equal(body.model, "fixture");
            assert(Array.isArray(body.messages));
            requests.push({
              tools: Array.isArray(body.tools) ? body.tools.length : 0,
              hasHistory: JSON.stringify(body.messages).includes(HISTORY),
            });
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const event of eventsFor(responseText)) {
              res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            res.end();
          } catch (error) {
            providerFailures.push(error);
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                type: "error",
                error: {
                  type: "invalid_request_error",
                  message: "Synthetic request contract failed",
                },
              }),
            );
          }
        })();
      }),
  });
  try {
    await withOpenClawTestState(
      {
        scenario: "minimal",
        label: "native-greeting",
        prepareProfileCatalog: true,
        // This custom HTTP provider needs no bundled plugins. Keep unrelated source
        // plugin discovery out of this greeting/admission composition.
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async (state) => {
        const cfg = configuration(`http://127.0.0.1:${listener.claim.port}/v1`, state.workspaceDir);
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
        const audit = createChannelAdmissionAudit({ enabled: true });
        const host = createHostIngressFixture("matrix", cfg, {
          channelAdmissionAudit: audit,
          getCommittedRuntimeConfig: () => cfg,
        });
        stage = "projection:create";
        const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
        bindSessionRowProjection(host.gateway, () => projection);
        let live = true;
        const assertLive = () => assert(live, "Synthetic connection retired");
        try {
          for (const hasHistory of [false, true]) {
            const sessionId = randomUUID();
            const sessionKey = `agent:main:matrix:direct:${hasHistory ? "history" : "fresh"}`;
            const target = { agentId: "main", sessionId, sessionKey, storePath };
            stage = `seed:${hasHistory}:upsert`;
            expect(
              await withinTest(
                upsertSessionEntryCore(target, {
                  sessionId,
                  updatedAt: Date.now(),
                  chatType: "direct",
                }),
                signal,
              ),
            ).not.toBeNull();
            stage = `seed:${hasHistory}:open`;
            const manager = await SessionManager.openAsync(
              target,
              state.workspaceDir,
              undefined,
              signal,
            );
            stage = `seed:${hasHistory}:append`;
            if (hasHistory) {
              await manager.appendMessageAsync({
                role: "user",
                content: "Read the synthetic note.",
                timestamp: 1,
              });
              await manager.appendMessageAsync(
                assistant(
                  [
                    {
                      type: "toolCall",
                      id: "call_fixture",
                      name: "read",
                      arguments: { path: "synthetic-note.txt" },
                    },
                  ],
                  "toolUse",
                ),
              );
              await manager.appendMessageAsync({
                role: "toolResult",
                toolCallId: "call_fixture",
                toolName: "read",
                content: [{ type: "text", text: "Synthetic note: cobalt." }],
                isError: false,
                timestamp: 3,
              });
              await manager.appendMessageAsync(
                assistant([{ type: "text", text: HISTORY }], "stop"),
              );
            }
            stage = `seed:${hasHistory}:projection`;
            await withinTest(projection.ensureMaterialized(), signal);
            const original = structuredClone(manager.getBranch());
            for (const expression of [false, true]) {
              stage = `greeting:${hasHistory}:${expression}:ingress`;
              responseText = expression ? '{"type":"speech","text":"Hello."}' : "Hello.";
              const requestStart = requests.length;
              const input: ConversationInputScopeV1 = {
                agentId: "main",
                conversationId: sessionId,
                inputId: randomUUID(),
                purpose: "greeting",
              };
              const scope = {
                channelId: "matrix",
                accountId: "default",
                rawPrincipalRef: "@caller:example.test",
                conversation: { kind: "direct", id: "!fixture:example.test" },
                binding: {
                  agentId: "main",
                  sessionKey,
                  messageId: input.inputId,
                  nativeChannelId: "!fixture:example.test",
                  inboundEventKind: "user_request",
                },
              } satisfies ChannelIngressAdmissionScope;
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
              const admission = host.ingress.conversation.admitInput({
                ingress,
                scope,
                input,
                assertCurrent: assertLive,
                signal,
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
              let liveOutput = 0;
              stage = `greeting:${hasHistory}:${expression}:reply`;
              const result = await replyToConversationInput({
                cfg,
                admission,
                scope: input,
                text: "Prepare one short greeting only. Say Hello.",
                workSignal: signal,
                speech: {
                  assertOutputCurrent: assertLive,
                  onSpeakableText: () => {
                    liveOutput++;
                  },
                  onError: (error) => {
                    throw error;
                  },
                  logger: {
                    warn: (...args) => {
                      warnings.push(args);
                    },
                  },
                  ...(expression
                    ? {
                        speechExpressionContext: {
                          guidance: 'Use {"type":"speech","text":"Hello."} for the greeting.',
                          assertCurrent: assertLive,
                        },
                      }
                    : {}),
                },
              });
              expect(result.kind).toBe("reply");
              assert(result.kind === "reply");
              expect(result.reply.text.trim()).toBe("Hello.");
              expect(liveOutput).toBe(0);
              expect(requests.slice(requestStart)).toEqual([{ tools: 0, hasHistory }]);
              expect(providerFailures).toEqual([]);
              expect(warnings).toEqual([]);
              if (expression) {
                expect(result.reply.utterances).toMatchObject([{ text: "Hello." }]);
              }
              stage = `greeting:${hasHistory}:${expression}:reread`;
              const reread = await SessionManager.openAsync(
                target,
                state.workspaceDir,
                undefined,
                signal,
              );
              expect(reread.getBranch()).toEqual(original);
            }
          }
        } finally {
          live = false;
          host.retire();
          audit.close();
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
