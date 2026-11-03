import { afterEach, expect, it, vi } from "vitest";

const logging = vi.hoisted(() => ({ warn: vi.fn() }));
// mock-isolation: Observe the existing diagnostic sink without opening a log file.
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => logging }));

import {
  captureSessionFactsInvalidation,
  reportSessionFactsFailure,
  sessionFactsFailureDiagnostic,
} from "./session-sharing-facts-diagnostic.js";
import { SessionMutationFactsUnavailableError } from "./session-sharing-incognito.js";

afterEach(() => logging.warn.mockReset());

it("keeps target, arbitrary scope and exception payload out of the diagnostic", () => {
  const firstInvalidation = captureSessionFactsInvalidation("broad-publication", {
    all: true,
    scope: { agentId: "private-agent", storePath: "/private/database.sqlite" },
    factsInvalidated: true,
  });
  const error = new SessionMutationFactsUnavailableError({
    cause: new Error("private dialogue and credential payload"),
    diagnostic: { reason: "invalidated", firstInvalidation },
  });
  error.stack =
    "private dialogue\n at read (/private/session-sharing-preparation.ts:172:13)\n at caller (/private/personal-file.ts:1:2)";
  const diagnostic = sessionFactsFailureDiagnostic(error, "read");
  expect(diagnostic).toMatchObject({
    phase: "read",
    reason: "invalidated",
    origin: "session-sharing-preparation.ts:172:13",
    firstInvalidation: {
      reason: "broad-publication",
      scope: "store-scope",
      explicitInvalidation: true,
    },
  });
  expect(JSON.stringify(diagnostic)).not.toMatch(/private|credential|dialogue|personal-file/u);
  expect(
    captureSessionFactsInvalidation("broad-publication", { all: true, scope: "private-scope" })
      .scope,
  ).toBe("other");
  expect(error.message).toBe(
    "Session access facts are unavailable; retry after session storage is ready.",
  );
});

it("reports the original failure once across preparation and read without changing its cause", () => {
  const cause = new Error("original storage failure");
  const error = new SessionMutationFactsUnavailableError({ cause });
  expect(reportSessionFactsFailure(error, "read")).toBe(error);
  expect(reportSessionFactsFailure(error, "prepare")).toBe(error);
  expect(error.cause).toBe(cause);
  expect(logging.warn).toHaveBeenCalledOnce();
  expect(logging.warn).toHaveBeenCalledWith(
    "Session access facts unavailable",
    expect.objectContaining({ phase: "read", reason: "unclassified" }),
  );
});

it("keeps failed diagnostics observational and preserves native error wrapping", () => {
  logging.warn.mockImplementationOnce(() => {
    throw new Error("diagnostic sink unavailable");
  });
  const cause = new Error("storage unavailable");
  const error = reportSessionFactsFailure(cause, "prepare");
  expect(error).toBeInstanceOf(SessionMutationFactsUnavailableError);
  expect(error.cause).toBe(cause);
});

it("keeps publication invalidation silent even if a process stack formatter throws", () => {
  const previous = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = () => {
      throw new Error("stack formatter unavailable");
    };
    expect(captureSessionFactsInvalidation("session-identity")).toEqual({
      reason: "session-identity",
      origins: [],
    });
  } finally {
    Error.prepareStackTrace = previous;
  }
});

it("omits its own hashed build frames and bounds native source positions", () => {
  const error = new SessionMutationFactsUnavailableError();
  error.stack =
    "Error\n at report (/runtime/session-sharing-facts-diagnostic-abc123.js:10:5)\n at read (/runtime/session-sharing-preparation-def456.js:20:7)";
  expect(sessionFactsFailureDiagnostic(error, "prepare").origin).toBe(
    "session-sharing-preparation-def456.js:20:7",
  );
});
