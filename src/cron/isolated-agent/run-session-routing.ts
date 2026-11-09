import type { OpenClawConfig } from "../../config/types.js";
import { isCronSessionKey } from "../../routing/session-key.js";
import { isDetachedCronSessionTarget } from "../session-target.js";
import type { RunCronAgentTurnParams } from "./run-prepare-runtime.js";
import { resolveHookExternalContentSource } from "./run.runtime.js";
import { resolveCronAgentSessionKey } from "./session-key.js";

/** Resolve the scheduled run's identity separately from its retained source conversation. */
export function resolveCronSessionRouting(params: {
  input: Pick<RunCronAgentTurnParams, "sessionKey" | "job">;
  runtimeCfg: OpenClawConfig;
  agentId: string;
}) {
  const { input, runtimeCfg, agentId } = params;
  const baseSessionKey = (input.sessionKey?.trim() || `cron:${input.job.id}`).trim();
  // A `current` job is a child run of its creating conversation: it keeps its own
  // `cron:<jobId>` run key, and the conversation's resources come from the admission.
  const currentBoundSourceKey =
    input.job.sessionTarget === "current" ? input.job.sessionKey?.trim() : undefined;
  const usesDetachedRunSession =
    isDetachedCronSessionTarget(input.job.sessionTarget) || Boolean(currentBoundSourceKey);
  const baseSessionKeyIsCron =
    baseSessionKey.startsWith("cron:") || isCronSessionKey(baseSessionKey);
  const cronExecutionSessionKey =
    usesDetachedRunSession && !baseSessionKeyIsCron ? `cron:${input.job.id}` : baseSessionKey;
  const agentSessionKey = resolveCronAgentSessionKey({
    sessionKey: cronExecutionSessionKey,
    agentId,
    mainKey: runtimeCfg.session?.mainKey,
    cfg: runtimeCfg,
  });
  const resolvedBaseSessionKey = resolveCronAgentSessionKey({
    sessionKey: currentBoundSourceKey ?? baseSessionKey,
    agentId,
    mainKey: runtimeCfg.session?.mainKey,
    cfg: runtimeCfg,
  });
  const sourceSessionKey =
    currentBoundSourceKey && resolvedBaseSessionKey !== agentSessionKey
      ? resolvedBaseSessionKey
      : undefined;
  const payloadHookExternalContentSource =
    input.job.payload.kind === "agentTurn" ? input.job.payload.externalContentSource : undefined;
  const hookExternalContentSource =
    payloadHookExternalContentSource ?? resolveHookExternalContentSource(baseSessionKey);

  const isGmailHook = hookExternalContentSource === "gmail";
  return {
    baseSessionKey,
    usesDetachedRunSession,
    agentSessionKey,
    sourceSessionKey,
    hookExternalContentSource,
    isGmailHook,
  };
}
