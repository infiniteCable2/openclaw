import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import type { Context } from "../../../llm/types.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import { publishInternalModelContext } from "../../runtime/internal-hooks.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createCompactionRequestBudget } from "../../sessions/compaction/request-budget.js";
import { convertToLlm, type CustomMessage } from "../../sessions/messages.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput, createSession, sessionId } from "./attempt-prompt-submit.test-support.js";

registerAgentSessionLoopTestLifecycle();
afterEach(() => clearEmbeddedSessionPromptStates([sessionId]));

describe("prepared conversation context dispatch", () => {
  it("silently installs durable observations only at existing model dispatches", async () => {
    const read = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Current status" }],
      details: {},
    }));
    const { session, sessionManager } = await createTestSession({
      customTools: [
        {
          name: "read_status",
          label: "Read status",
          description: "Read current status",
          parameters: Type.Object({}),
          execute: read,
        },
      ],
    });
    const requests: Context["messages"][] = [];
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream(
        createAssistant(
          model,
          requests.length === 1
            ? [{ type: "toolCall", id: "read-current-status", name: "read_status", arguments: {} }]
            : [{ type: "text", text: "answer" }],
          requests.length === 1 ? "toolUse" : "stop",
        ),
      );
    });
    const refreshConversationContext = vi.fn<
      NonNullable<Parameters<typeof submitEmbeddedAttemptPrompt>[0]["refreshConversationContext"]>
    >(async ({ canAdmit }) => {
      const message: CustomMessage = {
        role: "custom",
        customType: "test.related-conversation",
        content: `Observation ${requests.length + 1}`,
        display: false,
        details: { packetId: `packet-${requests.length + 1}` },
        timestamp: 2,
      };
      if (!canAdmit(message)) {
        return [];
      }
      // The producer owns the durable receipt; the runner must not write it again.
      await sessionManager.appendCustomMessageEntryAsync(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
      return [message];
    });
    await submitEmbeddedAttemptPrompt({
      ...createBaseInput(),
      activeSession: session,
      modelPrompt: "transcript prompt",
      prependContext: undefined,
      appendContext: undefined,
      compactionRequestBudget: createCompactionRequestBudget({
        contextWindow: 8_000,
        reserveTokens: 1_024,
        pendingPrompt: "transcript prompt",
      }),
      refreshConversationContext,
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    });
    expect(requests).toHaveLength(2);
    expect(read).toHaveBeenCalledOnce();
    expect(refreshConversationContext).toHaveBeenCalledTimes(2);
    expect(requests[1]?.slice(0, requests[0]?.length)).toEqual(requests[0]);
    expect(JSON.stringify(requests[0])).toContain("Observation 1");
    expect(JSON.stringify(requests[0])).not.toContain("Observation 2");
    expect(JSON.stringify(requests[1])).toContain("Observation 2");
    const entries = sessionManager.getEntries();
    expect(entries.filter((entry) => entry.type === "custom_message")).toHaveLength(2);
    expect(
      entries.filter((entry) => entry.type === "message" && entry.message.role === "user"),
    ).toHaveLength(1);
  });

  it("keeps prepared packets in the prefix without refreshing during active response steering", async ({
    signal,
  }) => {
    const { session, sessionManager } = await createTestSession();
    const started = createDeferred();
    const steered = createDeferred();
    const firstResponse = createAssistantMessageEventStream();
    const steer = vi.fn(async () => {
      steered.resolve();
      return true;
    });
    const activeResponse: { disconnect: (() => void) | void } = { disconnect: undefined };
    let requests = 0;
    streamMocks.streamSimple.mockImplementation((model, _context, options) => {
      requests++;
      if (requests === 1) {
        activeResponse.disconnect = options?.onActiveResponse?.({ steer });
        expect(publishInternalModelContext(options?.onActiveResponse, [])).toBe(false);
        started.resolve();
        return firstResponse;
      }
      return createAssistantResultStream(createAssistant(model, [{ type: "text", text: "done" }]));
    });
    const message: CustomMessage = {
      role: "custom",
      customType: "test.related-conversation",
      content: "Prepared observation",
      display: false,
      details: { packetId: "prepared" },
      timestamp: 2,
    };
    const refreshConversationContext = vi.fn<
      NonNullable<Parameters<typeof submitEmbeddedAttemptPrompt>[0]["refreshConversationContext"]>
    >(async ({ canAdmit }) => {
      if (requests > 0 || !canAdmit(message)) {
        return [];
      }
      await sessionManager.appendCustomMessageEntryAsync(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
      return [message];
    });
    const running = submitEmbeddedAttemptPrompt({
      ...createBaseInput(),
      activeSession: session,
      refreshConversationContext,
      compactionRequestBudget: createCompactionRequestBudget({
        contextWindow: 8_000,
        reserveTokens: 1_024,
      }),
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(started.promise, running, "Provider did not start"),
        signal,
      );
      await withinTest(session.steer("Additional user instruction"), signal);
      await withinTest(
        awaitGateBeforeSettlement(
          steered.promise,
          running,
          "Steering did not reach the active provider",
        ),
        signal,
      );
      expect(refreshConversationContext).toHaveBeenCalledOnce();
      expect(steer).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ role: "user", content: expect.anything() }),
      ]);
      expect(JSON.stringify(steer.mock.calls)).toContain("Additional user instruction");
      expect(JSON.stringify(steer.mock.calls)).not.toContain("Prepared observation");
    } finally {
      activeResponse.disconnect?.();
      firstResponse.push({
        type: "done",
        reason: "stop",
        message: createAssistant(testModel, [{ type: "text", text: "done" }]),
      });
      firstResponse.end();
      await running;
    }
    expect(refreshConversationContext).toHaveBeenCalledTimes(requests);
    expect(
      sessionManager.getEntries().filter((entry) => entry.type === "custom_message"),
    ).toHaveLength(1);
  });

  it("does not duplicate durable packet occurrences across a native provider retry", async () => {
    const { session, sessionManager } = await createTestSession({
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
      }),
    });
    const requests: Context["messages"][] = [];
    let firstRequest: Parameters<typeof publishInternalModelContext>[0];
    streamMocks.streamSimple.mockImplementation((model, context, options) => {
      firstRequest ??= options?.onActiveResponse;
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream(
        requests.length === 1
          ? { ...createAssistant(model, [], "error"), errorMessage: "503 overloaded" }
          : createAssistant(model, [{ type: "text", text: "done" }]),
      );
    });
    const message: CustomMessage = {
      role: "custom",
      customType: "test.related-conversation",
      content: "One durable observation",
      display: false,
      details: { packetId: "once" },
      timestamp: 2,
    };
    await submitEmbeddedAttemptPrompt({
      ...createBaseInput(),
      activeSession: session,
      modelPrompt: "transcript prompt",
      prependContext: undefined,
      appendContext: undefined,
      compactionRequestBudget: createCompactionRequestBudget({
        contextWindow: 8_000,
        reserveTokens: 1_024,
      }),
      refreshConversationContext: async ({ canAdmit }) => {
        if (requests.length === 0 && canAdmit(message)) {
          await sessionManager.appendCustomMessageEntryAsync(
            message.customType,
            message.content,
            message.display,
            message.details,
          );
        }
        return [{ ...message }];
      },
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    });
    expect(requests).toHaveLength(2);
    expect(firstRequest).toBeDefined();
    expect(publishInternalModelContext(firstRequest, [])).toBe(false);
    const providerMessages = (messages: Context["messages"] | undefined) =>
      messages?.map(({ role, content }) => ({ role, content }));
    expect(providerMessages(requests[1])).toEqual(providerMessages(requests[0]));
    expect(
      session.messages.filter(
        (entry) => entry.role === "custom" && entry.customType === message.customType,
      ),
    ).toHaveLength(1);
    expect(
      sessionManager.getEntries().filter((entry) => entry.type === "custom_message"),
    ).toHaveLength(1);
  });

  it("does not dispatch or install observations after host authority closes", async () => {
    const { activeSession, originalTransformContext, baseStreamFn } = createSession();
    let active = true;
    const message: CustomMessage = {
      role: "custom",
      customType: "test.related-conversation",
      content: "Late observation",
      display: false,
      details: { packetId: "late" },
      timestamp: 2,
    };
    await expect(
      submitEmbeddedAttemptPrompt({
        ...createBaseInput(),
        activeSession,
        assertHostActive: () => {
          if (!active) {
            throw new Error("host authority closed");
          }
        },
        refreshConversationContext: async () => {
          active = false;
          return [message];
        },
        promptActiveSession: async (_prompt, options) => {
          options?.preflightResult?.(true);
          const messages = await activeSession.agent.transformContext(activeSession.messages);
          await activeSession.agent.streamFn(testModel, {
            systemPrompt: "system prompt",
            messages: convertToLlm(messages),
            tools: [],
          });
        },
      }),
    ).rejects.toThrow("host authority closed");
    expect(activeSession.messages).not.toContain(message);
    expect(activeSession.agent.transformContext).toBe(originalTransformContext);
    expect(activeSession.agent.streamFn).toBe(baseStreamFn);
  });
});
