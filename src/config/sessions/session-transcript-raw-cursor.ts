export const RAW_TRANSCRIPT_CURSOR_VERSION = 1;

export type RawTranscriptCursor = {
  agentId: string;
  generation: string;
  lastSeq: number;
  sessionId: string;
  version: typeof RAW_TRANSCRIPT_CURSOR_VERSION;
};

export function encodeRawTranscriptCursor(cursor: RawTranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Mint the raw-delta cursor for a generation-consistent transcript snapshot. */
export function createTranscriptRawDeltaCursor(params: {
  agentId: string;
  generation: string;
  lastSeq: number;
  sessionId: string;
}): string {
  return encodeRawTranscriptCursor({ ...params, version: RAW_TRANSCRIPT_CURSOR_VERSION });
}

export function parseRawTranscriptCursor(value: string): RawTranscriptCursor | undefined {
  if (value.length > 4_096) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<RawTranscriptCursor>; // SAFETY: Checks and catch reject invalid cursor shapes.
    if (
      parsed.version !== RAW_TRANSCRIPT_CURSOR_VERSION ||
      typeof parsed.agentId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.generation !== "string" ||
      !Number.isSafeInteger(parsed.lastSeq) ||
      (parsed.lastSeq ?? -2) < -1
    ) {
      return undefined;
    }
    // SAFETY: All required fields and the sequence range passed validation above.
    return parsed as RawTranscriptCursor;
  } catch {
    return undefined;
  }
}
