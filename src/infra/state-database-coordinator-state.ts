// Owns the process-local coordinator registry and its inseparable lexical scopes.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { SqliteCoordinatorError, type SqliteCoordinatorLease } from "./sqlite-coordinator.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";

type HeldCoordinator = {
  coordinator: SqliteCoordinatorLease;
  references: number;
  keepAlive: boolean;
  gatewayOwners: number;
  gatewayDelegates: Set<Int32Array>;
};

export type SourceReadScope = {
  active: boolean;
  mutation?: boolean;
  assertCurrent: () => void;
  pin: () => { release: () => void };
  snapshot?: () => Promise<PreparedSqliteReadOnlyLocation>;
  snapshots?: Promise<unknown>[];
};

export type StateDatabaseCoordinatorRuntime = Readonly<{
  directory: string;
  keepAlive: boolean;
}>;

const COORDINATOR_STATE_KEY = Symbol.for("openclaw.stateDatabaseCoordinator");

function createCoordinatorState() {
  return {
    heldCoordinators: new Map<string, HeldCoordinator>(),
    sourceReadScopes: new AsyncLocalStorage<ReadonlyMap<string, SourceReadScope>>(),
    canonicalWriteScopes: new AsyncLocalStorage<ReadonlyMap<string, SourceReadScope>>(),
    coordinatorRuntimeDirectories: new AsyncLocalStorage<StateDatabaseCoordinatorRuntime>(),
    gatewaySchemaScopes: new AsyncLocalStorage<
      ReadonlyMap<string, { active: boolean; assertCurrent: () => void }>
    >(),
  };
}

function isCoordinatorState(value: unknown): value is ReturnType<typeof createCoordinatorState> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  try {
    // Map identity is realm-local; the intrinsic checks its actual internal slot.
    Map.prototype.has.call(candidate.heldCoordinators, COORDINATOR_STATE_KEY);
    return [
      candidate.sourceReadScopes,
      candidate.canonicalWriteScopes,
      candidate.coordinatorRuntimeDirectories,
      candidate.gatewaySchemaScopes,
    ].every(
      (scope) =>
        scope !== null &&
        typeof scope === "object" &&
        "getStore" in scope &&
        typeof scope.getStore === "function" &&
        "run" in scope &&
        typeof scope.run === "function",
    );
  } catch {
    return false;
  }
}

export function resolveStateDatabaseCoordinatorState() {
  const processStore = process as NodeJS.Process & Record<PropertyKey, unknown>;
  const shared = processStore[COORDINATOR_STATE_KEY];
  if (shared !== undefined) {
    if (!isCoordinatorState(shared)) {
      throw new SqliteCoordinatorError("state lifecycle process registry is invalid");
    }
    // Bundled Doctor/Jiti realms share the Node process. Carry the entire owner,
    // including its lexical scopes, into the native singleton before resolving it.
    (globalThis as Record<PropertyKey, unknown>)[COORDINATOR_STATE_KEY] = shared;
  }
  const state = resolveGlobalSingleton(COORDINATOR_STATE_KEY, createCoordinatorState);
  processStore[COORDINATOR_STATE_KEY] = state;
  return state;
}
