// Coordinates Gateway presence and shared-state lifecycle operations outside removable state.
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { resolveGlobalMap, resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import {
  ensurePrivateSqliteCoordinatorDirectory,
  runWithSqliteCoordinator,
  SqliteCoordinatorError,
  tryAcquireExclusiveSqliteCoordinator,
} from "./sqlite-coordinator.js";

const HELD_COORDINATORS_KEY = Symbol.for("openclaw.stateDatabaseCoordinator.held.v1");
const WORKER_AUTHORITY_STORAGE_KEY = Symbol.for(
  "openclaw.stateDatabaseCoordinator.workerAuthority.v1",
);
const WORKER_AUTHORITY_ACTIVE_INDEX = 0;
const WORKER_AUTHORITY_BORROWERS_INDEX = 1;
const WORKER_AUTHORITY_STATE_LENGTH = 2;

export type StateDatabaseCoordinatorWorkerAuthority = {
  coordinatorPath: string;
  state: SharedArrayBuffer;
  version: 1;
};

type HeldCoordinator = {
  coordinator: { release: () => void };
  family: CoordinatorFamily;
  references: number;
  workerAuthorityState?: SharedArrayBuffer;
};

function resolveWorkerAuthorityStorage(): AsyncLocalStorage<StateDatabaseCoordinatorWorkerAuthority> {
  const processStore = process as NodeJS.Process & Record<PropertyKey, unknown>;
  const processStorage = processStore[WORKER_AUTHORITY_STORAGE_KEY];
  if (processStorage !== undefined) {
    const storage = processStorage as Partial<
      AsyncLocalStorage<StateDatabaseCoordinatorWorkerAuthority>
    >;
    if (typeof storage.getStore !== "function" || typeof storage.run !== "function") {
      throw new SqliteCoordinatorError("state lifecycle Worker authority storage is invalid");
    }
    (globalThis as Record<PropertyKey, unknown>)[WORKER_AUTHORITY_STORAGE_KEY] = processStorage;
  }
  const storage = resolveGlobalSingleton(
    WORKER_AUTHORITY_STORAGE_KEY,
    () => new AsyncLocalStorage<StateDatabaseCoordinatorWorkerAuthority>(),
  );
  processStore[WORKER_AUTHORITY_STORAGE_KEY] = storage;
  return storage;
}

const workerAuthority = resolveWorkerAuthorityStorage();

function traceCoordinator(
  action: string,
  details: Record<string, boolean | number | string | undefined>,
): void {
  if (process.env.OPENCLAW_DEBUG_STATE_COORDINATOR !== "1") {
    return;
  }
  const fields = { action, pid: process.pid, threadId, ...details };
  process.stderr.write(
    `[state-coordinator] ${Object.entries(fields)
      .filter((entry) => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ")}\n`,
  );
}

function isMapAcrossRealms(value: unknown): value is Map<unknown, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  try {
    Map.prototype.has.call(value, HELD_COORDINATORS_KEY);
    return true;
  } catch {
    return false;
  }
}

function resolveHeldCoordinators(): Map<string, HeldCoordinator> {
  const processStore = process as NodeJS.Process & Record<PropertyKey, unknown>;
  const processRegistry = processStore[HELD_COORDINATORS_KEY];
  if (processRegistry !== undefined) {
    if (!isMapAcrossRealms(processRegistry)) {
      throw new SqliteCoordinatorError("state lifecycle process registry must be a Map");
    }
    // Bundled Doctor commands can load the same runtime through distinct Jiti
    // realms. Rehydrate this context from the shared Node process before asking
    // the generic singleton helper for the registry; instanceof is realm-local.
    (globalThis as Record<PropertyKey, unknown>)[HELD_COORDINATORS_KEY] = processRegistry;
  }
  const registry = resolveGlobalMap<string, HeldCoordinator>(HELD_COORDINATORS_KEY);
  processStore[HELD_COORDINATORS_KEY] = registry;
  traceCoordinator("resolve-registry", {
    entries: registry.size,
    processRegistryPresent: processRegistry !== undefined,
  });
  return registry;
}

const heldCoordinators = resolveHeldCoordinators();

type CoordinatorFamily = "gateway-lifecycle" | "state-lifecycle";
type CoordinatorOptions = {
  databasePath: string;
  coordinatorPath?: string;
  runtimeDirectory?: string;
  uid?: number;
  busyTimeoutMs?: number;
};

function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  try {
    return (
      Object.prototype.toString.call(value) === "[object SharedArrayBuffer]" &&
      (value as SharedArrayBuffer).byteLength ===
        WORKER_AUTHORITY_STATE_LENGTH * Int32Array.BYTES_PER_ELEMENT
    );
  } catch {
    return false;
  }
}

export function isStateDatabaseCoordinatorWorkerAuthority(
  value: unknown,
): value is StateDatabaseCoordinatorWorkerAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.coordinatorPath === "string" &&
    candidate.coordinatorPath.length > 0 &&
    isSharedArrayBuffer(candidate.state)
  );
}

function resolveHeldWorkerAuthorityState(held: HeldCoordinator): SharedArrayBuffer {
  if (held.workerAuthorityState) {
    return held.workerAuthorityState;
  }
  const state = new SharedArrayBuffer(WORKER_AUTHORITY_STATE_LENGTH * Int32Array.BYTES_PER_ELEMENT);
  Atomics.store(new Int32Array(state), WORKER_AUTHORITY_ACTIVE_INDEX, 1);
  held.workerAuthorityState = state;
  return state;
}

function tryBorrowWorkerAuthority(coordinatorPath: string): { release: () => void } | undefined {
  const authority = workerAuthority.getStore();
  if (!authority || authority.coordinatorPath !== coordinatorPath) {
    return undefined;
  }
  const state = new Int32Array(authority.state);
  if (Atomics.load(state, WORKER_AUTHORITY_ACTIVE_INDEX) !== 1) {
    return undefined;
  }
  Atomics.add(state, WORKER_AUTHORITY_BORROWERS_INDEX, 1);
  if (Atomics.load(state, WORKER_AUTHORITY_ACTIVE_INDEX) !== 1) {
    Atomics.sub(state, WORKER_AUTHORITY_BORROWERS_INDEX, 1);
    Atomics.notify(state, WORKER_AUTHORITY_BORROWERS_INDEX);
    return undefined;
  }
  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      Atomics.sub(state, WORKER_AUTHORITY_BORROWERS_INDEX, 1);
      Atomics.notify(state, WORKER_AUTHORITY_BORROWERS_INDEX);
    },
  };
}

export function runWithStateDatabaseCoordinatorWorkerAuthority<T>(
  authority: StateDatabaseCoordinatorWorkerAuthority,
  run: () => Promise<T>,
): Promise<T> {
  if (!isStateDatabaseCoordinatorWorkerAuthority(authority)) {
    throw new SqliteCoordinatorError("state lifecycle Worker authority is invalid");
  }
  return workerAuthority.run(authority, run);
}

export class StateDatabaseCoordinatorContentionError extends SqliteCoordinatorError {
  constructor(family: CoordinatorFamily) {
    super(`another OpenClaw process owns ${family}`);
    this.name = "StateDatabaseCoordinatorContentionError";
  }
}

export class StateSchemaMutationConflictError extends SqliteCoordinatorError {
  constructor(databasePath: string, cause: unknown) {
    super(
      `OpenClaw refused shared state schema mutation at ${databasePath} because another Gateway owns that state directory. Stop that Gateway or perform the update through its managed restart path, then retry.`,
      cause,
    );
    this.name = "StateSchemaMutationConflictError";
  }
}

export function resolveStateLifecycleRuntimeDirectory(): string {
  return process.platform === "win32"
    ? path.join(os.homedir(), "AppData", "Local", "OpenClaw", "locks")
    : "/tmp";
}

function resolveLifecycleCoordinatorPath(
  family: CoordinatorFamily,
  params: { databasePath: string; runtimeDirectory: string; uid: number | undefined },
): string {
  const canonicalDatabasePath = resolvePathViaExistingAncestorSync(params.databasePath);
  const canonicalRuntimeDirectory = resolvePathViaExistingAncestorSync(params.runtimeDirectory);
  // The predecessor state-local coordinator shipped only in v2026.8.1-beta.2.
  // Keep one current stable runtime path; beta-only peers are not upgrade-compatible.
  const suffix =
    params.uid === undefined ? "openclaw-state-locks" : `openclaw-state-locks-${params.uid}`;
  return path.join(
    canonicalRuntimeDirectory,
    suffix,
    `${family}.${sha256HexPrefixCore(canonicalDatabasePath, 8)}.lock.sqlite`,
  );
}

export function resolveStateDatabaseCoordinatorPath(params: {
  databasePath: string;
  runtimeDirectory: string;
  uid: number | undefined;
}): string {
  return resolveLifecycleCoordinatorPath("state-lifecycle", params);
}

function acquireLifecycleCoordinator(
  family: CoordinatorFamily,
  params: CoordinatorOptions,
): { path: string; release: () => void } {
  const coordinatorPath =
    params.coordinatorPath ??
    resolveLifecycleCoordinatorPath(family, {
      databasePath: params.databasePath,
      runtimeDirectory: params.runtimeDirectory ?? resolveStateLifecycleRuntimeDirectory(),
      uid: params.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
    });
  const held = heldCoordinators.get(coordinatorPath);
  traceCoordinator("acquire-attempt", {
    entries: heldCoordinators.size,
    family,
    held: held !== undefined,
    references: held?.references,
  });
  if (held) {
    held.references += 1;
    traceCoordinator("acquire-reentrant", { family, references: held.references });
  } else {
    const borrowed = tryBorrowWorkerAuthority(coordinatorPath);
    if (borrowed) {
      traceCoordinator("acquire-worker-reentrant", { family });
      return { path: coordinatorPath, release: borrowed.release };
    }
    ensurePrivateSqliteCoordinatorDirectory(path.dirname(coordinatorPath), `${family} coordinator`);
    const coordinator = tryAcquireExclusiveSqliteCoordinator(coordinatorPath, {
      busyTimeoutMs: params.busyTimeoutMs,
    });
    if (!coordinator) {
      traceCoordinator("acquire-contended", { entries: heldCoordinators.size, family });
      throw new StateDatabaseCoordinatorContentionError(family);
    }
    heldCoordinators.set(coordinatorPath, { coordinator, family, references: 1 });
    traceCoordinator("acquire-new", { entries: heldCoordinators.size, family, references: 1 });
  }

  let released = false;
  return {
    path: coordinatorPath,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const current = heldCoordinators.get(coordinatorPath);
      if (!current) {
        return;
      }
      current.references -= 1;
      traceCoordinator("release", { family, references: current.references });
      if (current.references > 0) {
        return;
      }
      if (current.workerAuthorityState) {
        const workerState = new Int32Array(current.workerAuthorityState);
        Atomics.store(workerState, WORKER_AUTHORITY_ACTIVE_INDEX, 0);
        if (Atomics.load(workerState, WORKER_AUTHORITY_BORROWERS_INDEX) > 0) {
          throw new SqliteCoordinatorError(
            `cannot release ${family} coordinator while an authorized Worker is active`,
          );
        }
      }
      heldCoordinators.delete(coordinatorPath);
      try {
        current.coordinator.release();
      } catch (error) {
        throw new SqliteCoordinatorError(`failed to release ${family} coordinator`, error);
      }
    },
  };
}

export function acquireGatewayLifecycleCoordinator(params: CoordinatorOptions) {
  return acquireLifecycleCoordinator("gateway-lifecycle", params);
}

export function acquireStateDatabaseCoordinator(params: CoordinatorOptions) {
  return acquireLifecycleCoordinator("state-lifecycle", params);
}

/** Grant one explicitly spawned Worker access to a currently held state lifecycle. */
export function createStateDatabaseCoordinatorWorkerAuthority(
  _params: Record<string, never> = {},
): StateDatabaseCoordinatorWorkerAuthority | undefined {
  const active = [...heldCoordinators].filter(
    ([, held]) => held.family === "state-lifecycle" && held.references > 0,
  );
  traceCoordinator("create-worker-authority", {
    activeStateCoordinators: active.length,
    entries: heldCoordinators.size,
  });
  if (active.length !== 1) {
    return undefined;
  }
  const [coordinatorPath, held] = active[0]!;
  const state = resolveHeldWorkerAuthorityState(held);
  if (Atomics.load(new Int32Array(state), WORKER_AUTHORITY_ACTIVE_INDEX) !== 1) {
    return undefined;
  }
  return {
    version: 1,
    coordinatorPath,
    state,
  };
}

/** Fence schema mutation against another process's live Gateway owner. */
export function withStateSchemaFence<T>(
  params: Pick<CoordinatorOptions, "databasePath" | "runtimeDirectory" | "uid">,
  operation: () => T,
): T {
  let coordinator: ReturnType<typeof acquireGatewayLifecycleCoordinator>;
  try {
    // Never wait while the caller holds the state-lifecycle coordinator. A
    // running Gateway must win immediately so lock ordering cannot deadlock.
    coordinator = acquireGatewayLifecycleCoordinator({
      ...params,
      busyTimeoutMs: 0,
    });
  } catch (error) {
    if (error instanceof StateDatabaseCoordinatorContentionError) {
      throw new StateSchemaMutationConflictError(params.databasePath, error);
    }
    throw error;
  }
  return runWithSqliteCoordinator(coordinator, "state schema mutation", operation);
}
