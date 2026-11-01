import { expect, it, vi } from "vitest";
import {
  bindConversationPrivateAudience,
  type ConversationPrivateAudience,
} from "../../sessions/conversation-private-audience.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { resolveDefaultSessionStorePath } from "./paths.js";
import {
  loadSessionEntry,
  recordInboundSessionMeta,
  replaceSessionEntrySync,
  updateSessionLastRoute,
} from "./session-accessor.sqlite-entry.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";

const metadataProducers = [
  { name: "inbound metadata", produce: recordInboundSessionMeta },
  { name: "last-route metadata", produce: updateSessionLastRoute },
];

function privateContext(sessionKey: string, overrides: Partial<ConversationPrivateAudience> = {}) {
  // A private two-person room can retain channel/group routing. Privacy follows
  // the original host audience, never the model-visible ChatType field.
  const ctx = { Provider: "webchat", ChatType: "group" };
  const assertCurrent = vi.fn();
  bindConversationPrivateAudience(ctx, {
    agentId: "main",
    sessionKey,
    channelId: "webchat",
    accountId: "default",
    nativeChannelId: "private-room",
    participant: { type: "profile", id: "example-person" },
    assertCurrent,
    ...overrides,
  });
  return { ctx, assertCurrent };
}

it.each(["native", "branches"] as const)(
  "preserves original private creation before dispatch in %s mode",
  async (conversationMode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({ agents: { entries: { main: { conversationMode } } } });
      const storePath = resolveDefaultSessionStorePath("main");
      for (const [index, { produce }] of metadataProducers.entries()) {
        const scope = { storePath, sessionKey: `agent:main:webchat:private-${index}` };
        const { ctx, assertCurrent } = privateContext(scope.sessionKey);
        await produce({ ...scope, ctx, createIfMissing: false });
        expect(loadSessionEntry(scope)).toBeUndefined();
        const created = await produce({ ...scope, ctx });
        expect(created?.visibility).toBe("draft");
        expect(loadSessionEntry(scope)?.visibility).toBe("draft");
        expect(assertCurrent).toHaveBeenCalled();
      }
    });
  },
);

it.each(metadataProducers)(
  "$name never infers private creation or promotes existing history",
  async ({ produce }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const storePath = resolveDefaultSessionStorePath("main");
      for (const kind of ["unbound", "wrong-agent", "wrong-session"] as const) {
        const scope = { storePath, sessionKey: `agent:main:webchat:${kind}` };
        const ctx =
          kind === "unbound"
            ? { Provider: "webchat", ChatType: "direct" }
            : privateContext(scope.sessionKey, {
                ...(kind === "wrong-agent" ? { agentId: "other" } : { sessionKey: "other" }),
              }).ctx;
        expect((await produce({ ...scope, ctx }))?.visibility).toBeUndefined();
      }
      const scope = { storePath, sessionKey: "agent:main:webchat:existing-history" };
      replaceSessionEntrySync(scope, {
        sessionId: "existing-generation",
        updatedAt: 1,
        visibility: "suggest",
      });
      const { ctx, assertCurrent } = privateContext(scope.sessionKey);
      assertCurrent.mockImplementation(() => {
        throw new Error("Original audience revoked");
      });
      await produce({ ...scope, ctx });
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: "existing-generation",
        visibility: "suggest",
      });
      expect(assertCurrent).not.toHaveBeenCalled();
    });
  },
);

it.each(metadataProducers)(
  "$name rechecks original authority after capturing private creation",
  async ({ produce }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        storePath: resolveDefaultSessionStorePath("main"),
        sessionKey: "agent:main:webchat:post-capture-revocation",
      };
      let current = true;
      let checks = 0;
      const { ctx } = privateContext(scope.sessionKey, {
        assertCurrent() {
          checks += 1;
          if (!current) {
            throw new Error("Original audience revoked after capture");
          }
          if (checks === 1) {
            queueMicrotask(() => {
              current = false;
            });
          }
        },
      });
      await expect(produce({ ...scope, ctx })).rejects.toThrow(
        "Original audience revoked after capture",
      );
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(loadSessionEntry(scope)).toBeUndefined();
    });
  },
);

it.each(metadataProducers)(
  "$name rechecks its original creation audience after native writer queueing",
  async ({ produce }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        storePath: resolveDefaultSessionStorePath("main"),
        sessionKey: "agent:main:webchat:queued-private-creation",
      };
      let current = true;
      const { ctx } = privateContext(scope.sessionKey, {
        assertCurrent() {
          if (!current) {
            throw new Error("Original audience revoked");
          }
        },
      });
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const blocking = runExclusiveSqliteSessionWrite(
        resolveSqliteScope(scope),
        async () => {
          entered.resolve();
          await resume.promise;
        },
        "session-entry.patch",
      );
      try {
        await entered.promise;
        const writing = produce({ ...scope, ctx });
        const refused = expect(writing).rejects.toThrow("Original audience revoked");
        current = false;
        resume.resolve();
        await blocking;
        await refused;
        expect(loadSessionEntry(scope)).toBeUndefined();
      } finally {
        resume.resolve();
        await blocking;
      }
    });
  },
);

it("creates one ingress generation without rotating existing or legacy rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const storePath = resolveDefaultSessionStorePath("main");
    const producers = [recordInboundSessionMeta, updateSessionLastRoute];
    for (const [index, produce] of producers.entries()) {
      const scope = { storePath, sessionKey: `agent:main:webchat:dm:generation-${index}` };
      const params = { ...scope, ctx: { Provider: "webchat", ChatType: "direct" } };
      await produce({ ...params, createIfMissing: false });
      expect(loadSessionEntry(scope)).toBeUndefined();

      const created = await produce(params);
      expect(created?.lifecycleRevision).toEqual(expect.any(String));
      expect(created?.lifecycleRevision).not.toBe("");
      await produce(params);
      expect(loadSessionEntry(scope)).toEqual(created);

      const legacy = { sessionId: `legacy-${index}`, updatedAt: 1 };
      replaceSessionEntrySync(scope, legacy);
      await produce(params);
      expect(loadSessionEntry(scope)).toMatchObject(legacy);
      expect(loadSessionEntry(scope)?.lifecycleRevision).toBeUndefined();
    }
  });
});

it("does not stamp a conversation route or blank name as the creating actor", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const storePath = resolveDefaultSessionStorePath("main");
    const participantKey = "agent:main:webchat:dm:route-participant";
    const participant = await updateSessionLastRoute({
      storePath,
      sessionKey: participantKey,
      channel: "webchat",
      to: "webchat:room-1",
      ctx: {
        From: "webchat:room-1",
        SenderId: "webchat:person-1",
        SenderName: "  ",
      },
    });
    expect(participant).toMatchObject({
      createdVia: "channel",
      createdActor: {
        type: "human",
        source: "channel",
        id: "webchat:person-1",
      },
    });
    expect(
      loadSessionEntry({ sessionKey: participantKey, storePath })?.createdActor?.label,
    ).toBeUndefined();
    await updateSessionLastRoute({
      storePath,
      sessionKey: participantKey,
      ctx: { SenderId: "webchat:person-2", SenderName: "Another participant" },
    });
    expect(loadSessionEntry({ sessionKey: participantKey, storePath })?.createdActor).toEqual(
      participant?.createdActor,
    );

    const senderlessKey = "agent:main:webchat:dm:route-senderless";
    const senderless = await updateSessionLastRoute({
      storePath,
      sessionKey: senderlessKey,
      channel: "webchat",
      to: "webchat:room-2",
      ctx: { From: "webchat:room-2", SenderName: "Name without an identity" },
    });
    expect(senderless?.createdVia).toBe("channel");
    expect(senderless?.createdActor).toBeUndefined();
  });
});
