import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  PrepareVoiceTranscriptAudience,
  PreparedVoiceTranscriptAudience,
} from "./voice-transcript-audience.types.js";

const log = createSubsystemLogger("talk/client-voice-session");

/** Normalize optional qualification without delaying native queue admission or losing accepted text. */
export function prepareVoiceTranscriptAudience(
  prepare: PrepareVoiceTranscriptAudience | undefined,
): Promise<PreparedVoiceTranscriptAudience | undefined> | undefined {
  if (!prepare) {
    return undefined;
  }
  const unavailable = (error: unknown) => {
    // Accepted speech persists without inventing any fallback personal grant.
    log.warn("Voice transcript retained without a private recipient receipt.", {
      error: formatErrorMessage(error),
    });
    return undefined;
  };
  try {
    return prepare().catch(unavailable);
  } catch (error) {
    unavailable(error);
    return undefined;
  }
}
