import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("sessions/transcript-reports");

export async function settleReportOperation<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let result: Result<T, unknown>;
  try {
    result = ok(await operation());
  } catch (error) {
    result = err(error);
  }
  try {
    await cleanup();
  } catch (error) {
    if (!result.ok) {
      throw createSqliteLifecycleAggregateError(
        [result.error, error],
        "Transcript report and cleanup failed",
        result.error,
      );
    }
    try {
      log.warn(`Transcript report completed before cleanup failed: ${formatErrorMessage(error)}`);
    } catch {
      // Diagnostics cannot replace a committed result with a replayable failure.
    }
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
