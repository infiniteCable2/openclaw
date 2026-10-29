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
import * as publicationWakeup from "../../config/sessions/conversation-publication-wakeup.js";
import { openConversationPublicationStore } from "../../config/sessions/conversation-publication.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { recordSessionParticipantInWorker } from "../../config/sessions/session-sharing-store.async.js";
import { prepareSessionSourceAuthority } from "../../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  readConversationPrivateAudience,
  retainConversationPrivateAudience,
} from "../../sessions/conversation-private-audience.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureGatewayPrivateConversationAudience } from "../session-input-participant.js";
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
  it("keeps lazily retained native audience authority after the original turn ends", () => {
    let foregroundCurrent = true;
    const release = vi.fn();
    const retain = vi.fn(() => release);
    const nativeSource = Object.freeze({});
    const endpoint = Object.freeze({});
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "profile-example",
      scopes: ["operator.write"],
      source: nativeSource,
      assertCurrent() {},
      retain,
    });
    const audience = captureGatewayPrivateConversationAudience({
      agentId: "example",
      sessionKey: "agent:example:browser",
      participant: { type: "profile", id: operatorAuthority.profileId },
      operatorAuthority,
      retentionSource: endpoint,
      entry: { chatType: "direct" },
      assertCurrent() {
        if (!foregroundCurrent) {
          throw new Error("Original foreground target and work ended");
        }
      },
    });
    expect(audience).toBeDefined();
    expect(retain).not.toHaveBeenCalled();
    const leases = retainConversationPrivateAudience(audience!);
    expect(leases).toHaveLength(1);
    expect(leases[0]!.source).toBe(endpoint);
    expect(retain).toHaveBeenCalledOnce();
    try {
      foregroundCurrent = false;
      expect(() => audience!.assertCurrent()).toThrow("Original foreground target and work ended");
      expect(() => leases[0]!.audience.assertCurrent()).not.toThrow();
      // Retention never revives a source whose original admission already ended.
      expect(() => retainConversationPrivateAudience(audience!)).toThrow();
      expect(retain).toHaveBeenCalledOnce();
    } finally {
      leases[0]!.release();
      leases[0]!.release();
    }
    expect(release).toHaveBeenCalledOnce();
    expect(() => leases[0]!.audience.assertCurrent()).toThrow();
  });

  it("revokes retained browser evidence with its native operator source", () => {
    const revocation = new AbortController();
    const release = vi.fn();
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "profile-example",
      scopes: ["operator.write"],
      signal: revocation.signal,
      assertCurrent() {},
      retain: () => release,
    });
    const audience = captureGatewayPrivateConversationAudience({
      agentId: "example",
      sessionKey: "agent:example:browser",
      participant: { type: "profile", id: operatorAuthority.profileId },
      operatorAuthority,
      entry: { chatType: "direct" },
      assertCurrent() {},
    });
    const leases = retainConversationPrivateAudience(audience!);
    try {
      expect(leases[0]!.signal).toBe(revocation.signal);
      revocation.abort(new Error("Native device or profile revoked"));
      expect(() => leases[0]!.audience.assertCurrent()).toThrow("Native device or profile revoked");
      expect(() => audience!.assertCurrent()).toThrow();
    } finally {
      for (const lease of leases.toReversed()) {
        lease.release();
      }
    }
    expect(release).toHaveBeenCalledOnce();
  });

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

  it("journals the original private browser input before model dispatch", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "browser-private-input-publication" },
      async (state) => {
        const f = await createConversationKnowledgeScenario(state);
        // mock-isolation: Observe the native COMMIT before independent background delivery.
        const wake = vi
          .spyOn(publicationWakeup, "wakeConversationPublication")
          .mockImplementation(() => {});
        try {
          const person = { type: "profile" as const, id: "profile-ada" };
          const chat = await f.branch("browser-input-publication", person);
          const owner = await f.claim(chat);
          const entry = loadSessionEntry(chat);
          if (!entry) {
            throw new Error("Expected the original enrolled browser branch");
          }
          const browser = privateBrowserTurnFixture();
          const input = createUserTurnInputController(browser.params.request.inboundMessage);
          const recorder = createUserTurnTranscriptRecorder({
            input: input.controller.baseInput,
            resolveInput: input.readInput,
            target: { ...chat, sessionEntry: entry, config: f.cfg },
            assertOriginalInputCommit: owner.assertCurrent,
          });
          browser.params.session = { ...browser.params.session, ...chat, entry, cfg: f.cfg };
          browser.params.userTurn = { ...input.controller, recorder };
          browser.params.admission.originatingRoute.originatingTo = chat.sessionKey;
          browser.params.admission.assertWorkAdmissionCurrent = owner.assertCurrent;
          browser.params.admission.assertSessionTargetCurrent = owner.assertCurrent;
          const prepared = prepareChatSendUserTurn(browser.params);
          expect(readConversationPrivateAudience(prepared.ctx)).toBeDefined();

          // Gateway restart-safe admission commits here, before any runner or terminal exists.
          const saved = await recorder.persistApproved();
          expect(saved?.appended).toBe(true);
          expect(saved?.message.content).toBe(browser.params.request.inboundMessage);
          expect(saved?.admission).toBeDefined();
          const journal = openConversationPublicationStore({
            agentId: chat.agentId,
            path: chat.storePath,
            env: chat.env,
            assertCurrent: owner.assertCurrent,
          });
          const ready = await journal.readReadyHeads({ now: Date.now(), limit: 8 });
          expect(ready).toHaveLength(1);
          expect(await journal.stats()).toEqual([{ state: "ready", count: 1 }]);
          expect(ready[0]).toMatchObject({
            state: "ready",
            anchor: {
              entryId: saved!.admission.entryId,
              generation: saved!.admission.generation,
              rawSeq: saved!.admission.rawSeq,
              idempotencyKey: input.controller.baseInput.idempotencyKey,
            },
            intent: {
              version: 1,
              kind: "utterance-observation",
              role: "user",
              inputKey: input.controller.baseInput.idempotencyKey,
              sourceMode: "branches",
              source: {
                sessionKey: chat.sessionKey,
                sessionId: chat.sessionId,
                lifecycleRevision: chat.lifecycleRevision,
              },
              root: { sessionKey: f.root.sessionKey, sessionId: f.root.sessionId },
              privateAudience: { participant: person },
            },
          });
          expect(ready[0]!.intent.privateAudience?.admission).toEqual(ready[0]!.anchor);
          expect(wake).toHaveBeenCalled();
          await recorder.persistApproved();
          expect(await journal.readReadyHeads({ now: Date.now(), limit: 8 })).toEqual(ready);
          await journal.acknowledge(ready[0]!.id);
          expect(await journal.stats()).toEqual([]);
        } finally {
          wake.mockRestore();
          await f.close();
        }
      },
    );
  });

  it("reads native personal differences after sessions_send without erasing recorded agent actors", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "browser-private-actor-history" },
      async (state) => {
        const f = await createConversationKnowledgeScenario(state);
        try {
          const person = { type: "profile" as const, id: "profile-ada" };
          const chat = await f.branch("browser", person);
          // The native writer intentionally ignores the session agent itself.
          // Use another actual recorded actor so this exercises mixed history,
          // rather than accidentally remaining a one-person private session.
          expect(
            await recordSessionParticipantInWorker(chat, {
              identity: { type: "agent", id: "courier" },
              promptedAt: Date.now(),
              sessionAgentId: chat.agentId,
              expectedSession: chat,
            }),
          ).toBe("inserted");
          expect(loadSessionEntry(chat)?.participantCount).toBe(2);
          const sibling = await f.branch("speech", person);
          const siblingOwner = await f.claim(sibling);
          await recordConversationKnowledgeTurn({
            ...siblingOwner,
            ...(await f.append(sibling, "spoken-fact")),
          });
          const chatOwner = await f.claim(chat);
          // Missing private recipient evidence discloses neither source content
          // nor the retired model-facing synchronization status block.
          expect(await f.read(chatOwner, person)).toEqual({ text: "", observed: [] });
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
                { type: "agent", id: "courier" },
              ]),
            );
            expect(
              await recordSessionParticipantInWorker(chat, {
                identity: { type: "agent", id: "helper" },
                promptedAt: Date.now(),
                sessionAgentId: chat.agentId,
                expectedSession: chat,
              }),
            ).toBe("inserted");
            expect(loadSessionEntry(chat)?.participantCount).toBe(3);
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
                recipientChecks.map(({ predicate }) => predicate.expected?.participantCount),
              ).toEqual(recipientChecks.map(() => 3));
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
