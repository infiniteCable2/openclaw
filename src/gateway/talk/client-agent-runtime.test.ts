import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  getAdmittedRunDelegatedAuthority,
  readAdmittedRunOperatorAuthority,
  readPreparedRunOperatorAuthority,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

type RunParams = Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];
type NativeRunParams = Parameters<
  typeof import("../../agents/embedded-agent.js").runEmbeddedAgent
>[0];
const mocks = vi.hoisted(() => ({
  runEmbeddedAgent: vi.fn<(params: NativeRunParams) => Promise<{ payloads: [] }>>(),
  onTerminalDrain: vi.fn<() => void>(),
}));

// mock-isolation: Do not load the plugin catalog or a production execution backend.
vi.mock("../../plugins/runtime/index.js", () => ({ createPluginRuntime: () => ({ agent: {} }) }));
// mock-isolation: Admission is real; the model backend is deliberately not executed.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.runEmbeddedAgent }));
// mock-isolation: Transcript persistence is separate from this original-source admission boundary.
vi.mock("../../sessions/user-turn-transcript.js", () => ({
  buildRunUserTurnIdempotencyKey: (runId: string) => runId,
  createUserTurnTranscriptRecorder: () => undefined,
}));
vi.mock("../../infra/agent-run-terminal-writes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/agent-run-terminal-writes.js")>();
  return {
    ...actual,
    drainAgentRunTerminalWrites: (
      ...args: Parameters<typeof actual.drainAgentRunTerminalWrites>
    ) => {
      mocks.onTerminalDrain();
      return actual.drainAgentRunTerminalWrites(...args);
    },
  };
});

import { captureAgentRunTerminalWriteContext } from "../../infra/agent-run-terminal-writes.js";
import {
  createTalkClientAgentRuntime,
  type TalkOperatorRunSource,
} from "./client-agent-runtime.js";

function runParams(abortSignal?: AbortSignal): RunParams {
  return {
    config: {},
    prompt: "Check the requested facts.",
    runId: "talk-source-run",
    sessionId: "talk-source-session",
    sessionTarget: {
      agentId: "researcher",
      sessionId: "talk-source-session",
      sessionKey: "agent:researcher:talk",
      storePath: "/tmp/openclaw-test/sessions",
    },
    workspaceDir: "/tmp/openclaw-test/workspace",
    timeoutMs: 60_000,
    abortSignal,
  };
}

function originalSource() {
  const releaseAdmissionHold = vi.fn();
  const release = vi.fn();
  let current = true;
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "operator-alpha",
    scopes: ["operator.write"],
    gatewayAccessGrant: null,
    rolePolicy: { sessionAccessCap: "none", sandboxRequired: true, agents: ["researcher"] },
    assertCurrent: () => {
      if (!current) {
        throw new Error("Original operator source was revoked");
      }
    },
    retain: () => {
      authority.assertCurrent();
      return releaseAdmissionHold;
    },
  });
  const capture = vi.fn<TalkOperatorRunSource>(async () => ({ authority, release }));
  return {
    authority,
    capture,
    release,
    releaseAdmissionHold,
    revoke: () => {
      current = false;
    },
  };
}

beforeEach(() => {
  mocks.runEmbeddedAgent.mockReset();
  mocks.runEmbeddedAgent.mockResolvedValue({ payloads: [] });
  mocks.onTerminalDrain.mockReset();
});

describe("Talk original-source admission", () => {
  it("keeps the original restriction across native retries without spawning task authority", async () => {
    const source = originalSource();
    let prepared: PreparedAgentRunAdmission | undefined;
    let admitted: AdmittedRunContext | undefined;
    mocks.runEmbeddedAgent.mockImplementationOnce(async (params) => {
      prepared = params.preparedRunAdmission;
      expect(readPreparedRunOperatorAuthority(prepared)).toBe(source.authority);
      expect(params).not.toHaveProperty("spawnedBy");
      admitted = await prepared!.admit("embedded");
      expect(await prepared!.admit("plugin-harness")).toBe(admitted);
      expect(readAdmittedRunOperatorAuthority(admitted)).toBe(source.authority);
      expect(source.release).not.toHaveBeenCalled();
      return { payloads: [] };
    });

    await createTalkClientAgentRuntime({
      config: {},
      captureOperatorAuthority: source.capture,
    }).runEmbeddedAgent(runParams());

    expect(source.capture).toHaveBeenCalledOnce();
    expect(source.releaseAdmissionHold).toHaveBeenCalledOnce();
    expect(source.release).toHaveBeenCalledOnce();
    expect(() => readPreparedRunOperatorAuthority(prepared)).toThrow("no longer active");
    expect(getAdmittedRunDelegatedAuthority(admitted!)).toBeUndefined();
  });

  it("does not turn a source without operator identity into an operator", async () => {
    const capture = vi.fn<TalkOperatorRunSource>(async () => undefined);
    mocks.runEmbeddedAgent.mockImplementationOnce(async (params) => {
      expect(readPreparedRunOperatorAuthority(params.preparedRunAdmission)).toBeUndefined();
      const admitted = await params.preparedRunAdmission!.admit("embedded");
      expect(readAdmittedRunOperatorAuthority(admitted)).toBeUndefined();
      return { payloads: [] };
    });
    await createTalkClientAgentRuntime({
      config: {},
      captureOperatorAuthority: capture,
    }).runEmbeddedAgent(runParams());
    expect(capture).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "replace"] as const)(
    "releases a captured source when %s wins during preparation",
    async (change) => {
      const source = originalSource();
      const entered = createDeferred();
      const resume = createDeferred();
      const controller = new AbortController();
      let current = true;
      const runtime = createTalkClientAgentRuntime({
        config: {},
        assertCurrent: () => {
          if (!current) {
            throw new Error("Talk owner was replaced");
          }
        },
        captureOperatorAuthority: async (invocation) => {
          expect(invocation.signal).toBe(controller.signal);
          invocation.assertCurrent();
          entered.resolve();
          await resume.promise;
          return source.capture(invocation);
        },
      });
      const run = runtime.runEmbeddedAgent(runParams(controller.signal));
      const rejected = expect(run).rejects.toThrow(change === "cancel" ? "cancelled" : "replaced");
      try {
        await awaitGateBeforeSettlement(entered.promise, run, "Source capture was not reached");
        if (change === "cancel") {
          controller.abort(new Error("Talk run cancelled"));
        } else {
          current = false;
        }
      } finally {
        resume.resolve();
        await rejected;
      }
      expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(source.releaseAdmissionHold).not.toHaveBeenCalled();
      expect(source.release).toHaveBeenCalledOnce();
    },
  );

  it("refuses a revoked original authority before dispatch and releases its source", async () => {
    const source = originalSource();
    source.revoke();
    await expect(
      createTalkClientAgentRuntime({
        config: {},
        captureOperatorAuthority: source.capture,
      }).runEmbeddedAgent(runParams()),
    ).rejects.toThrow("Original operator source was revoked");
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(source.release).toHaveBeenCalledOnce();
  });

  it("retains live Talk ownership in native admission, not only before model dispatch", async () => {
    let current = true;
    mocks.runEmbeddedAgent.mockImplementationOnce(async (params) => {
      await params.preparedRunAdmission!.admit("embedded");
      current = false;
      expect(() => params.preparedRunAdmission!.assertSourceCurrent()).toThrow(
        "Talk owner was replaced",
      );
      return { payloads: [] };
    });
    await createTalkClientAgentRuntime({
      config: {},
      assertCurrent: () => {
        if (!current) {
          throw new Error("Talk owner was replaced");
        }
      },
    }).runEmbeddedAgent(runParams());
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "joins accepted terminal writes before releasing the original source (abort=%s)",
    async (abort) => {
      const source = originalSource();
      const draining = createDeferred();
      const terminal = createDeferred();
      const controller = new AbortController();
      let prepared: PreparedAgentRunAdmission | undefined;
      let admitted: AdmittedRunContext | undefined;
      mocks.onTerminalDrain.mockImplementation(() => draining.resolve());
      mocks.runEmbeddedAgent.mockImplementationOnce(async (params) => {
        prepared = params.preparedRunAdmission;
        admitted = await prepared!.admit("embedded");
        const write = captureAgentRunTerminalWriteContext(params.runId);
        if (!write) {
          throw new Error("Actual native terminal write custody was not available");
        }
        write.track(terminal.promise);
        return { payloads: [] };
      });
      const run = createTalkClientAgentRuntime({
        config: {},
        captureOperatorAuthority: source.capture,
      }).runEmbeddedAgent(runParams(controller.signal));
      try {
        await awaitGateBeforeSettlement(
          draining.promise,
          run,
          "Native terminal write drain was not reached",
        );
        expect(source.release).not.toHaveBeenCalled();
        if (abort) {
          controller.abort(new Error("Explicit cancellation"));
          expect(() => readPreparedRunOperatorAuthority(prepared)).toThrow("no longer active");
          expect(getAdmittedRunDelegatedAuthority(admitted!)).toBeUndefined();
        } else {
          expect(readPreparedRunOperatorAuthority(prepared)).toBe(source.authority);
          expect(source.releaseAdmissionHold).not.toHaveBeenCalled();
        }
      } finally {
        terminal.resolve();
        await run;
      }
      expect(source.releaseAdmissionHold).toHaveBeenCalledOnce();
      expect(source.release).toHaveBeenCalledOnce();
    },
  );

  it("releases both native admission and original source if the backend fails", async () => {
    const source = originalSource();
    mocks.runEmbeddedAgent.mockRejectedValueOnce(new Error("Backend failed"));
    await expect(
      createTalkClientAgentRuntime({
        config: {},
        captureOperatorAuthority: source.capture,
      }).runEmbeddedAgent(runParams()),
    ).rejects.toThrow("Backend failed");
    expect(source.releaseAdmissionHold).toHaveBeenCalledOnce();
    expect(source.release).toHaveBeenCalledOnce();
  });
});
