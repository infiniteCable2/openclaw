import { describe, expect, it } from "vitest";
import {
  recordConversationKnowledgeTurn,
  readConversationKnowledgeRoot,
  readConversationKnowledgeBranch,
  assertNativeKnowledgeRootContribution,
} from "../../config/sessions/conversation-knowledge-store.js";
import { loadSessionEntry, loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { recordSessionParticipantInWorker } from "../../config/sessions/session-sharing-store.async.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";
import {
  createConversationKnowledgeScenario,
  otherPerson,
  person,
} from "./conversation-knowledge.scenario.test-support.js";

describe("private contributions on an unchanged native channel branch", () => {
  it("exchanges new chat/call turns without promoting legacy identity or sharing its history", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "private-channel-contributions" },
      async (state) => {
        const f = await createConversationKnowledgeScenario(state);
        try {
          const chat = await f.branch("chat", person, "channel");
          await recordSessionParticipantInWorker(chat, {
            identity: {
              type: "observation",
              pluginId: "matrix",
              accountId: "local",
              senderKind: "unknown",
              id: person.id,
            },
            promptedAt: Date.now(),
            sessionAgentId: chat.agentId,
            expectedSession: chat,
          });
          const call = await f.branch("call");
          const chatOwner = await f.claim(chat);
          const callOwner = await f.claim(call);
          const before = loadSessionEntry(chat);
          expect(before?.participantCount).toBe(2);
          const historical = await f.append(chat, "unconfirmed-old-chat");
          await recordConversationKnowledgeTurn({ ...chatOwner, ...historical });
          const callTurn = await f.append(call, "verified-call");
          await recordConversationKnowledgeTurn({ ...callOwner, ...callTurn });
          expect((await f.read(chatOwner)).text).toContain(
            "private-destination-audience-unconfirmed",
          );

          let current = true;
          const audience: ConversationPrivateAudience = Object.freeze({
            agentId: chat.agentId,
            sessionKey: chat.sessionKey,
            channelId: "matrix",
            accountId: "local",
            nativeChannelId: "!private:example.test",
            participant: person,
            assertCurrent() {
              if (!current) {
                throw new Error("Audience revoked");
              }
            },
          });
          const readChat = () =>
            prepareReplyConversationKnowledge({
              ...chatOwner,
              originalParticipant: person,
              destinationAudience: audience,
              getRuntimeConfig: () => f.cfg,
            });
          const prepared = await readChat();
          try {
            expect(prepared?.fragments.map((part) => part.text).join("\n")).toContain(
              "verified-call answer",
            );
            current = false;
            expect(() => prepared?.assertCurrent()).toThrow("Audience revoked");
          } finally {
            prepared?.release();
          }
          current = true;

          const next = await f.append(chat, "verified-new-chat");
          if (!next.admission) {
            throw new Error("Expected the native committed user anchor");
          }
          expect(
            await recordConversationKnowledgeTurn({
              ...chatOwner,
              ...next,
              privateAudience: { participant: person, admission: next.admission },
            }),
          ).toBe(true);
          const inCall = await f.read(callOwner);
          expect(inCall.text).toContain("verified-new-chat answer");
          expect(inCall.text).not.toContain("unconfirmed-old-chat");
          const callBranch = await readConversationKnowledgeBranch(callOwner);
          if (!callBranch) {
            throw new Error("Expected the native call branch");
          }
          const rootRead = await readConversationKnowledgeRoot({
            ...callOwner,
            branch: callBranch,
          });
          const reference = (await f.receipts()).find((receipt) => receipt.runId === next.runId);
          if (!reference || !rootRead.evidence) {
            throw new Error("Expected native contribution evidence");
          }
          expect(() =>
            assertNativeKnowledgeRootContribution(rootRead.evidence, callBranch, reference),
          ).not.toThrow();
          expect(Reflect.set(rootRead.evidence, "assertContribution", () => {})).toBe(false);
          for (const forged of [{ assertContribution() {} }, Object.create(rootRead.evidence)]) {
            expect(() =>
              assertNativeKnowledgeRootContribution(forged, callBranch, reference),
            ).toThrow("native root evidence");
          }
          expect(() =>
            assertNativeKnowledgeRootContribution(rootRead.evidence, callBranch, {
              ...reference,
              runId: "forged",
            }),
          ).toThrow("matching native root evidence");
          const foreign = await f.branch("foreign", otherPerson);
          expect((await f.read(await f.claim(foreign), otherPerson)).text).not.toContain(
            "verified-new-chat",
          );
          const after = loadSessionEntry(chat);
          expect(after?.sessionId).toBe(before?.sessionId);
          expect(after?.lifecycleRevision).toBe(before?.lifecycleRevision);
          expect(after?.chatType).toBe("channel");
          expect(after?.participants).toEqual(before?.participants);
          expect(JSON.stringify(await loadTranscriptEvents(chat))).toContain(
            "unconfirmed-old-chat",
          );
        } finally {
          await f.close();
        }
      },
    );
  });
});
