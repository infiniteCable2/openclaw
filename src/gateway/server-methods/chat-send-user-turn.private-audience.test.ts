import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { prepareReplyConversationKnowledge } from "../../auto-reply/reply/conversation-knowledge.js";
import { createConversationKnowledgeScenario } from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { recordConversationKnowledgeTurn } from "../../config/sessions/conversation-knowledge-store.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { recordSessionParticipantInWorker } from "../../config/sessions/session-sharing-store.async.js";
import { prepareSessionSourceAuthority } from "../../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { readConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  createUserTurnInputController,
  createClientInfo,
  createAttachments,
} from "./chat-send-user-turn.test-support.js";

function privateBrowserTurnFixture() {
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("Original browser authority revoked");
    }
  };
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "profile-ada",
    scopes: ["operator.write"],
    gatewayAccessGrant: null,
    assertCurrent,
  });
  const connection = new AbortController();
  const clientInfo = createClientInfo({
    id: GATEWAY_CLIENT_IDS.CONTROL_UI,
    mode: GATEWAY_CLIENT_MODES.UI,
  });
  const entry: InternalSessionEntry = {
    sessionId: "browser-session",
    updatedAt: 1,
    chatType: "direct",
  };
  const params: Parameters<typeof prepareChatSendUserTurn>[0] = {
    request: {
      inboundMessage: "Continue our discussion.",
      clientInfo,
      suppressCommandInterpretation: false,
    },
    session: {
      agentId: "main",
      clientRunId: "browser-input",
      sessionKey: "agent:main:browser",
      entry,
    },
    admission: {
      operatorAuthority,
      assertWorkAdmissionCurrent: assertCurrent,
      assertSessionTargetCurrent: assertCurrent,
      originatingRoute: {
        originatingChannel: "webchat",
        originatingTo: "agent:main:browser",
        explicitDeliverRoute: false,
      },
    },
    client: {
      connId: "original-browser-connection",
      connectionSignal: connection.signal,
      authenticatedUserId: "ada@example.test",
      authenticatedUserProfile: {
        profileId: operatorAuthority.profileId,
        displayName: "Ada",
        hasAvatar: false,
        updatedAt: 1,
      },
      connect: { minProtocol: 1, maxProtocol: 1, client: clientInfo, scopes: ["operator.write"] },
    },
    attachments: createAttachments(),
    logGateway: { warn: vi.fn() } as never,
    userTurn: createUserTurnInputController().controller,
  };
  return { params, entry, connection, revoke: () => (current = false) };
}

describe("prepareChatSendUserTurn private browser audience", () => {
  it("retains a personal browser recipient after normal close, never a successor connection", () => {
    const f = privateBrowserTurnFixture();
    const prepared = prepareChatSendUserTurn(f.params);
    const audience = readConversationPrivateAudience(finalizeInboundContext({ ...prepared.ctx }));
    expect(audience).toMatchObject({
      agentId: "main",
      sessionKey: f.params.session.sessionKey,
      channelId: "webchat",
      accountId: "default",
      nativeChannelId: f.params.session.sessionKey,
      participant: { type: "profile", id: "profile-ada" },
    });
    expect(Object.isFrozen(audience)).toBe(true);
    f.connection.abort(new Error("Normal socket close"));
    // This is retained accepted work, not authority to send to a successor socket.
    expect(() => audience?.assertCurrent()).not.toThrow();
    f.revoke();
    expect(() => audience?.assertCurrent()).toThrow("Original browser authority revoked");
  });

  it.each([
    "owner",
    "unconfirmed",
    "different-person",
    "synthetic",
    "internal-input",
    "group",
    "public",
    "external-route",
    "other-target",
    "explicit-delivery",
    "unretained",
    "disconnected",
  ] as const)("does not attest a private browser audience for %s", (kind) => {
    const f = privateBrowserTurnFixture();
    const { params } = f;
    switch (kind) {
      case "owner":
        params.client!.authenticatedUserProfile!.profileId = GATEWAY_OWNER_PROFILE_ID;
        params.admission.operatorAuthority = createAdmittedRunOperatorAuthority({
          profileId: GATEWAY_OWNER_PROFILE_ID,
          scopes: ["operator.admin"],
          assertCurrent() {},
        });
        break;
      case "unconfirmed":
        params.client!.authenticatedUserProfile = undefined;
        break;
      case "different-person":
        params.client!.authenticatedUserProfile!.profileId = "profile-other";
        break;
      case "synthetic":
        params.client!.internal = { syntheticClient: true };
        break;
      case "internal-input":
        params.request.systemInputProvenance = {
          kind: "inter_session",
          sourceTool: "sessions_send",
        };
        break;
      case "group":
        params.session.entry!.chatType = "group";
        break;
      case "public":
        f.entry.publicShare = {
          id: "share",
          sessionId: "browser-session",
          createdAt: 1,
        };
        break;
      case "external-route":
        params.admission.originatingRoute.originatingChannel = "matrix";
        break;
      case "other-target":
        params.admission.originatingRoute.originatingTo = "agent:main:someone-else";
        break;
      case "explicit-delivery":
        params.admission.originatingRoute.explicitDeliverRoute = true;
        break;
      case "unretained":
        params.admission.operatorAuthority = undefined;
        break;
      case "disconnected":
        f.connection.abort();
        break;
    }
    const prepared = prepareChatSendUserTurn(params);
    expect(readConversationPrivateAudience(prepared.ctx)).toBeUndefined();
  });

  it("reads native personal differences after sessions_send without erasing recorded agent actors", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "browser-private-actor-history" },
      async (state) => {
        const f = await createConversationKnowledgeScenario(state);
        try {
          const person = { type: "profile" as const, id: "profile-ada" };
          const chat = await f.branch("browser", person);
          await recordSessionParticipantInWorker(chat, {
            identity: { type: "agent", id: "main" },
            promptedAt: Date.now(),
            sessionAgentId: chat.agentId,
            expectedSession: chat,
          });
          const sibling = await f.branch("speech", person);
          const siblingOwner = await f.claim(sibling);
          await recordConversationKnowledgeTurn({
            ...siblingOwner,
            ...(await f.append(sibling, "spoken-fact")),
          });
          const chatOwner = await f.claim(chat);
          expect((await f.read(chatOwner, person)).text).toContain(
            "private-destination-audience-unconfirmed",
          );
          const browser = privateBrowserTurnFixture();
          browser.params.session = {
            ...browser.params.session,
            ...chat,
            entry: loadSessionEntry(chat),
            cfg: f.cfg,
          };
          browser.params.admission.originatingRoute.originatingTo = chat.sessionKey;
          browser.params.admission.assertWorkAdmissionCurrent = chatOwner.assertCurrent;
          browser.params.admission.assertSessionTargetCurrent = chatOwner.assertCurrent;
          const preparedInput = prepareChatSendUserTurn(browser.params);
          const audience = readConversationPrivateAudience(preparedInput.ctx);
          expect(audience).toBeDefined();
          const knowledge = await prepareReplyConversationKnowledge({
            ...chatOwner,
            originalParticipant: person,
            destinationAudience: audience,
            getRuntimeConfig: () => f.cfg,
          });
          try {
            expect(knowledge?.fragments.map((part) => part.text).join("\n")).toContain(
              "spoken-fact answer",
            );
            knowledge?.assertCurrent();
            browser.connection.abort();
            expect(() => knowledge?.assertCurrent()).not.toThrow();
            expect(loadSessionEntry(chat)?.participants?.map((row) => row.identity)).toEqual(
              expect.arrayContaining([
                { type: "profile", id: person.id },
                { type: "agent", id: "main" },
              ]),
            );
            await recordSessionParticipantInWorker(chat, {
              identity: { type: "agent", id: "helper" },
              promptedAt: Date.now(),
              sessionAgentId: chat.agentId,
              expectedSession: chat,
            });
            expect(() => knowledge?.assertCurrent()).not.toThrow();
            // The same native COMMIT owner must bind the current, complete actor
            // roster; ignoring it only in a synchronous callback is insufficient.
            const commit = await prepareSessionSourceAuthority(knowledge?.assertCurrent);
            try {
              expect(() => commit.assertCurrent()).not.toThrow();
              const recipientChecks = commit.checks.filter(
                ({ predicate }) =>
                  predicate.sessionKey === chat.sessionKey &&
                  predicate.fields.includes("participants"),
              );
              expect(recipientChecks.length).toBeGreaterThan(0);
              expect(
                recipientChecks.every(
                  ({ predicate }) => predicate.expected?.participantCount === 3,
                ),
              ).toBe(true);
            } finally {
              await commit.release?.();
            }
            await recordSessionParticipantInWorker(chat, {
              identity: {
                type: "observation",
                pluginId: null,
                accountId: null,
                senderKind: "unknown",
                id: "new-unconfirmed-person",
              },
              promptedAt: Date.now(),
              sessionAgentId: chat.agentId,
              expectedSession: chat,
            });
            expect(() => knowledge?.assertCurrent()).toThrow();
          } finally {
            knowledge?.release();
          }
        } finally {
          await f.close();
        }
      },
    );
  });
});
