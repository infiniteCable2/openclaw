import type { SessionParentForkDecision } from "./session-accessor.types.js";
import type { PreparedInitialSessionContext } from "./session-initial-context.js";

/** Data only: native source/recipient authorization must remain held by the consuming host. */
export type InitialSessionContextRead =
  | {
      status: "prepared";
      context: PreparedInitialSessionContext;
      contextStatus?: "no-completed-turn";
    }
  | {
      status: "skipped";
      decision: Extract<SessionParentForkDecision, { status: "skip" }>;
    };
