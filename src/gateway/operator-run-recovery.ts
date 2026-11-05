import { isDeepStrictEqual } from "node:util";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { restoreOperatorModelPolicySnapshot } from "../agents/operator-model-policy.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import {
  captureChannelOperatorRunAuthority,
  intersectOperatorRunModelPolicy,
} from "./operator-run-authority.js";
import { decodeGatewayOperatorRecoverySource } from "./operator-run-recovery-source.js";
import {
  prepareGatewayOperatorSourceCustody,
  type GatewayOperatorSourceCustody,
} from "./operator-source-custody.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

export type OperatorRecoveryTarget = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId: string;
  sourceRunId: string;
  recoveryRunId: string;
};

type RecoverySource = Readonly<{ controlUiAdmin: boolean; localOperator: boolean }>;
const recoverySources = new WeakMap<
  AdmittedRunOperatorAuthority,
  {
    target: OperatorRecoveryTarget;
    source: RecoverySource;
  }
>();

/** Only an exact live restore can carry the original operator admission classification. */
export function readGatewayOperatorRecoverySource(
  authority: AdmittedRunOperatorAuthority | undefined,
  target: { runId: string; sessionKey: string; sessionId: string },
): RecoverySource | undefined {
  const restored = authority && recoverySources.get(authority);
  if (
    !authority ||
    !restored ||
    restored.target.recoveryRunId !== target.runId ||
    restored.target.sessionKey !== target.sessionKey ||
    restored.target.sessionId !== target.sessionId
  ) {
    return undefined;
  }
  authority.assertCurrent();
  return restored.source;
}

/** Re-admit the exact durable source under current policy; never revive an old run capability. */
export async function restoreGatewayOperatorRecovery(params: {
  target: OperatorRecoveryTarget;
  context: GatewayRequestContext;
  assertCurrent: () => void;
}): Promise<
  | { authority: AdmittedRunOperatorAuthority; controlUiAdmin: boolean; release: () => void }
  | undefined
> {
  const target = { ...params.target };
  const { context, assertCurrent } = params;
  const getConfig = context.getCommittedRuntimeConfig ?? context.getRuntimeConfig;
  let references = 1;
  const signal = new AbortController();
  const revoke = (cause?: unknown) =>
    signal.abort(
      new Error("Restart recovery operator authority changed; start a new user turn.", { cause }),
    );
  const assertOwner = () => {
    if (references === 0) {
      throw new Error("Restart recovery operator authority is no longer active.");
    }
    signal.signal.throwIfAborted();
    assertCurrent();
  };
  const subscriptions: Array<() => void> = [
    onSessionIdentityMutation((mutation) => {
      if (
        mutation.agentId === target.agentId &&
        (mutation.previous.sessionId === target.sessionId ||
          mutation.previous.sessionKeys.includes(target.sessionKey))
      ) {
        revoke();
      }
    }),
  ];
  let custody: GatewayOperatorSourceCustody | undefined;
  const releaseHold = () => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (--references === 0) {
        subscriptions.splice(0).forEach((release) => release());
        custody?.release();
      }
    };
  };
  const release = releaseHold();
  try {
    const read = () => readSessionEntryReadOnlyInWorker(target, assertOwner);
    const entry = await read();
    if (!entry?.restartRecoveryOperatorSource) {
      release();
      return undefined;
    }
    const source = decodeGatewayOperatorRecoverySource(entry.restartRecoveryOperatorSource);
    const assertClaim = (current: InternalSessionEntry | undefined) => {
      const reservation = current?.mainRestartRecovery?.reservation;
      if (
        !current ||
        current.sessionId !== target.sessionId ||
        current.lifecycleRevision !== source.lifecycleRevision ||
        current.restartRecoveryDeliveryRunId !== target.recoveryRunId ||
        current.restartRecoveryDeliverySourceRunId !== target.sourceRunId ||
        (reservation &&
          (reservation.runId !== target.recoveryRunId ||
            reservation.lifecycleGeneration !== getAgentEventLifecycleGeneration())) ||
        source.agentId !== target.agentId ||
        source.sessionKey !== target.sessionKey ||
        source.sessionId !== target.sessionId ||
        source.sourceRunId !== target.sourceRunId ||
        !isDeepStrictEqual(current.restartRecoveryOperatorSource, source)
      ) {
        throw new Error("Restart recovery operator source no longer owns this input.");
      }
    };
    assertClaim(entry);
    const snapshot = source.snapshot;
    const prepared = await prepareGatewayOperatorSourceCustody({
      snapshot,
      context,
      assertCurrent: assertOwner,
      signal: signal.signal,
    });
    custody = prepared;
    const assertPolicy = () => {
      assertOwner();
      prepared.assertCurrent();
    };
    assertClaim(await read());
    assertPolicy();
    const live = captureChannelOperatorRunAuthority({
      profileId: snapshot.profileId,
      assignedRole: snapshot.assignedRole,
      githubLogin: snapshot.githubLogin,
      scopes: snapshot.scopes,
      gatewayAccessGrant: snapshot.grant,
      getRuntimeConfig: getConfig,
      assertCurrent: assertPolicy,
      signal: prepared.signal,
    });
    const originalModels = snapshot.modelPolicy
      ? restoreOperatorModelPolicySnapshot(snapshot.modelPolicy)
      : undefined;
    const authority = createAdmittedRunOperatorAuthority({
      ...live,
      signal: prepared.signal,
      recoverySnapshot: snapshot,
      retain: () => {
        assertPolicy();
        references += 1;
        return releaseHold();
      },
      get modelPolicy() {
        return intersectOperatorRunModelPolicy(originalModels, live.modelPolicy);
      },
    });
    authority.assertCurrent();
    recoverySources.set(authority, {
      target,
      source: Object.freeze({
        controlUiAdmin: snapshot.controlUiAdmin,
        localOperator: snapshot.localOperator,
      }),
    });
    return { authority, controlUiAdmin: snapshot.controlUiAdmin, release };
  } catch (error) {
    release();
    throw error;
  }
}
