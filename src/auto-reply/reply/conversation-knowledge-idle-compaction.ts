import { isDeepStrictEqual } from "node:util";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { withCompleteCompactionSummary } from "../../agents/compaction-summary-coverage.js";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "../../agents/embedded-agent-runner/compact.types.js";
import {
  capturePreparedConversationContextBudget,
  type PreparedConversationContextBudget,
} from "../../agents/embedded-agent-runner/run/prepared-conversation-context.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { CustomMessage } from "../../agents/sessions/messages.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
  type PreparedSessionSourceAuthority,
} from "../../config/sessions/session-source-authority.js";
import type { SessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";

const log = createSubsystemLogger("conversation-knowledge");

/** One failed/no-op reduction cannot repeatedly summarize an unchanged blocked packet. */
export type IdleConversationKnowledgeCompactionState = {
  blocked?: { version: SessionTranscriptContextVersion; consumptionRevision: number };
};

type NativeMaintenanceParams = {
  target: SessionTranscriptTargetBinding & { expectedLifecycleRevision?: string };
  version: SessionTranscriptContextVersion;
  source: CapturedSessionEntryReadSource;
  assertCurrent: SessionSourceAssertion;
  signal: AbortSignal;
  request: CompactEmbeddedAgentSessionRuntimeParams;
};

/** One native writer/cleanup boundary for warm and cold idle maintenance requests. */
export async function runIdleConversationKnowledgeNativeMaintenance(
  params: NativeMaintenanceParams,
) {
  const check = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  const source = composeSessionSourceAssertion([
    params.assertCurrent,
    Object.assign(check, {
      prepareSessionSource: async (): Promise<PreparedSessionSourceAuthority> => ({
        assertCurrent: check,
        checks: [
          {
            predicate: {
              source: params.source,
              sessionKey: params.target.sessionKey,
              fields: ["sessionId"],
              expected: { sessionId: params.target.sessionId },
              transcript: { sessionId: params.target.sessionId, version: params.version },
            },
            refuse: (): never => {
              throw new Error("Idle maintenance context changed before commit");
            },
          },
        ],
      }),
    }),
  ]);
  check();
  const { compactEmbeddedAgentSessionDirect } =
    await import("../../agents/embedded-agent-runner/compact.js");
  check();
  const work = new AsyncWorkScope();
  try {
    const result = await work.track(() =>
      withSessionTranscriptWriteAssertion(params.target, source, () =>
        withCompleteCompactionSummary(() =>
          compactEmbeddedAgentSessionDirect({
            ...params.request,
            sessionTarget: params.target,
            sessionId: params.target.sessionId,
            sessionKey: params.target.sessionKey,
            agentId: params.target.agentId,
            sessionFile: params.target.sessionKey,
            abortSignal: params.signal,
            disableTools: true,
            modelFallbacksOverride: [],
            trigger: "budget",
          }),
        ),
      ),
    );
    check();
    return result;
  } finally {
    // Logical completion never releases the native writer ahead of actual cleanup.
    await AsyncWorkScope.runWhenAllIdle(
      () => [work],
      () => work.drain(),
    );
  }
}

/** Called only inside the admitted idle lane, after the real native footprint refused a packet. */
export async function compactConversationKnowledgeWhileIdle(params: {
  budget?: PreparedConversationContextBudget;
  request?: CompactEmbeddedAgentSessionRuntimeParams;
  config: OpenClawConfig;
  target: SessionTranscriptTargetBinding & { expectedLifecycleRevision?: string };
  version: SessionTranscriptContextVersion;
  source: CapturedSessionEntryReadSource;
  consumptionRevision: number;
  packet: CustomMessage;
  state: IdleConversationKnowledgeCompactionState;
  assertCurrent: SessionSourceAssertion;
  signal: AbortSignal;
  readContext(): Promise<{
    messages: AgentMessage[];
    version?: SessionTranscriptContextVersion;
  }>;
  onReady?(
    value: PreparedConversationContextBudget,
    version: SessionTranscriptContextVersion,
  ): Promise<boolean>;
  onNativeDecision?(fits: boolean): void;
}): Promise<boolean> {
  const { budget, target, packet, state } = params;
  const placement = budget?.compactionPlacement;
  const request =
    params.request ??
    (placement
      ? {
          ...placement,
          config: params.config,
          sessionTarget: target,
          sessionId: placement.target.sessionId,
          sessionKey: placement.target.sessionKey,
          agentId: placement.target.agentId,
          sessionFile: placement.target.sessionKey,
          contextTokenBudget: budget?.contextWindow,
        }
      : undefined);
  const packetId = asOptionalRecord(packet.details)?.packetId;
  const diagnostic = (reason: string) => {
    if (log.isEnabled("debug")) {
      log.debug("Conversation knowledge idle maintenance deferred", {
        reason,
        recipientHash: redactIdentifier(target.sessionId),
        ...(typeof packetId === "string" ? { packetHash: redactIdentifier(packetId) } : {}),
        contextRawSeq: params.version.rawSeq,
        consumptionRevision: params.consumptionRevision,
      });
    }
  };
  if (!request) {
    diagnostic("missing-placement");
    return false;
  }
  if (params.config.cloudWorkers?.requiredProfile !== undefined) {
    diagnostic("cloud-worker-required");
    return false;
  }
  if (typeof packetId !== "string" || !packetId) {
    diagnostic("missing-packet-id");
    return false;
  }
  if (
    request.agentId !== target.agentId ||
    request.sessionId !== target.sessionId ||
    request.sessionKey !== target.sessionKey ||
    request.sessionTarget?.storePath !== target.storePath
  ) {
    diagnostic("placement-mismatch");
    return false;
  }
  if (budget && !budget.capacityForMessages([])(packet)) {
    diagnostic("packet-exceeds-empty-budget");
    return false;
  }
  if (
    state.blocked?.consumptionRevision === params.consumptionRevision &&
    isDeepStrictEqual(state.blocked.version, params.version)
  ) {
    diagnostic("unchanged-blocked-context");
    return false;
  }
  const check = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  check();
  const fresh = await params.readContext();
  check();
  if (!fresh.version || !isDeepStrictEqual(fresh.version, params.version)) {
    diagnostic(fresh.version ? "initial-context-changed" : "initial-context-unavailable");
    // Another native commit owns this window. Re-evaluate in the next quantum.
    return fresh.version !== undefined;
  }
  const { readSessionTranscriptReportReceipts } =
    await import("../../config/sessions/session-accessor.sqlite-transcript-reports.js");
  const observed = await readSessionTranscriptReportReceipts(
    target,
    [{ customType: packet.customType, receipt: { field: "packetId", value: packetId } }],
    { source: params.assertCurrent },
  );
  check();
  if (!observed.ok) {
    diagnostic("receipt-read-unavailable");
    return false;
  }
  if (observed.value[0]?.status !== "missing") {
    diagnostic("receipt-not-missing");
    return false;
  }
  if (budget && budget.capacityForMessages(fresh.messages)(packet)) {
    diagnostic("packet-already-fits");
    return false;
  }
  state.blocked = {
    version: { ...fresh.version },
    consumptionRevision: params.consumptionRevision,
  };
  const probe = async (version: SessionTranscriptContextVersion) => {
    let fits: boolean | undefined;
    let preparedBudget: PreparedConversationContextBudget | undefined;
    const result = await runIdleConversationKnowledgeNativeMaintenance({
      ...params,
      version,
      request: {
        ...request,
        budgetPreflight: {
          prompt: "",
          pendingMessages: [packet],
          checkOnly: true,
          captureCapacity: true,
          onDecision: (allowed, capacity) => {
            check();
            fits = allowed;
            params.onNativeDecision?.(allowed);
            preparedBudget = capacity
              ? capturePreparedConversationContextBudget(capacity)
              : undefined;
          },
        },
      },
    });
    check();
    return { ok: result.ok, fits, budget: preparedBudget };
  };
  try {
    let pressure = await probe(fresh.version);
    if (
      !pressure.ok ||
      !pressure.budget ||
      pressure.fits === undefined ||
      !pressure.budget.capacityForMessages([])(packet)
    ) {
      diagnostic(
        !pressure.ok
          ? "initial-probe-failed"
          : !pressure.budget
            ? "initial-probe-budget-unavailable"
            : pressure.fits === undefined
              ? "initial-probe-decision-unavailable"
              : "packet-exceeds-native-empty-budget",
      );
      return false;
    }
    let compacted = false;
    let version = fresh.version;
    // Native replay can fit after trimming while the durable recipient window is
    // still full. Compare the same window that the subsequent append will charge.
    const needsReduction =
      !pressure.fits || !(budget ?? pressure.budget).capacityForMessages(fresh.messages)(packet);
    if (needsReduction) {
      if (params.config.agents?.defaults?.compaction?.enabled === false) {
        diagnostic("compaction-disabled");
        return false;
      }
      const result = await runIdleConversationKnowledgeNativeMaintenance({
        ...params,
        request: {
          ...request,
          ...(pressure.fits
            ? {
                forcePreflight: true,
                preflightRequired: true,
                preflightCompactionTrigger: "tokens" as const,
              }
            : { budgetPreflight: { prompt: "", pendingMessages: [packet] } }),
        },
      });
      if (!result.ok || !result.compacted) {
        diagnostic(result.ok ? "native-compaction-noop" : "native-compaction-failed");
        return false;
      }
      compacted = true;
      log.info("Conversation knowledge idle maintenance", {
        outcome: "compacted",
        recipientHash: redactIdentifier(target.sessionId),
      });
      const current = await params.readContext();
      check();
      if (!current.version) {
        diagnostic("compacted-context-unavailable");
        return true;
      }
      version = current.version;
      state.blocked = { version: { ...version }, consumptionRevision: params.consumptionRevision };
      pressure = await probe(version);
    }
    // Native refusal wins even if the conservative reusable estimate would allow it.
    if (!pressure.ok || pressure.fits !== true || !pressure.budget) {
      diagnostic(
        !pressure.ok
          ? "final-probe-failed"
          : pressure.fits !== true
            ? "final-probe-refused"
            : "final-probe-budget-unavailable",
      );
      return compacted;
    }
    const current = await params.readContext();
    check();
    if (!current.version || !isDeepStrictEqual(current.version, version)) {
      diagnostic(current.version ? "final-context-changed" : "final-context-unavailable");
      return true;
    }
    if (budget && !budget.capacityForMessages(current.messages)(packet)) {
      diagnostic("foreground-budget-refused");
      return compacted;
    }
    const admitted = await params.onReady?.(pressure.budget, version);
    if (admitted !== true) {
      diagnostic(params.onReady ? "ready-without-admission" : "ready-handler-unavailable");
    }
    return compacted || admitted === true;
  } catch (error) {
    if (params.signal.aborted) {
      // Foreground preemption is not a failed reduction of this packet.
      state.blocked = undefined;
    }
    throw error;
  }
}
