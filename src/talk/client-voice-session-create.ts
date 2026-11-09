import { randomUUID } from "node:crypto";
import {
  withClientVoiceSessionSettlement,
  withClientVoiceSessionResources,
} from "./client-voice-session-lifecycle.js";
import type { ClientVoiceSessionSource } from "./client-voice-session-source.js";
import {
  captureClientVoiceSessionWriter,
  mutateAuthorizedClientVoiceSession,
  type ClientVoiceSessionMutationAuthority,
  type ClientVoiceSessionWriter,
} from "./client-voice-session-write.js";

/** Create a call record or resume the same open call across transport restarts. */
export async function createOrResumeClientVoiceSession(
  input: ClientVoiceSessionMutationAuthority & {
    agentId: string;
    sessionKey: string;
    provider?: string;
    origin: "client" | "relay";
    transcriptCapable?: boolean;
    voiceSessionId?: string;
    physicalSource?: ClientVoiceSessionSource;
    now?: number;
  },
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<string> {
  const params = { ...input };
  return withClientVoiceSessionSettlement(
    async () => {
      const voiceSessionId = params.voiceSessionId?.trim() || randomUUID();
      const writer =
        retainedWriter ??
        captureClientVoiceSessionWriter({
          agentId: params.agentId,
          physicalSource: params.physicalSource,
        });
      return withClientVoiceSessionResources(retainedWriter ? [] : [writer], () =>
        mutateAuthorizedClientVoiceSession(
          params,
          writer,
          () => ({
            kind: "create",
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            voiceSessionId,
            provider: params.provider?.trim() || undefined,
            origin: params.origin,
            transcriptCapable: params.transcriptCapable,
            now: params.now ?? Date.now(),
          }),
          () => voiceSessionId,
        ),
      );
    },
    undefined,
    retainedWriter?.settlementContext ?? params.physicalSource?.settlementContext,
  );
}
