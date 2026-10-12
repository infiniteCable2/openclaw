import type { ProviderLocalServiceLease } from "../agents/provider-local-service-target.js";
import type { PreparedTtsPreferences } from "./tts-preferences.js";

/** Host-only readiness for one native source; never a payload or persisted delivery fact. */
export type MessageSpeechAdmission = {
  runId: string;
  sessionId: string;
  agentId: string;
  route: { channel: string; to: string; accountId?: string; threadId?: string | number };
  assertCurrent(): void;
  preparedTtsPreferences: PreparedTtsPreferences;
  prefsPath: string;
  sessionAuto?: string;
  localServiceAdmission?: NonNullable<ProviderLocalServiceLease["admission"]>;
  expectedSpeechSelection: { provider: string; model?: string; voice?: string };
  /** Attempt-owned presentation context; never inherited by a detached review. */
  guidance?: string;
};
