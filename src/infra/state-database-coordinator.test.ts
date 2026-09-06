import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireStateDatabaseCoordinator,
  resolveStateDatabaseCoordinatorPath,
  withStateSchemaFence,
} from "./state-database-coordinator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("state database coordinator", () => {
  it.each([
    ["state", acquireStateDatabaseCoordinator],
    ["Gateway", acquireGatewayLifecycleCoordinator],
  ] as const)(
    "reacquires an existing %s coordinator without filesystem changes",
    async (_, acquire) => {
      const root = tempDirs.make("openclaw-lifecycle-coordinator-noop-");
      const params = {
        databasePath: path.join(root, "state", "openclaw.sqlite"),
        runtimeDirectory: root,
      };
      const first = acquire(params);
      const coordinatorPath = first.path;
      first.release();
      const directory = path.dirname(coordinatorPath);
      const beforeDirectory = await fs.stat(directory, { bigint: true });
      const beforeFile = await fs.stat(coordinatorPath, { bigint: true });
      const next = acquire(params);
      try {
        expect(await fs.readdir(directory)).toEqual([path.basename(coordinatorPath)]);
        const afterDirectory = await fs.stat(directory, { bigint: true });
        const afterFile = await fs.stat(coordinatorPath, { bigint: true });
        for (const key of ["ino", "mode", "size", "mtimeNs", "ctimeNs"] as const) {
          expect(afterDirectory[key]).toBe(beforeDirectory[key]);
          expect(afterFile[key]).toBe(beforeFile[key]);
        }
      } finally {
        next.release();
      }
    },
  );

  it("reference-counts same-process owners", async () => {
    const root = tempDirs.make("openclaw-state-database-coordinator-");
    const databasePath = path.join(root, "selected-state", "state", "openclaw.sqlite");
    const runtimeDirectory = path.join(root, "runtime");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const first = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    const nested = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });

    first.release();
    nested.release();

    const next = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    next.release();
  });

  it("shares same-process owners across duplicated loader realms", async () => {
    const root = tempDirs.make("openclaw-state-database-coordinator-global-");
    const databasePath = path.join(root, "selected-state", "state", "openclaw.sqlite");
    const runtimeDirectory = path.join(root, "runtime");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const registryKey = Symbol.for("openclaw.stateDatabaseCoordinator.held.v1");
    const processStore = process as NodeJS.Process & Record<PropertyKey, unknown>;
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    const originalProcessRegistry = processStore[registryKey];
    const originalGlobalRegistry = globalStore[registryKey];
    const coordinatorPath = resolveStateDatabaseCoordinatorPath({
      databasePath,
      runtimeDirectory,
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    });
    const coordinatorRelease = vi.fn();
    const crossRealmRegistry = vm.runInNewContext("new Map()") as Map<
      string,
      { coordinator: { release: () => void }; references: number }
    >;
    crossRealmRegistry.set(coordinatorPath, {
      coordinator: { release: coordinatorRelease },
      references: 1,
    });
    processStore[registryKey] = crossRealmRegistry;
    delete globalStore[registryKey];
    try {
      vi.resetModules();
      const duplicateRuntime = await import("./state-database-coordinator.js");
      const nested = duplicateRuntime.acquireStateDatabaseCoordinator({
        databasePath,
        runtimeDirectory,
        busyTimeoutMs: 0,
      });
      expect(crossRealmRegistry.get(coordinatorPath)?.references).toBe(2);
      nested.release();
      expect(crossRealmRegistry.get(coordinatorPath)?.references).toBe(1);
      expect(coordinatorRelease).not.toHaveBeenCalled();
    } finally {
      if (originalProcessRegistry === undefined) {
        delete processStore[registryKey];
      } else {
        processStore[registryKey] = originalProcessRegistry;
      }
      if (originalGlobalRegistry === undefined) {
        delete globalStore[registryKey];
      } else {
        globalStore[registryKey] = originalGlobalRegistry;
      }
    }
  });

  it("keeps Gateway presence independent from short state operations", async () => {
    const root = tempDirs.make("openclaw-gateway-lifecycle-coordinator-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const runtimeDirectory = path.join(root, "runtime");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const gateway = acquireGatewayLifecycleCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    const state = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });

    state.release();
    gateway.release();
  });

  it("allows the owning Gateway process to mutate its own schema", async () => {
    const root = tempDirs.make("openclaw-gateway-schema-owner-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const runtimeDirectory = path.join(root, "runtime");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const gateway = acquireGatewayLifecycleCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    try {
      expect(withStateSchemaFence({ databasePath, runtimeDirectory }, () => "mutated")).toBe(
        "mutated",
      );
    } finally {
      gateway.release();
    }
  });
});
