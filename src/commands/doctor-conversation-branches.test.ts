import { expect, it } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { CONVERSATION_KNOWLEDGE_CHECKPOINT } from "../config/sessions/conversation-knowledge-checkpoint.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReceipt,
} from "../config/sessions/conversation-knowledge.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry-replace.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { replaceSqliteTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { resolveAgentConversationRootSessionKey } from "../config/sessions/session-conversation-root-key.js";
import { createSessionTranscriptHeader } from "../config/sessions/transcript-header.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { linkUserChannelIdentity } from "../state/user-channel-identities.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { detectConversationBranchFindings } from "./doctor-conversation-branches.js";

it("reports branch integrity separately from exact channel profile links and leaves the native stores unchanged", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "doctor-conversation-branches" },
    async (state) => {
      const agentId = "main";
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { conversationMode: "branches" } } },
      };
      const env = state.env;
      const options = { agentId, env };
      const database = openOpenClawAgentDatabase(options);
      const rootKey = resolveAgentConversationRootSessionKey({ agentId, cfg });
      const root = {
        agentId,
        sessionKey: rootKey,
        sessionId: "root-instance",
        lifecycleRevision: "root-life",
      };
      const source = {
        agentId,
        sessionKey: "agent:main:source",
        sessionId: "source-instance",
        lifecycleRevision: "source-life",
      };
      const participant = {
        type: "remote",
        pluginId: "matrix",
        domain: "matrix",
        idKind: "user-id",
        id: "@sample:example.test",
      } as const;
      const identity = {
        channelId: "matrix",
        accountId: "sample-account",
        senderId: participant.id,
      };
      replaceSessionEntrySync(
        { ...root, env },
        {
          ...root,
          updatedAt: 1,
          createdVia: "internal",
          createdActor: { type: "system", id: "conversation-root" },
          visibility: "draft",
          delivery: { kind: "none" },
          conversationTopology: { role: "root", version: 1 },
        },
      );
      replaceSessionEntrySync(
        { ...source, env },
        {
          ...source,
          updatedAt: 1,
          chatType: "direct",
          createdActor: { type: "human", source: "channel", id: participant.id },
          delivery: {
            kind: "external",
            route: { channel: "matrix", accountId: identity.accountId },
            context: {},
            origin: { from: participant.id },
          },
          conversationTopology: {
            role: "branch",
            version: 1,
            rootSessionKey: rootKey,
            rootSessionId: root.sessionId,
            rootSessionLifecycleRevision: "superseded-root-life",
          },
        },
      );
      recordSessionParticipant(
        { ...source, env },
        { identity: { type: "profile", id: GATEWAY_OWNER_PROFILE_ID }, promptedAt: 1 },
      );
      const anchors = runOpenClawAgentWriteTransaction((owner) => {
        const timestamp = new Date(1).toISOString();
        replaceSqliteTranscriptEventsInTransaction(owner, source, [
          createSessionTranscriptHeader({ sessionId: source.sessionId, timestamp }),
          {
            type: "message",
            id: "first",
            parentId: null,
            timestamp,
            message: { role: "user", content: "Synthetic first contribution", timestamp: 1 },
          },
          {
            type: "message",
            id: "second",
            parentId: "first",
            timestamp,
            message: { role: "user", content: "Synthetic second contribution", timestamp: 1 },
          },
        ]);
        return ["first", "second"].map((entryId) =>
          readActiveTranscriptEntryAnchorInTransaction({
            database: owner,
            resolved: source,
            entryId,
          }),
        );
      }, options);
      const [first, second] = anchors;
      if (!first || !second) {
        throw new Error("Native transcript did not produce both anchors");
      }
      const missing = {
        ...source,
        sessionKey: "agent:main:missing",
        sessionId: "missing-instance",
      };
      const receipt: ConversationKnowledgeReceipt = {
        source,
        origin: conversationKnowledgeOrigin(source),
        version: 1,
        sourceMode: "branches",
        runId: "native-run",
        through: first,
        privateAudience: { participant, admission: first },
      };
      const missingReceipt = {
        ...receipt,
        source: missing,
        origin: conversationKnowledgeOrigin(missing),
        through: { ...first, ...missing },
        privateAudience: undefined,
      };
      const historicalSource = { ...source, lifecycleRevision: "previous-source-life" };
      const custom = (
        id: string,
        parentId: string | null,
        details: unknown,
        customType = CONVERSATION_KNOWLEDGE_REPORT as string,
      ) => ({
        type: "custom_message",
        id,
        parentId,
        timestamp: new Date(1).toISOString(),
        content: "Synthetic report",
        display: false,
        customType,
        details,
      });
      const rootEvents = [
        createSessionTranscriptHeader({ sessionId: root.sessionId }),
        custom("exact", null, receipt),
        custom("duplicate", "exact", receipt),
        custom("stale", "duplicate", {
          ...receipt,
          through: { ...second, generation: "old" },
          privateAudience: { participant, admission: { ...first, generation: "old" } },
        }),
        custom("missing", "stale", missingReceipt),
        custom("missing-next", "missing", {
          ...missingReceipt,
          through: { ...second, ...missing },
        }),
        custom("historical", "missing-next", {
          ...receipt,
          source: historicalSource,
          origin: conversationKnowledgeOrigin(historicalSource),
        }),
        custom("historical-no-range", "historical", {
          ...receipt,
          source: historicalSource,
          origin: conversationKnowledgeOrigin(historicalSource),
          through: second,
          privateAudience: undefined,
        }),
        custom("current-no-audience", "historical-no-range", {
          ...receipt,
          through: second,
          privateAudience: undefined,
        }),
        custom("malformed", "current-no-audience", {}),
        custom("checkpoint", "malformed", {}, CONVERSATION_KNOWLEDGE_CHECKPOINT),
      ];
      const replaceRoot = (events: typeof rootEvents) =>
        runOpenClawAgentWriteTransaction((owner) => {
          replaceSqliteTranscriptEventsInTransaction(owner, root, events);
        }, options);
      replaceRoot(rootEvents);
      const check = () => detectConversationBranchFindings({ cfg, env });
      const withoutStore = await check();
      expect(withoutStore.map((finding) => finding.errorCode)).toContain(
        "identity-check-unavailable",
      );
      const profile = ensureProfileForEmail("sample@example.test", { env });
      linkUserChannelIdentity(profile.id, { ...identity, accountId: "other-account" }, { env });
      const before = await check();
      expect(before).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ errorCode: "branch-root-binding", details: { count: 1 } }),
          expect.objectContaining({ errorCode: "anchor-unresolved", details: { count: 1 } }),
          expect.objectContaining({
            errorCode: "source-missing",
            details: { count: 2, sourceSessions: 1 },
            message: expect.stringContaining("References: 2. Source sessions: 1."),
          }),
          expect.objectContaining({
            errorCode: "source-historical",
            details: { count: 2, referencesWithoutPrivateRange: 1 },
          }),
          expect.objectContaining({
            errorCode: "source-audience-unavailable",
            details: { count: 1, sourceSessions: 1 },
          }),
          expect.objectContaining({ errorCode: "reference-invalid", details: { count: 1 } }),
          expect.objectContaining({ errorCode: "checkpoint-invalid", details: { count: 1 } }),
          expect.objectContaining({
            errorCode: "channel-identity-unlinked",
            details: {
              references: 2,
              identityGroups: 1,
              referencesPerGroup: [2],
            },
          }),
        ]),
      );
      expect(JSON.stringify(before)).not.toMatch(
        /@sample|sample-account|Synthetic first|root-instance/,
      );
      expect(await check()).toEqual(before);
      linkUserChannelIdentity(profile.id, identity, { env });
      expect(await check()).toEqual(
        before.filter((finding) => finding.errorCode !== "channel-identity-unlinked"),
      );
      expect(database.db.isOpen).toBe(true);
    },
  );
}, 60_000);
