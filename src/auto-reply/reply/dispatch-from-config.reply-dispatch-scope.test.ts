import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginHookReplyDispatchContext } from "../../plugins/hook-types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { ReplyDispatchRun } from "../get-reply-options.types.js";
import {
  createDispatcher,
  emptyConfig,
  hookMocks,
  sessionBindingMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import type { InternalGetReplyFromConfig } from "./get-reply.types.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig reply hook scope", () => {
  beforeEach(() => {
    describe0BeforeEach0();
    setNoAbort();
  });

  it.each([
    {
      name: "canonical internal root",
      sessionKey: "agent:test:internal:conversation-root",
      marked: false,
      mode: "branches",
      bound: false,
    },
    {
      name: "agent-relative internal root",
      sessionKey: "internal:conversation-root",
      marked: false,
      mode: "branches",
      bound: false,
    },
    {
      name: "persisted root after opt-out",
      sessionKey: "agent:test:acp:root",
      marked: true,
      mode: "native",
      bound: false,
    },
    {
      name: "bound persisted root",
      sessionKey: "agent:test:acp:bound-root",
      marked: true,
      mode: "branches",
      bound: true,
    },
  ] as const)(
    "refuses external ACP takeover into $name before harness dispatch",
    async (scenario) => {
      const entry = {
        sessionId: "root-session",
        updatedAt: 1,
        acp: { backend: "acpx" },
        ...(scenario.marked ? { conversationTopology: { version: 1, role: "root" } } : {}),
      };
      sessionStoreMocks.loadSessionStoreEntry.mockReturnValue(entry);
      sessionStoreMocks.loadSessionEntry.mockReturnValue(entry);
      if (scenario.bound) {
        sessionBindingMocks.resolveByConversation.mockReturnValue({
          bindingId: "root-dispatch-binding",
          targetSessionKey: scenario.sessionKey,
          targetKind: "session",
          status: "active",
          boundAt: 1,
          conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
        });
      }
      hookMocks.runner.hasHooks.mockReturnValue(true);
      const replyResolver = vi.fn<InternalGetReplyFromConfig>();
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { test: { conversationMode: scenario.mode } } },
      };
      await expect(
        dispatchReplyFromConfig({
          ctx: buildTestCtx({
            Body: "hello",
            SessionKey: scenario.bound ? "agent:test:discord:channel:C1" : scenario.sessionKey,
            AgentId: "test",
            Provider: "discord",
            Surface: "discord",
            To: "C1",
            AccountId: "default",
          }),
          cfg,
          dispatcher: createDispatcher(),
          replyResolver,
        }),
      ).rejects.toThrow(
        scenario.marked ? "Explicitly migrate" : "reserves its internal root for consolidation",
      );
      expect(hookMocks.runner.runReplyDispatch).not.toHaveBeenCalled();
      expect(replyResolver).not.toHaveBeenCalled();
    },
  );

  it.each(["native", "branch", "task", "system"] as const)(
    "preserves ordinary %s ACP dispatch without a new root authority",
    async (kind) => {
      const sessionKey = kind === "branch" ? "agent:test:acp:conversation" : "agent:test:main";
      const entry = {
        sessionId: "target-session",
        updatedAt: 1,
        acp: { backend: "acpx" },
        ...(kind === "task" || kind === "system"
          ? { conversationTopology: { version: 1, role: "root" } }
          : {}),
      };
      sessionStoreMocks.loadSessionStoreEntry.mockReturnValue(entry);
      sessionStoreMocks.loadSessionEntry.mockReturnValue(entry);
      hookMocks.runner.hasHooks.mockImplementation((name) => name === "reply_dispatch");
      hookMocks.runner.runReplyDispatch.mockResolvedValue({
        handled: true,
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      });
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Body: "hello",
          SessionKey: sessionKey,
          AgentId: "test",
          ...(kind === "task"
            ? {
                InputProvenance: {
                  kind: "inter_session",
                  sourceSessionKey: "agent:test:task",
                } as const,
              }
            : {}),
          ...(kind === "system" ? { InternalTurnSource: "event" as const } : {}),
        }),
        cfg: {
          agents: {
            ownership: "explicit",
            entries: { test: { conversationMode: kind === "native" ? "native" : "branches" } },
          },
        },
        dispatcher: createDispatcher(),
        replyResolver: vi.fn<InternalGetReplyFromConfig>(),
      });
      expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledOnce();
      expect(result.queuedFinal).toBe(true);
    },
  );

  it.each<{
    name: string;
    targetKey: string;
    expectedKind: "agent" | "acp";
    sourceKey?: string;
    bound?: boolean;
    tail?: boolean;
  }>([
    {
      name: "local command target from ACP source",
      sourceKey: "agent:test:acp:source",
      targetKey: "agent:test:target",
      expectedKind: "agent",
    },
    {
      name: "bound ACP reset tail",
      sourceKey: "agent:test:discord:channel:C1",
      targetKey: "agent:test:acp:bound",
      bound: true,
      tail: true,
      expectedKind: "acp",
    },
  ])("scopes reply hooks to the prepared $name", async (scenario) => {
    const onAgentRunStart = vi.fn(() => "reply-dispatch");
    const dispatchRun: ReplyDispatchRun = {
      completionSource: "reply-dispatch",
      getResult: () => ({}),
    };
    const userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
      input: { text: "source user turn" },
      target: () => undefined,
    });
    const sourceKey = scenario.sourceKey ?? scenario.targetKey;
    const sourceEntry = { sessionId: "source-session", updatedAt: Date.now() };
    const targetEntry = { sessionId: "target-session", updatedAt: Date.now() };
    if (sourceKey !== scenario.targetKey) {
      sessionStoreMocks.entriesBySessionKey.set(sourceKey, sourceEntry);
    }
    sessionStoreMocks.entriesBySessionKey.set(scenario.targetKey, targetEntry);
    const readEntry = (...args: unknown[]) => {
      const { sessionKey } = args[0] as { sessionKey: string };
      return sessionStoreMocks.entriesBySessionKey.get(sessionKey);
    };
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(readEntry);
    sessionStoreMocks.loadSessionEntry.mockImplementation(readEntry);
    if (scenario.bound) {
      sessionBindingMocks.resolveByConversation.mockReturnValue({
        bindingId: "bound-dispatch-kind",
        targetSessionKey: scenario.targetKey,
        targetKind: "session",
        status: "active",
        boundAt: Date.now(),
        conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
      });
    }
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName, scope) => hookName === "reply_dispatch" && scope?.dispatchKind !== "agent",
    );
    hookMocks.runner.runReplyDispatch.mockImplementation(async (eventValue, contextValue) => {
      expect(eventValue).toMatchObject({ sessionKey: scenario.targetKey });
      expect(contextValue).toMatchObject({ dispatchKind: "acp" });
      const event = eventValue as { isTailDispatch?: boolean };
      if (!scenario.tail || event.isTailDispatch) {
        const context = contextValue as PluginHookReplyDispatchContext;
        expect(context.onAgentRunStart?.("dispatched-run", undefined, dispatchRun)).toBe(
          "reply-dispatch",
        );
        context.userTurnTranscriptRecorder?.replaceTextBeforePersistence?.("accepted user turn");
      }
      return scenario.tail && !event.isTailDispatch
        ? undefined
        : {
            handled: true,
            queuedFinal: true,
            counts: { tool: 0, block: 0, final: 1 },
          };
    });
    const replyResolver = vi.fn<InternalGetReplyFromConfig>(async (ctx, options) => {
      if (scenario.tail) {
        ctx.AcpDispatchTailAfterReset = true;
        return undefined;
      }
      expect(options?.onAgentRunStart?.("dispatched-run", undefined, dispatchRun)).toBe(
        "reply-dispatch",
      );
      return { text: "local reply" };
    });
    const ctx = buildTestCtx({
      Body: "hello",
      BodyForAgent: "hello",
      SessionKey: sourceKey,
      Provider: "discord",
      Surface: "discord",
      To: "C1",
      AccountId: "default",
      ...(scenario.sourceKey && !scenario.bound
        ? { CommandSource: "native", CommandTargetSessionKey: scenario.targetKey }
        : {}),
    });
    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver,
      replyOptions: { onAgentRunStart, userTurnTranscriptRecorder },
    });
    expect(result.queuedFinal).toBe(true);
    expect(hookMocks.runner.hasHooks).toHaveBeenCalledWith("reply_dispatch", {
      dispatchKind: scenario.expectedKind,
    });
    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledTimes(
      scenario.expectedKind === "agent" ? 0 : scenario.tail ? 2 : 1,
    );
    expect(replyResolver).toHaveBeenCalledTimes(
      scenario.expectedKind === "agent" || scenario.tail ? 1 : 0,
    );
    expect(onAgentRunStart).toHaveBeenCalledExactlyOnceWith(
      "dispatched-run",
      undefined,
      dispatchRun,
    );
    expect(userTurnTranscriptRecorder.message?.content).toBe(
      scenario.expectedKind === "acp" ? "accepted user turn" : "source user turn",
    );
  });

  it("refuses restricted ACP takeover before invoking reply hooks", async () => {
    const sessionKey = "agent:test:restricted-acp";
    const entry = {
      sessionId: "restricted-acp-session",
      updatedAt: Date.now(),
      acp: { backend: "acpx" },
    };
    sessionStoreMocks.entriesBySessionKey.set(sessionKey, entry);
    const readEntry = () => entry;
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(readEntry);
    sessionStoreMocks.loadSessionEntry.mockImplementation(readEntry);
    hookMocks.runner.hasHooks.mockReturnValue(true);
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: true,
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn<InternalGetReplyFromConfig>();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: "hello",
        BodyForAgent: "hello",
        SessionKey: sessionKey,
        Provider: "discord",
        Surface: "discord",
        To: "C1",
        AccountId: "default",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        admittedSessionSettings: {
          permissionMode: "guarded",
          toolOverrides: { webSearch: false },
        },
      },
    });

    expect(hookMocks.runner.runReplyDispatch).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("cannot enforce its permission or tool policy"),
      }),
    );
    expect(result.queuedFinal).toBe(true);
  });
});
