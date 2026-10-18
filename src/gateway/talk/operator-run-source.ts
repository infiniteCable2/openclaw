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
    invocation.assertCurrent();
    const { captureGatewayOperatorRunAuthority } = await loadOperatorAuthority();
    invocation.assertCurrent();
    // A create-RPC's mutation guard and request signal expire independently of
    // the call. The native owner retains the authenticated source for this run.
    return captureGatewayOperatorRunAuthority({ client, context, invocationAuthority: invocation });
  };
}
