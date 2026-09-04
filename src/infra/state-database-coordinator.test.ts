import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireStateDatabaseCoordinator,
  withStateSchemaFence,
} from "./state-database-coordinator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("state database coordinator", () => {
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

  it("shares same-process owners across duplicated loader globals", async () => {
    const root = tempDirs.make("openclaw-state-database-coordinator-global-");
    const databasePath = path.join(root, "selected-state", "state", "openclaw.sqlite");
    const runtimeDirectory = path.join(root, "runtime");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const first = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    try {
      const registryKey = Symbol.for("openclaw.stateDatabaseCoordinator.held.v1");
      delete (globalThis as Record<PropertyKey, unknown>)[registryKey];
      vi.resetModules();
      const duplicateRuntime = await import("./state-database-coordinator.js");
      const nested = duplicateRuntime.acquireStateDatabaseCoordinator({
        databasePath,
        runtimeDirectory,
        busyTimeoutMs: 0,
      });
      const duplicateChunkRegistry = resolveGlobalMap<
        string,
        { coordinator: { release: () => void }; references: number }
      >(registryKey);
      expect([...duplicateChunkRegistry.values()]).toContainEqual(
        expect.objectContaining({ references: 2 }),
      );
      nested.release();
    } finally {
      first.release();
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
