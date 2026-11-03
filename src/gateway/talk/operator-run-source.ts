import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { GatewayClient, GatewayRequestContext } from "../server-methods/shared-types.js";
import type { TalkOperatorRunSource } from "./client-agent-runtime.js";

const loadOperatorAuthority = createLazyRuntimeModule(() => import("../operator-run-authority.js"));

/** Keep the original principal, but acquire each model run's native authority lazily. */
export function createTalkOperatorRunSource(params: {
  client: GatewayClient | null;
  context: Pick<
    GatewayRequestContext,
    "getRuntimeConfig" | "getCommittedRuntimeConfig" | "resolveGatewayContext"
  >;
}): TalkOperatorRunSource {
  const { client, context } = params;
  return async (invocation) => {
    const assertPreparing = () => {
      invocation.signal?.throwIfAborted();
      invocation.assertCurrent();
    };
    assertPreparing();
    const { captureGatewayOperatorRunAuthority } = await loadOperatorAuthority();
    assertPreparing();
    // A create-RPC's mutation guard and request signal expire independently of
    // the call. Input/target guards remain with their owning Talk operation;
    // retained background audiences need only the native person/policy custody.
    const source = await captureGatewayOperatorRunAuthority({ client, context });
    try {
      assertPreparing();
      return source;
    } catch (error) {
      try {
        source?.release();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Talk operator capture cleanup failed", {
          cause: error,
        });
      }
      throw error;
    }
  };
}
