import type { retainPreparedSessionSharingFacts } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { SessionMutationFactsUnavailableError } from "./session-sharing-incognito.js";

type InvalidationReason =
  | "store-registry"
  | "store-topology"
  | "broad-publication"
  | "actor-source"
  | "creation-source"
  | "row-publication"
  | "session-identity";

export type SessionFactsInvalidation = {
  reason: InvalidationReason;
  scope?: string;
  facts?: string;
  explicitInvalidation?: boolean;
  origins?: string[];
};

export type SessionFactsFailure = {
  reason:
    | "released"
    | "invalidated"
    | "routing-changed"
    | "retained-read-unavailable"
    | "source-identity-changed";
  firstInvalidation?: SessionFactsInvalidation;
  /** Observational only: a pending publication is not a revoked permission. */
  publicationPending?: boolean;
};

const scopes = new Set([
  "automation",
  "runtime",
  "session-entry",
  "acp",
  "transcript",
  "stores",
  "profiles",
  "catalog",
  "agent-runs",
  "subagent-runs",
  "worker-placements",
  "worker-environments",
  "config",
  "config-presentation",
  "config-profiles",
]);
const kinds = new Set([
  "unchanged",
  "replacement",
  "acp",
  "entry",
  "member",
  "owner",
  "participants",
  "category",
  "removed",
]);
const log = createSubsystemLogger("gateway/session-facts");
const reported = new WeakSet<SessionMutationFactsUnavailableError>();

/** Keep native retained-read refusal and its publication classification at one boundary. */
export function readRetainedSessionSharingFacts(
  read: Pick<
    ReturnType<typeof retainPreparedSessionSharingFacts>,
    "readCurrent" | "hasPendingPublication"
  >,
  scope: Parameters<
    ReturnType<typeof retainPreparedSessionSharingFacts>["readCurrent"]
  >[0] = "sharing",
) {
  const current = read.readCurrent(scope);
  if (!current) {
    throw new SessionMutationFactsUnavailableError({
      diagnostic: {
        reason: "retained-read-unavailable",
        publicationPending: read.hasPendingPublication(),
      },
    });
  }
  return current;
}

function sourceFrames(error: Error): string[] {
  try {
    const stack: unknown = error.stack;
    if (typeof stack !== "string") {
      return [];
    }
    return stack
      .split("\n")
      .slice(1)
      .flatMap((line) => {
        if (line.includes("new SessionMutationFactsUnavailableError")) {
          return [];
        }
        const origin = line.match(/([A-Za-z0-9_.-]+\.(?:[cm]?js|tsx?):\d+:\d+)/u)?.[1];
        return origin &&
          !origin.startsWith("session-sharing-facts-diagnostic") &&
          /^(?:session-sharing|session-accessor|session-entry|session-source|session-row-changes|conversation-knowledge|sqlite-worker)/u.test(
            origin,
          )
          ? [origin]
          : [];
      })
      .slice(0, 6);
  } catch {
    // Stack formatters are process hooks; they cannot become publication authority.
    return [];
  }
}

/** Retain only the first fence's closed classification, never its target or payload. */
export function captureSessionFactsInvalidation(
  reason: InvalidationReason,
  change?: SessionRowChange,
): SessionFactsInvalidation {
  return {
    reason,
    origins: sourceFrames(new Error()),
    ...(change
      ? {
          scope:
            typeof change.scope === "string" && scopes.has(change.scope)
              ? change.scope
              : typeof change.scope === "object"
                ? "store-scope"
                : "other",
          ...("sessionKey" in change && change.facts
            ? {
                facts: kinds.has(change.facts.kind) ? change.facts.kind : "other",
              }
            : {}),
          explicitInvalidation: Boolean(change.factsInvalidated),
        }
      : {}),
  };
}

/** A module basename and code position locate the throw without exporting host paths. */
export function sessionFactsFailureDiagnostic(
  error: SessionMutationFactsUnavailableError,
  phase: "prepare" | "read",
) {
  const origin = sourceFrames(error)[0];
  return {
    phase,
    reason: error.diagnostic?.reason ?? "unclassified",
    ...(typeof error.diagnostic?.publicationPending === "boolean"
      ? { publicationPending: error.diagnostic.publicationPending }
      : {}),
    ...(error.diagnostic?.firstInvalidation
      ? { firstInvalidation: error.diagnostic.firstInvalidation }
      : {}),
    ...(origin ? { origin } : {}),
  };
}

/** Existing error custody stays authoritative; diagnostics cannot replace the failure. */
export function reportSessionFactsFailure(error: unknown, phase: "prepare" | "read") {
  const failure =
    error instanceof SessionMutationFactsUnavailableError
      ? error
      : new SessionMutationFactsUnavailableError({ cause: error });
  if (!reported.has(failure)) {
    reported.add(failure);
    try {
      log.warn("Session access facts unavailable", sessionFactsFailureDiagnostic(failure, phase));
    } catch {
      // Observational logging must not change admission, release or retry behavior.
    }
  }
  return failure;
}

export function withSessionFactsFailureDiagnostic<T>(phase: "prepare" | "read", read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw reportSessionFactsFailure(error, phase);
  }
}
