import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";

export class SessionMutationAuthorizationChangedError extends Error {
  readonly error: ErrorShape;

  constructor(error: ErrorShape) {
    super(error.message);
    this.name = "SessionMutationAuthorizationChangedError";
    this.error = error;
  }
}

/** An explicit native personal-read refusal, distinct from unavailable storage facts. */
export class PersonalConversationReadRefusedError extends SessionMutationAuthorizationChangedError {
  constructor(message: string) {
    super({ code: "FORBIDDEN", message });
    this.name = "PersonalConversationReadRefusedError";
  }
}

export class SessionSharingProfileFactsChangedError extends SessionMutationAuthorizationChangedError {
  readonly readSource: () => OpenClawStateDatabaseOptions;

  constructor(error: ErrorShape, readSource: () => OpenClawStateDatabaseOptions) {
    super(error);
    this.readSource = readSource;
  }
}

export type SessionMutationTarget = {
  sessionKey: string;
  agentId?: string;
};
