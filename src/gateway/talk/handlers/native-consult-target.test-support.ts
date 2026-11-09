import { onTestFinished, vi } from "vitest";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  createEmbeddedRunHandle,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../../../agents/embedded-agent-runner/runs.test-support.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createReplyOperation } from "../../../sessions/session-controller.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { controlRealtimeVoiceAgentRun } from "../../../talk/agent-run-control.js";
import { registerChatAbortController } from "../../chat-abort.js";
import { claimRpcSourceForTest } from "../../test-helpers.rpc-source.js";
import { prepareTalkSessionTarget } from "../session-target.js";

export function controlNativeConsultRun(
  target: Parameters<typeof controlRealtimeVoiceAgentRun>[0]["runTarget"],
  text = "cancel",
  options: Partial<Parameters<typeof controlRealtimeVoiceAgentRun>[0]> = {},
) {
  return controlRealtimeVoiceAgentRun({
    sessionKey: "global",
    runTarget: target,
    text,
    ...options,
  });
}

/** A separate native owner proves that scoped control cannot cancel a foreign run. */
export function registerUnrelatedNativeConsultRun(
  storePath: string,
  sessionId: string,
  runId: string,
) {
  const operation = createReplyOperation({
    sessionKey: "global",
    agentId: "voice",
    resetTriggered: false,
    sessionId,
    target: captureSessionTarget({
      storeScope: `${storePath}.unrelated`,
      sessionKey: "global",
      agentId: "voice",
      incarnation: sessionId,
    }),
  });
  const abort = vi.fn();
  const handle = createEmbeddedRunHandle({ runId, abort });
  setActiveEmbeddedRun(sessionId, handle, "global", undefined, "voice", operation);
  return {
    operation,
    abort,
    dispose() {
      clearActiveEmbeddedRun(sessionId, handle, "global");
      operation.complete();
    },
  };
}

/** Pause at the real control-preparation boundary while the scenario changes custody. */
export function pauseNativeConsultControl(
  target: Parameters<typeof controlNativeConsultRun>[0],
  cancelRun?: NonNullable<Parameters<typeof controlNativeConsultRun>[2]>["cancelRun"],
) {
  const preparing = createDeferredCore();
  const prepared = createDeferredCore();
  const pending = controlNativeConsultRun(target, "cancel", {
    mode: "cancel",
    cancelRun,
    getToolAuthorityOverlay: () => ({
      senderIsOwner: false,
      disableTools: false,
      traceAuthorized: false,
    }),
    prepareToolAuthorityOverlay: async () => {
      preparing.resolve();
      await prepared.promise;
    },
  });
  return { preparing, prepared, pending };
}

/** Retains admitted source custody for exact late-control and adoption race fixtures. */
export async function registerOwnedNativeConsultRun(
  config: OpenClawConfig,
  ownerConnId: string,
  runId: string,
  sessionId: string,
  options: { executionStarted?: boolean } = {},
) {
  const target = await prepareTalkSessionTarget(config, "main");
  const registration = registerChatAbortController({
    runId,
    sessionId,
    target: captureSessionTarget({
      storeScope: target.storePath,
      sessionKey: "global",
      agentId: "voice",
      incarnation: sessionId,
    }),
    sessionKey: "global",
    agentId: "voice",
    ownerConnId,
    timeoutMs: 60_000,
    kind: "chat-send",
  });
  if (!registration.registered) {
    throw new Error("Missing owned Talk source");
  }
  const releaseClaim = await claimRpcSourceForTest(registration.entry, options);
  onTestFinished(() => {
    releaseClaim();
    registration.cleanup();
  });
  const abort = vi.fn();
  if (options.executionStarted !== false) {
    setActiveEmbeddedRun(
      sessionId,
      createEmbeddedRunHandle({ runId, abort }),
      "global",
      undefined,
      "voice",
      registration.entry.input.claim!.operation!,
    );
  }
  return { registration, abort };
}
