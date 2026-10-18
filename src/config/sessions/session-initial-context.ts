import type { TranscriptEvent } from "./session-accessor.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { SessionEntry } from "./types.js";

/** Native-prepared snapshot data; the caller must separately retain live read authority. */
export type PreparedInitialSessionContext = {
  source: CapturedSessionEntryReadSource & { databaseIdentity: string };
  sourceSessionKey: string;
  sourceEntry: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  /** Stability watermark of the captured source, not the endpoint of copied knowledge. */
  sourceVersion: SessionTranscriptContextVersion;
  /** Exact completed endpoint; pending source suffixes are not inherited or acknowledged. */
  sourceThrough?: TranscriptEntryAnchor;
  targetSessionId: string;
  events: readonly TranscriptEvent[];
};

/** Copied bytes must name the same donor covered by the retained native read predicates. */
export function assertInitialSessionContextReadSource(
  context: PreparedInitialSessionContext,
  sources: readonly SessionSourcePredicate[] | undefined,
): void {
  const key = normalizeStoreSessionKey(context.sourceSessionKey);
  const matching = sources?.some(
    (source) =>
      key &&
      normalizeStoreSessionKey(source.sessionKey) === key &&
      source.source.agentId === context.source.agentId &&
      source.source.path === context.source.path &&
      source.source.databaseIdentity === context.source.databaseIdentity &&
      source.source.databaseBirthtime === context.source.databaseBirthtime &&
      source.expected?.sessionId === context.sourceEntry.sessionId &&
      source.expected?.lifecycleRevision === context.sourceEntry.lifecycleRevision &&
      source.fields.includes("sessionId") &&
      source.fields.includes("lifecycleRevision") &&
      source.fields.includes("createdActor") &&
      source.fields.includes("visibility") &&
      source.fields.includes("incognito"),
  );
  if (!matching) {
    throw new Error(
      "Initial conversation context requires matching prepared donor read authority.",
    );
  }
}
