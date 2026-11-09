import { expectDefined } from "@openclaw/normalization-core";
import {
  decodeGatewayOperatorRecoverySnapshot,
  type OperatorRunRecoverySnapshot,
} from "./operator-run-recovery-source.codec.js";
import { restoreGatewayOperatorSource } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

export type GatewayOperatorSourceCustody = Readonly<{
  profileId: string;
  assertCurrent: () => void;
  signal: AbortSignal;
  retain: () => () => void;
  release: () => void;
}>;

/** Requalify native source custody without restoring a run or exposing execution authority. */
export async function prepareGatewayOperatorSourceCustody(params: {
  snapshot: OperatorRunRecoverySnapshot;
  context: GatewayRequestContext;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<GatewayOperatorSourceCustody> {
  const assertCaller = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
  };
  assertCaller();
  const restored = await restoreGatewayOperatorSource({
    snapshot: decodeGatewayOperatorRecoverySnapshot(params.snapshot),
    context: params.context,
    assertCurrent: assertCaller,
  });
  try {
    const nativeSignal = expectDefined(restored.authority.signal, "Restored source signal");
    const signal = params.signal ? AbortSignal.any([nativeSignal, params.signal]) : nativeSignal;
    const assertCurrent = () => {
      if (signal.aborted) {
        throw new Error("Restart recovery operator authority changed; start a new user turn.", {
          cause: signal.reason,
        });
      }
      assertCaller();
      restored.assertPolicyCurrent();
    };
    assertCurrent();
    return Object.freeze({
      profileId: params.snapshot.profileId,
      assertCurrent,
      signal,
      retain: () => {
        assertCurrent();
        return expectDefined(restored.authority.retain, "Restored source retention")();
      },
      release: restored.release,
    });
  } catch (error) {
    restored.release();
    throw error;
  }
}
