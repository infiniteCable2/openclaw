import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  markAuthProfileFailure,
  markAuthProfileSuccess,
  type AuthProfileStore,
} from "../auth-profiles.js";
import { resolveAuthProfileFailureReason } from "../embedded-agent-runner/run/auth-profile-failure-policy.js";
import { isFailoverError } from "../failover-error.js";
import { resolveRetryAfterMs } from "../failover/retry-evidence.js";
import type { RunCliAgentParams } from "./types.js";

const log = createSubsystemLogger("agents/cli-runner");

export async function settleCliAuthProfile(params: {
  store: AuthProfileStore;
  profileId: string;
  provider: string;
  agentDir?: string;
  terminal:
    | { outcome: "success"; modelId?: string }
    | {
        outcome: "failure";
        error: unknown;
        config?: RunCliAgentParams["config"];
        runId: string;
        modelId?: string;
      };
}): Promise<void> {
  try {
    if (params.terminal.outcome === "success") {
      await markAuthProfileSuccess({
        store: params.store,
        profileId: params.profileId,
        provider: params.provider,
        modelId: params.terminal.modelId,
        agentDir: params.agentDir,
      });
      return;
    }
    const error = params.terminal.error;
    const reason = resolveAuthProfileFailureReason({
      failoverReason: isFailoverError(error) ? error.reason : null,
      providerStarted:
        isFailoverError(error) && error.reason === "timeout"
          ? error.cliTimeout?.observedActivity
          : undefined,
    });
    if (reason) {
      await markAuthProfileFailure({
        store: params.store,
        profileId: params.profileId,
        reason,
        cfg: params.terminal.config,
        agentDir: params.agentDir,
        runId: params.terminal.runId,
        modelId: params.terminal.modelId,
        retryAfterMs: resolveRetryAfterMs(formatErrorMessage(error), Date.now(), error),
      });
    }
  } catch (error) {
    log.warn(
      `CLI auth-profile ${params.terminal.outcome} settlement failed: ${formatErrorMessage(error)}`,
    );
  }
}
