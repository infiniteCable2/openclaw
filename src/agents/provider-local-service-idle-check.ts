import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CHECK_TIMEOUT_MS = 2_000;
const MAX_RECHECK_MS = 60_000;

export type LocalServiceIdleStopCheck = {
  command: string;
  args?: string[];
};

/** An optional external owner decides whether idle shutdown is currently wanted. */
export async function checkLocalServiceIdleStop(
  check: LocalServiceIdleStopCheck,
): Promise<{ stop: boolean; recheckMs: number }> {
  const { stdout } = await execFileAsync(check.command, check.args ?? [], {
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: 4_096,
    windowsHide: true,
  });
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("local service idle-stop check returned invalid JSON");
  }
  if (!value || typeof value !== "object") {
    throw new Error("local service idle-stop check returned an invalid decision");
  }
  // SAFETY: the object guard permits property inspection; every consumed field is validated below.
  const decision = value as Record<string, unknown>;
  const validUntilEpoch = decision.validUntilEpoch;
  if (
    typeof decision.stop !== "boolean" ||
    typeof validUntilEpoch !== "number" ||
    !Number.isFinite(validUntilEpoch) ||
    validUntilEpoch * 1_000 <= Date.now()
  ) {
    throw new Error("local service idle-stop check returned an expired decision");
  }
  return {
    stop: decision.stop,
    recheckMs: Math.max(1_000, Math.min(MAX_RECHECK_MS, validUntilEpoch * 1_000 - Date.now())),
  };
}
