import path from "node:path";
import { afterAll, afterEach, assert, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  getAdmittedRunDelegatedAuthority,
  resolvePreparedRunAdmission,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import type { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureAgentRunTerminalWriteContext,
  type CapturedAgentRunTerminalWriteContext,
} from "../../infra/agent-run-terminal-writes.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { checkClientVoiceToolConfirmationPolicy } from "../../talk/client-voice-confirmation.js";
import { resetClientVoiceConfirmationStateForTest } from "../../talk/client-voice-confirmation.test-support.js";
import type { SpeechAgentRunControl } from "../../talk/speech/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTalkClientAgentConsultRunner } from "./client-agent-consult.js";

const core = vi.hoisted(() => vi.fn<typeof runEmbeddedAgent>());
// mock-isolation: Exercise real Talk admission and terminal custody without starting a model runtime.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: core }));

let state: OpenClawTestState;
let config: OpenClawConfig;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "talk-terminal-writes" });
  config = { agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } } };
  await state.writeConfig(config);
});
afterEach(() => {
  core.mockReset();
  resetClientVoiceConfirmationStateForTest();
});
afterAll(async () => state?.cleanup());

async function withPublishedSpeechRun(
  params: Parameters<typeof runEmbeddedAgent>[0],
  work: () => ReturnType<typeof runEmbeddedAgent>,
) {
  const sessionKey = params.sessionKey;
  assert(sessionKey, "Speech fixture must publish its admitted session key");
  const admitted = await resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
  const handle = createEmbeddedRunHandle({ runId: params.runId });
  await withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey,
      operationalRunInstance: admitted.operationalRunInstance,
      embeddedRunToolAuthorityBinding: () => ({
        source: "attempt",
        project: () => "current-authority",
        projectAsync: async () => "current-authority",
        assertActive: () => {},
      }),
    },
    () => setActiveEmbeddedRun(params.sessionId, handle, sessionKey),
  );
  try {
    return await work();
  } finally {
    clearActiveEmbeddedRun(params.sessionId, handle, sessionKey);
  }
}

function createSpeechRunner(label: string) {
  const sessionKey = `agent:main:talk-${label}`;
  const chatAbortControllers = new Map();
  const runner = createTalkClientAgentConsultRunner({
    config,
    context: { chatAbortControllers, logGateway: createSubsystemLogger("test/talk-speech") },
    sessionTarget: {
      agentId: "main",
      sessionKey,
      canonicalKey: sessionKey,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    },
    ownerConnId: "speech-connection",
    getVoiceSessionId: () => "voice-session",
    initialItems: [],
    registerRun: () => {},
  });
  return { runner, sessionKey, chatAbortControllers };
}

it.each([false, true])(
  "settles terminal writes before normal close while abort stays immediate (abort=%s)",
  async (abort) => {
    const commit = createDeferred();
    const captured = createDeferred<{
      admitted: AdmittedRunContext;
      writeContext: CapturedAgentRunTerminalWriteContext;
      persistence: Promise<void>;
    }>();
    core.mockImplementation(async (params) => {
      const admitted = await resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
      const writeContext = captureAgentRunTerminalWriteContext(params.runId);
      assert(writeContext);
      const persistence = commit.promise.then(() =>
        writeContext.run(() => writeContext.assertCurrent()),
      );
      writeContext.track(persistence);
      captured.resolve({ admitted, writeContext, persistence });
      return { payloads: [{ text: "Answer" }], meta: { durationMs: 0 } };
    });
    const controller = new AbortController();
    const sessionKey = `agent:main:talk-terminal-${abort}`;
    const runner = createTalkClientAgentConsultRunner({
      config,
      context: {
        chatAbortControllers: new Map(),
        logGateway: createSubsystemLogger("test/talk-terminal-writes"),
      },
      sessionTarget: {
        agentId: "main",
        sessionKey,
        canonicalKey: sessionKey,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      },
      getVoiceSessionId: () => "voice-session",
      initialItems: [],
      registerRun: () => {},
    });
    let settled = false;
    const run = runner.runPrompt({
      prompt: "Check terminal bookkeeping",
      signal: controller.signal,
    });
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      const { admitted, writeContext, persistence } = await awaitGateBeforeSettlement(
        captured.promise,
        run,
        "Talk must reach embedded execution",
      );
      // The wrapper registered its core continuation before this observer.
      await core.mock.results[0]?.value;
      if (abort) {
        controller.abort();
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
        expect(() => writeContext.run(() => writeContext.assertCurrent())).toThrow(
          "Terminal write owner changed before commit",
        );
        commit.resolve();
        await expect(persistence).rejects.toThrow("Terminal write owner changed before commit");
        await expect(run).rejects.toMatchObject({ name: "AbortError" });
      } else {
        expect(settled).toBe(false);
        commit.resolve();
        await persistence;
        await expect(run).resolves.toEqual({ text: "Answer" });
      }
      expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
      expect(() => writeContext.run(() => writeContext.assertCurrent())).toThrow(
        "Terminal write owner changed before commit",
      );
    } finally {
      commit.resolve();
      await run.catch(() => undefined);
    }
  },
);

it("streams permitted speech while pending input holds completion and releases custody for the next turn", async () => {
  const pendingInput = createDeferred();
  const inputHoldReached = createDeferred();
  const firstSpeech = createDeferred();
  const events: Array<{ type: string; text?: string }> = [];
  const controls: Array<SpeechAgentRunControl | undefined> = [];
  core.mockImplementation(async (params) => {
    return await withPublishedSpeechRun(params, async () => {
      await params.onBlockReply?.({ text: "Checking the device.", isCommentary: true });
      await params.onBlockReply?.({ text: "Private reasoning", isReasoning: true });
      await params.onBlockReply?.({ text: "The device is ready." });
      await params.waitForPendingInput?.(params.abortSignal);
      return { payloads: [{ text: "The device is ready." }], meta: { durationMs: 0 } };
    });
  });
  const { runner, sessionKey, chatAbortControllers } = createSpeechRunner("speech-hooks");
  const request = {
    sessionId: "voice-session",
    requesterSessionKey: sessionKey,
    args: { question: "Check the device" },
    transcript: [],
    speakCommentary: true,
    onSpeakableText: (event: { type: string; text?: string }) => {
      events.push(event);
      firstSpeech.resolve();
    },
    onRunControl: (control: SpeechAgentRunControl | undefined) => {
      controls.push(control);
    },
  };
  let settled = false;
  const run = runner.runSpeechConsult({
    ...request,
    waitForPendingInput: () => {
      inputHoldReached.resolve();
      return pendingInput.promise;
    },
  });
  void run
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  try {
    await awaitGateBeforeSettlement(
      inputHoldReached.promise,
      run,
      "Speech must reach the native input hold",
    );
    await awaitGateBeforeSettlement(
      firstSpeech.promise,
      run,
      "Speech must stream before completion",
    );
    expect(settled).toBe(false);
    expect(events).toContainEqual({ type: "chunk", text: "Checking the device." });
    expect(events).not.toContainEqual({ type: "chunk", text: "Private reasoning" });
    expect(controls[0]).toBeTypeOf("function");
    const retainedControl = controls[0];
    assert(retainedControl);
    pendingInput.resolve();
    await expect(run).resolves.toEqual({ text: "The device is ready.", delivered: true });
    expect(controls.at(-1)).toBeUndefined();
    expect(chatAbortControllers.size).toBe(0);
    await expect(retainedControl("An addition after retirement")).rejects.toThrow(
      "no longer current",
    );
    await expect(runner.runSpeechConsult(request)).resolves.toEqual({
      text: "The device is ready.",
      delivered: true,
    });
  } finally {
    pendingInput.resolve();
    await run.catch(() => undefined);
  }
});

it.each([false, true])(
  "retains the host confirmation challenge as required speech after model narration (partial=%s)",
  async (partial) => {
    const events: Array<{ type: string; text?: string }> = [];
    let challengeId: string | undefined;
    core.mockImplementation((params) =>
      withPublishedSpeechRun(params, async () => {
        if (partial) {
          await params.onBlockReply?.({ text: "Checking that request." });
        }
        const decision = checkClientVoiceToolConfirmationPolicy({
          agentId: "main",
          voiceSessionId: "voice-session",
          runId: params.runId,
          toolName: "message",
          toolParams: { action: "send", message: "Please confirm this action" },
        });
        assert(!decision.allowed);
        challengeId = decision.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)?.[1];
        await params.onBlockReply?.({ text: "The message has been sent." });
        return { payloads: [{ text: "The message has been sent." }], meta: { durationMs: 0 } };
      }),
    );
    const { runner } = createSpeechRunner(`confirmation-${partial}`);
    const result = await runner.runSpeechConsult({
      sessionId: "voice-session",
      args: { question: "Send a message" },
      transcript: [],
      onSpeakableText: (event) => {
        events.push(event);
      },
    });
    assert(challengeId);
    expect(result.text).toContain("has not run");
    expect(result.text).toContain('Say "yes"');
    expect(result.text).not.toContain(`VOICE_CONFIRMATION_REQUIRED:${challengeId}`);
    expect(result.delivered).toBe(false);
    expect(events.some((event) => event.text === "The message has been sent.")).toBe(false);
    expect(events).toEqual(partial ? [{ type: "chunk", text: "Checking that request." }] : []);
  },
);
