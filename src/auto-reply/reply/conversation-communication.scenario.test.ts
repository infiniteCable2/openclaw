import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { projectConversationToolNames } from "../../agents/conversation-tool-policy-pipeline.js";
import { readToolStringParam } from "../../agents/tools/common.js";
import {
  createConversationsListTool,
  createConversationsSendTool,
} from "../../agents/tools/conversation-tools.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import * as gatewayTransport from "../../agents/tools/in-process-gateway.js";
import { createMessageTool } from "../../agents/tools/message-tool-execution.js";
import { createHostChannelIngressRuntime } from "../../channels/message-access/runtime.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { recordConversationKnowledgeTurn } from "../../config/sessions/conversation-knowledge-store.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { runGatewayConversationList } from "../../gateway/conversation-list.js";
import { runGatewayConversationSend } from "../../gateway/conversation-send.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  resolveAgentConversationRoute,
  resolveAgentSpeechConversationRoute,
} from "../../routing/conversation-mode.js";
import { readSessionConversationParticipant } from "../../sessions/session-participant-input.js";
import { linkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { publishCanonicalUserChannelPolicy } from "../../state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  prepareConversationReplyContext,
} from "../../talk/conversation-input-admission.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState } from "./session.js";

// Source-level owner composition, not a packaged RTC/model/acoustic E2E. The
// synthetic host declares a verified product identity; Matrix's SDK membership
// producer is independently exercised in rtc-controller.native-input.test.ts.
// Only the Matrix network adapter, in-process tool transport and model-generated
// transcript text are replaced. Routing, ingress/profile grants, workers,
// Knowledge, address discovery, delivery queue and message execution stay real.
describe("branch communication owner pilot", () => {
  it("keeps Chat -> call -> Chat knowledge and exact text/file destinations coherent", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "communication-pilot" },
      async (state) => {
        const fixture = await createConversationKnowledgeScenario(state);
        const registry = captureActivePluginRegistrySnapshot();
        const releases: Array<() => void> = [];
        try {
          const room = "!private-room:example.test";
          const accountId = "default";
          const delivered: Array<{ to: string; kind: "text" | "file"; text: string }> = [];
          const cfg = fixture.cfg;
          cfg.bindings = [{ type: "route", agentId: "main", match: { channel: "matrix" } }];
          cfg.channels = { matrix: { enabled: true, allowFrom: [person.id] } };
          cfg.tools = { allow: ["conversations_list", "conversations_send", "message", "read"] };
          cfg.gateway = {
            roles: {
              default: "member",
              definitions: {
                member: {
                  sessions: { others: "none" },
                  scopes: ["operator.read"],
                  agents: ["main"],
                },
                admin: {
                  sessions: { others: "none" },
                  scopes: ["operator.admin"],
                  agents: ["main"],
                },
              },
            },
          };
          await state.writeConfig(cfg);
          const profile = ensureProfileForEmail("owner@example.test");
          setUserProfileRole(profile.id, "admin");
          linkUserChannelIdentity(profile.id, {
            channelId: "matrix",
            accountId,
            senderId: person.id,
          });
          await publishCanonicalUserChannelPolicy(cfg.gateway, cfg.commands?.ownerAllowFrom);
          const plugin: ChannelPlugin = {
            ...createChannelTestPluginBase({
              id: "matrix",
              capabilities: { chatTypes: ["direct"], media: true },
              config: {
                listAccountIds: () => [accountId],
                resolveAccount: () => ({ enabled: true }),
                isConfigured: () => true,
              },
            }),
            messaging: {
              normalizeTarget: (raw) => raw.trim() || undefined,
              targetResolver: { looksLikeId: (raw) => raw.startsWith("!") },
            },
            outbound: {
              deliveryMode: "direct",
              resolveTarget: ({ to }) => ({ ok: true, to: to ?? room }),
              async sendText(context) {
                expect(context.to).toBe(room);
                expect(context.accountId).toBe(accountId);
                delivered.push({ to: context.to, kind: "text", text: context.text });
                return { channel: "matrix", messageId: "$pilot-text" };
              },
              async sendMedia(context) {
                expect(context.to).toBe(room);
                expect(context.accountId).toBe(accountId);
                if (!context.mediaUrl || !context.mediaAccess?.readFile) {
                  throw new Error("The native media capability must reach the network adapter");
                }
                const bytes = await context.mediaAccess.readFile(context.mediaUrl);
                expect(bytes.toString()).toBe("synthetic pilot attachment");
                delivered.push({ to: context.to, kind: "file", text: context.text });
                return { channel: "matrix", messageId: "$pilot-file" };
              },
            },
          };
          setActivePluginRegistry(
            createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]),
          );
          let transportOpen = true;
          // SAFETY: The real ingress/profile owner consumes only this synthetic config resolver.
          const gateway = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
          const ingress = createHostChannelIngressRuntime({
            channelId: "matrix",
            isLive: () => true,
            resolveGatewayContext: () => gateway,
          });
          const chatRoute = resolveAgentConversationRoute({
            cfg,
            agentId: "main",
            channel: "matrix",
            accountId,
            peer: { kind: "direct", id: person.id },
            dmScope: "main",
            groupScope: "per-group",
          });
          const callRoute = resolveAgentSpeechConversationRoute({
            cfg,
            agentId: "main",
            channel: "matrix",
            accountId,
            sourceSessionKey: chatRoute.sessionKey,
            conversationId: "pilot-call",
          });
          const chat = await fixture.branch("chat", person, "direct", chatRoute.sessionKey);
          const call = await fixture.branch("call", person, "direct", callRoute.sessionKey);
          const parallel = await fixture.branch("parallel", person);
          expect(chatRoute.rootSessionKey).toBe(fixture.root.sessionKey);
          expect(callRoute.rootSessionKey).toBe(fixture.root.sessionKey);
          expect(call.sessionKey).not.toContain(":subagent:");
          expect(call.sessionKey).not.toBe(chat.sessionKey);
          const admit = async (inputId: string) => {
            if (!transportOpen) throw new Error("Call closed");
            const input = {
              agentId: "main",
              conversationId: "pilot-call",
              inputId,
              purpose: "user" as const,
            };
            const scope = {
              channelId: "matrix",
              accountId,
              rawPrincipalRef: person.id,
              conversation: { kind: "direct" as const, id: room },
              binding: {
                agentId: "main",
                sessionKey: call.sessionKey,
                messageId: inputId,
                nativeChannelId: room,
                inboundEventKind: "user_request" as const,
              },
            };
            const resolution = await ingress.resolveStable({
              channelId: "matrix",
              accountId,
              identity: {
                authentication: "verified",
                resolveParticipant: () => ({
                  domain: person.domain,
                  idKind: person.idKind,
                  id: person.id,
                }),
              },
              subject: { stableId: person.id },
              conversation: scope.conversation,
              contextBinding: scope.binding,
              dmPolicy: "allowlist",
              allowFrom: [person.id],
              event: { kind: "conversation", authMode: "inbound", mayPair: false },
              useDefaultPairingStore: false,
            });
            const admitted = consumeConversationInputAdmission(
              ingress.conversation.admitInput({
                input,
                scope,
                ingress: resolution,
                assertCurrent() {
                  if (!transportOpen) throw new Error("Call closed");
                },
                context: {
                  channel: "matrix",
                  accountId,
                  from: person.id,
                  sender: { id: person.id },
                  conversation: { kind: "direct", id: room, nativeChannelId: room },
                  route: {
                    agentId: "main",
                    routeSessionKey: chat.sessionKey,
                    dispatchSessionKey: call.sessionKey,
                  },
                  reply: { to: room, nativeChannelId: room },
                },
              }),
              input,
            );
            claimConversationInputExecution(admitted);
            const context = await prepareConversationReplyContext(admitted, {
              text: "Send this to my chat.",
            });
            expect(readSessionConversationParticipant(context)).toEqual(person);
            expect(admitted.requesterProfile?.id).toBe(profile.id);
            expect(admitted.operatorAuthority?.scopes).toEqual(["operator.admin"]);
            releases.push(() => admitted.release?.());
            const initialized = await initSessionState({
              cfg,
              ctx: finalizeInboundContext(context),
              commandAuthorized: false,
              assertSourceCurrent: admitted.assertCurrent,
            });
            expect(initialized.sessionKey).toBe(call.sessionKey);
            expect(initialized.sessionId).toBe(call.sessionId);
            expect(initialized.sessionEntry.delivery).toMatchObject({
              kind: "external",
              route: { channel: "matrix", accountId, target: { to: room } },
            });
            return admitted;
          };
          const original = await admit("spoken-input");
          const chatOwner = await fixture.claim(chat);
          const callOwner = await fixture.claim(call);
          const parallelOwner = await fixture.claim(parallel);
          const owner = {
            ...callOwner,
            assertCurrent: composeSessionSourceAssertion([
              callOwner.assertCurrent,
              original.assertCurrent,
            ]),
          };
          const before = await fixture.append(chat, "chat-before-call");
          await recordConversationKnowledgeTurn({ ...chatOwner, ...before });
          const inherited = await fixture.read(owner);
          expect(inherited.text).toContain("chat-before-call answer");
          // A concurrent sibling can publish knowledge, not rewrite this captured turn.
          const sibling = await fixture.append(parallel, "parallel-result");
          await recordConversationKnowledgeTurn({ ...parallelOwner, ...sibling });
          expect(inherited.text).not.toContain("parallel-result");
          const completed = await fixture.append(call, "call-result");
          await recordConversationKnowledgeTurn({
            ...owner,
            ...completed,
            observed: inherited.observed,
          });
          expect((await fixture.read(owner)).text).toContain("parallel-result answer");

          // The call's admitted native Matrix destination is a stable address. Its
          // transient audio connection is not an external chat address or a subagent.
          const toolNames = ["conversations_list", "conversations_send", "message", "exec"];
          const allowed = projectConversationToolNames({
            capabilityProfile: resolveConversationCapabilityProfile({
              config: cfg,
              agentId: "main",
              sessionKey: call.sessionKey,
              messageProvider: "matrix",
              senderId: person.id,
              senderIsOwner: true,
            }),
            toolNames,
            warn() {},
          });
          expect(allowed).toEqual(toolNames.slice(0, 3));
          const denied = projectConversationToolNames({
            capabilityProfile: resolveConversationCapabilityProfile({
              config: cfg,
              agentId: "main",
              conversationToolPolicy: { deny: ["message"] },
            }),
            toolNames,
            warn() {},
          });
          expect(denied).not.toContain("message");
          const options = {
            agentId: "main",
            agentSessionKey: call.sessionKey,
            agentSessionId: call.sessionId,
            config: cfg,
            senderIsOwner: true,
          };
          // Replace only RPC transport: real tool schema and Gateway owner execute.
          vi.spyOn(gatewayTransport, "callAgentToolGatewayRequest").mockImplementation(
            async (request) => {
              original.operatorAuthority?.assertCurrent();
              expect(request.params.sourceSessionKey).toBe(call.sessionKey);
              if (request.method === "conversations.list") {
                return runGatewayConversationList({
                  config: cfg,
                  agentId: "main",
                  limit: 50,
                  sourceSessionKey: call.sessionKey,
                  sourceSessionId: call.sessionId,
                });
              }
              expect(request.method).toBe("conversations.send");
              return runGatewayConversationSend({
                config: cfg,
                agentId: "main",
                senderIsOwner: true,
                sourceSessionKey: call.sessionKey,
                operationId: readToolStringParam(request.params, "operationId", { required: true }),
                conversationRef: readToolStringParam(request.params, "conversationRef", {
                  required: true,
                }),
                message: readToolStringParam(request.params, "message", { required: true }),
              });
            },
          );
          const listed = await createConversationsListTool(options).execute("pilot-list", {});
          const destinations = (
            await runGatewayConversationList({
              config: cfg,
              agentId: "main",
              limit: 50,
              sourceSessionKey: call.sessionKey,
              sourceSessionId: call.sessionId,
            })
          ).conversations;
          const destination = destinations.find((item) => item.contextRelation === "current");
          expect(listed.details).toMatchObject({
            conversations: expect.arrayContaining([
              expect.objectContaining({ target: room, channelCapabilities: { media: true } }),
            ]),
          });
          if (!destination) throw new Error("No exact chat destination for the admitted call");
          expect(destination.target).toBe(room);
          const send = createConversationsSendTool(options);
          const args = {
            conversationRef: destination.conversationRef,
            message: "Text from the call",
          };
          expect((await send.execute("pilot-send", args)).details).toMatchObject({
            status: "sent",
          });
          await send.execute("pilot-send", args);
          expect(delivered).toEqual([{ to: room, kind: "text", text: "Text from the call" }]);
          await expect(
            createConversationsSendTool({ ...options, senderIsOwner: false }).execute(
              "denied-send",
              args,
            ),
          ).rejects.toThrow("owner access");
          await expect(
            send.execute("connection-is-not-chat", { ...args, conversationRef: "connection-call" }),
          ).rejects.toThrow("Invalid conversationRef");

          await fs.mkdir(state.workspaceDir, { recursive: true });
          const file = path.join(state.workspaceDir, "pilot.txt");
          await fs.writeFile(file, "synthetic pilot attachment");
          const deliverToCall = vi.fn(async () => {});
          const message = createMessageTool({
            config: cfg,
            getRuntimeConfig: () => cfg,
            agentId: "main",
            agentSessionKey: call.sessionKey,
            workspaceDir: state.workspaceDir,
            currentSourceReplyTarget: {
              runId: "pilot-run",
              sessionId: call.sessionId,
              assertCurrent: original.assertCurrent,
              deliver: deliverToCall,
            },
            senderIsOwner: true,
            conversationReadOrigin: "direct-operator",
            requireExplicitTarget: true,
            runMessageAction,
          });
          await withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: call.sessionKey,
              operatorAuthority: original.operatorAuthority,
              receiptAuthority: original.assertCurrent,
            },
            () =>
              message.execute("pilot-file", {
                action: "send",
                channel: destination.channel,
                accountId: destination.accountId,
                target: destination.target,
                media: file,
                message: "File from the call",
              }),
          );
          expect(delivered.map((item) => item.kind)).toEqual(["text", "file"]);
          expect(deliverToCall).not.toHaveBeenCalled();

          transportOpen = false;
          await expect(admit("after-hangup")).rejects.toThrow("Call closed");
          const back = await fixture.read(chatOwner);
          expect(back.text).toContain("call-result answer");
          expect(back.text).toContain("parallel-result answer");
          expect(back.text).not.toContain("chat-before-call answer");
          const chatFinal = await fixture.append(chat, "chat-after-call");
          await recordConversationKnowledgeTurn({
            ...chatOwner,
            ...chatFinal,
            observed: back.observed,
          });
          expect((await fixture.read(chatOwner)).text).toBe("");
          const anonymous = await fixture.branch("room-assistant", null, "group");
          const unknown = await prepareReplyConversationKnowledge({
            ...(await fixture.claim(anonymous)),
            getRuntimeConfig: () => cfg,
          });
          try {
            expect(unknown?.observed).toEqual([]);
            expect(unknown?.fragments.map((item) => item.text).join("\n")).not.toContain(
              "call-result answer",
            );
          } finally {
            unknown?.release();
          }
        } finally {
          vi.restoreAllMocks();
          for (const release of releases.toReversed()) release();
          restoreActivePluginRegistrySnapshot(registry);
          await fixture.close();
        }
      },
    );
  });
});
