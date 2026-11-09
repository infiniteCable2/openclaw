import type { OpenClawConfig } from "../config/types.openclaw.js";
import { lookupClientVoiceSessions } from "./client-voice-session-read.js";
import {
  captureClientVoiceSessionSource,
  type ClientVoiceSessionSource,
} from "./client-voice-session-source.js";
import { VOICE_SESSION_STALE_AFTER_MS as STALE_AFTER_MS } from "./client-voice-session-store.js";

/** Close abandoned open calls idle for the fixed six-hour recovery window. */
export async function recoverStaleClientVoiceSessions(
  params: {
    agentId: string;
    config: OpenClawConfig;
    excludeVoiceSessionId?: string;
    now?: number;
    warn?: (message: string) => void;
  },
  owner: {
    retryAgent: (
      agentId: string,
      context: { config: OpenClawConfig; source: ClientVoiceSessionSource },
    ) => void;
    close: (params: {
      agentId: string;
      physicalSource: ClientVoiceSessionSource;
      sessionKey: string;
      voiceSessionId: string;
      config: OpenClawConfig;
      now: number;
      staleBefore: number;
      transcriptFailurePolicy: "require-success";
    }) => Promise<boolean>;
  },
): Promise<number> {
  const now = params.now ?? Date.now();
  // A new voice session remains a retry point, but channel I/O is detached so a
  // stalled adapter cannot block stale-session recovery.
  const physicalSource = captureClientVoiceSessionSource(params.agentId);
  owner.retryAgent(params.agentId, {
    config: params.config,
    source: physicalSource,
  });
  const stale = await lookupClientVoiceSessions(
    {
      kind: "stale",
      agentId: params.agentId,
      updatedBefore: now - STALE_AFTER_MS,
      excludeVoiceSessionId: params.excludeVoiceSessionId,
    },
    physicalSource.options,
  );
  let closed = 0;
  for (const record of stale) {
    try {
      const didClose = await owner.close({
        agentId: params.agentId,
        physicalSource,
        sessionKey: record.sessionKey,
        voiceSessionId: record.voiceSessionId,
        config: params.config,
        now,
        staleBefore: now - STALE_AFTER_MS,
        transcriptFailurePolicy: "require-success",
      });
      if (didClose) {
        closed += 1;
      }
    } catch (error) {
      params.warn?.(
        `failed to close stale voice session ${record.voiceSessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return closed;
}
