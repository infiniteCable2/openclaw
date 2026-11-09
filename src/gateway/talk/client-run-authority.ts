import { getRpcSourceForGateway } from "../../sessions/session-controller.rpc-sources.js";
import {
  acceptGatewayDeviceSourceAuthority,
  bindGatewayDeviceRevocation,
  readGatewayDeviceSourceAuthority,
  retainGatewayDeviceRevocation,
} from "../device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { retainGatewayOperatorRun } from "../operator-run-cancellation.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { authorizePreparedSessionMutation } from "../session-sharing-policy.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import {
  prepareProjectedSessionSharing,
  prepareSessionSharingProfiles,
} from "../session-sharing-read.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

/** Retain the authenticated source at ingress; audio replacement is not revocation. */
export async function retainTalkClientRunAuthority(
  params: Pick<GatewayRequestHandlerOptions, "client" | "context" | "hasCurrentClientAuthority"> & {
    session?: { target: PreparedTalkSessionTarget; sessionId: string };
  },
) {
  const session = params.session && { ...params.session };
  const captured = await captureGatewayOperatorRunAuthority({
    ...params,
    client: params.client ?? null,
  });
  const client =
    params.client && captured
      ? {
          ...params.client,
          internal: { ...params.client.internal, operatorRunAuthority: captured.authority },
        }
      : params.client;
  let releaseDevice: ReturnType<typeof retainGatewayDeviceRevocation>;
  let facts: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
  let profiles: Awaited<ReturnType<typeof prepareSessionSharingProfiles>> | undefined;
  const assertSessionCurrent = () => {
    if (!session || !facts) {
      return;
    }
    const cfg = params.context.getRuntimeConfig();
    session.target.assertCurrent(cfg);
    const currentFacts = facts.readCurrent(cfg);
    const current = currentFacts.target;
    if (
      current?.agentId !== session.target.agentId ||
      current.canonicalKey !== session.target.canonicalKey ||
      current.storePath !== session.target.storePath ||
      current.entry.sessionId !== session.sessionId
    ) {
      throw new Error("Talk conversation changed before continuing the call");
    }
    const policyConfig = params.context.getCommittedRuntimeConfig?.() ?? cfg;
    const sharing = prepareProjectedSessionSharing({
      cfg: policyConfig,
      client: client ?? null,
      profiles,
      isMember: (_target, identityId) => currentFacts.membership.has(identityId),
    });
    const error = authorizePreparedSessionMutation(
      { cfg: policyConfig, client: client ?? null, sessionKey: current.canonicalKey },
      currentFacts,
      { policy: sharing.policy, aliases: profiles?.readCurrent().profile?.aliases ?? new Set() },
    );
    if (error) {
      throw new SessionMutationAuthorizationChangedError(error);
    }
  };
  try {
    releaseDevice = retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
    if (session) {
      profiles = await prepareSessionSharingProfiles(client ?? null);
      facts = await prepareSessionMutationFacts({
        cfg: params.context.getRuntimeConfig(),
        agentId: session.target.agentId,
        sessionKey: session.target.canonicalKey,
        preserveQualifiedAddress: true,
        sessionAccessOnly: true,
      });
      assertSessionCurrent();
    }
  } catch (error) {
    facts?.release();
    releaseDevice?.();
    captured?.release();
    throw error;
  }
  const sourceCurrent =
    readGatewayDeviceSourceAuthority(params.hasCurrentClientAuthority) ??
    params.hasCurrentClientAuthority;
  const committedSource =
    sourceCurrent && bindGatewayDeviceRevocation(sourceCurrent, params.hasCurrentClientAuthority);
  let released = false;
  return {
    operatorAuthority: captured?.authority,
    assertCurrent() {
      if (released || sourceCurrent?.() === false) {
        throw new Error("Talk caller source authority is no longer active");
      }
      captured?.authority.assertCurrent();
      assertSessionCurrent();
    },
    accept() {
      // Retention during provider setup is not acceptance. The logical voice
      // owner calls this only after its final request/target commit checks.
      if (released || params.hasCurrentClientAuthority?.() === false) {
        throw new Error("Talk caller source is no longer current for admission");
      }
      captured?.authority.assertCurrent();
      assertSessionCurrent();
      acceptGatewayDeviceSourceAuthority(params.hasCurrentClientAuthority);
    },
    async retainRun(runId: string) {
      if (released) {
        throw new Error("Talk caller source has closed");
      }
      const retained = await retainGatewayOperatorRun({
        client: client ?? null,
        context: params.context,
        hasCurrentClientAuthority: committedSource,
        runId,
        entry: getRpcSourceForGateway(runId, params.context.resolveGatewayContext),
      });
      const assertSourceCurrent = () => {
        retained.authority?.assertCurrent();
        if (sourceCurrent?.() === false) {
          throw new Error("Talk caller source authority is no longer active");
        }
      };
      try {
        assertSourceCurrent();
        retained.armCancellation();
        return { ...retained, assertSourceCurrent };
      } catch (error) {
        retained.release();
        throw error;
      }
    },
    release() {
      if (!released) {
        released = true;
        captured?.release();
        releaseDevice?.();
        facts?.release();
      }
    },
  };
}

export type TalkClientRunAuthority = Awaited<ReturnType<typeof retainTalkClientRunAuthority>>;
