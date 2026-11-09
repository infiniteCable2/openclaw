import { createHash } from "node:crypto";
import type { ModelProviderLocalServiceConfig } from "../config/types.models.js";

/** Stable process-sharing identity; environment values never appear in the map key. */
export function localServiceKey(
  provider: string,
  service: ModelProviderLocalServiceConfig,
  healthUrl: string,
): string {
  return JSON.stringify({
    provider,
    command: service.command,
    args: service.args ?? [],
    cwd: service.cwd ?? "",
    envHash: hashStringRecord(service.env),
    healthUrl,
    idleStopCheck: service.idleStopCheck,
  });
}

function hashStringRecord(record: Record<string, string> | undefined): string {
  const sorted = Object.entries(record ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
