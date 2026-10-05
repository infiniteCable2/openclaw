import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("tts");

/** Best-effort, content-free timing for buffered voice-note delivery. */
export function reportVoiceNoteTtsPhase(
  operationId: string | undefined,
  phase: string,
  startedAt: number,
  requestId?: string,
  attempt?: number,
): void {
  if (!operationId) {
    return;
  }
  try {
    log.info(
      `voice_note_tts operation_id=${operationId}${requestId ? ` request_id=${requestId}` : ""}${attempt ? ` attempt=${attempt}` : ""} phase=${phase} elapsed_ms=${Math.max(0, Math.round(performance.now() - startedAt))}`,
    );
  } catch {
    // Observability must not change speech delivery.
  }
}
