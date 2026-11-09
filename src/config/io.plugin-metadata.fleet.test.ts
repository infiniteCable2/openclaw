import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as workspaceDirs from "../agents/workspace-dirs.js";
import { createDoctorPluginMetadataSnapshotScope } from "../commands/doctor/shared/plugin-metadata-snapshot-scope.js";
import {
  getCurrentPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { createPluginCache, getPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  resolveConfigWidePluginMetadataSnapshot,
  resolveConfigWidePluginMetadataSnapshotAsync,
} from "./io.plugin-metadata.js";

const { loadRegistry } = vi.hoisted(() => ({ loadRegistry: vi.fn() }));

vi.mock("../plugins/plugin-registry-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry-snapshot.js")>()),
  loadPluginRegistrySnapshotWithMetadata: loadRegistry,
  preparePluginRegistrySnapshotReader:
    (params: Record<string, unknown>) => (workspaceDir: string | undefined) =>
      loadRegistry({ ...params, workspaceDir }),
}));

afterEach(() => {
  loadRegistry.mockClear();
  vi.restoreAllMocks();
  loadRegistry.mockReset();
  clearPluginMetadataLifecycleCaches();
});

it("bounds Doctor workspace snapshots without repeatedly rebuilding the fleet registry", async () => {
  const source = createPluginMetadataSnapshotFixture({ plugins: [{ id: "shared" }] });
  loadRegistry.mockClear();
  loadRegistry.mockImplementation(({ workspaceDir, config }) => ({
    snapshot: {
      ...source.index,
      workspaceDir,
      policyHash: resolveInstalledPluginIndexPolicyHash(config, {}),
    },
    source: "derived",
    diagnostics: [],
    manifestRegistry: source.manifestRegistry,
  }));
  const workspaces = Array.from({ length: 200 }, (_, index) => `/fleet/agent-${index}`);
  const config = {
    agents: {
      ownership: "explicit" as const,
      defaults: { systemAgent: { agentId: "a0" } },
      entries: Object.fromEntries(
        workspaces.map((workspace, index) => [`a${index}`, { workspace }]),
      ),
    },
  };
  await using scope = createDoctorPluginMetadataSnapshotScope({ env: {} });
  const read = (workspaceDir: string) =>
    scope.run({ config, workspaceDir }, () => {
      expect(getPluginCache().metadata.snapshots.size).toBeLessThanOrEqual(64);
      return getCurrentPluginMetadataSnapshot({ config, workspaceDir, env: {} });
    });
  const first = read(workspaces[0]!);
  for (const workspace of workspaces.slice(1)) {
    expect(read(workspace)?.plugins.map((plugin) => plugin.id)).toEqual(["shared"]);
  }
  expect(read(workspaces.at(-1)!)).toBe(read(workspaces.at(-1)!));
  expect(read(workspaces[0]!)).not.toBe(first);
  expect(first?.plugins.map((plugin) => plugin.id)).toEqual(["shared"]);
  // The fleet merge reuses its first workspace; reloading it adds one read, not a fleet scan.
  expect(loadRegistry).toHaveBeenCalledTimes(workspaces.length * 2);
});

it.each(["sync", "async"] as const)(
  "materializes %s shared plugin metadata once across the fleet and retains its prepared facts",
  async (mode) => {
    const configSchema = { type: "object", properties: { label: { type: "string" } } };
    const source = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "shared", providers: ["shared"], configSchema }],
    });
    loadRegistry.mockImplementation(({ workspaceDir }: { workspaceDir: string }) => ({
      snapshot: { ...source.index, workspaceDir },
      source: "derived",
      diagnostics: [],
      manifestRegistry: source.manifestRegistry,
    }));
    const config = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "first" } },
        entries: Object.fromEntries(
          ["first", "second", "third"].map((id) => [id, { workspace: `/fleet/${id}` }]),
        ),
      },
    };
    await withTempDir("openclaw-metadata-fleet-", async (stateDir) =>
      withPluginCache(createPluginCache(), async () => {
        const params = {
          config,
          env: { OPENCLAW_STATE_DIR: stateDir },
          installRecords: {},
          allowCurrent: false,
        };
        const selectWorkspaces = vi.spyOn(workspaceDirs, "listAgentWorkspaceDirs");
        const read =
          mode === "async"
            ? resolveConfigWidePluginMetadataSnapshotAsync
            : resolveConfigWidePluginMetadataSnapshot;
        const snapshot = await read(params);
        expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["shared"]);
        expect(snapshot.owners.providers.get("shared")).toEqual(["shared"]);
        expect(snapshot.registryIndex.workspaceDir).toBe("/fleet/first");
        expect(snapshot.manifestRegistry.plugins[0]?.configSchema).toBe(configSchema);
        expect(Object.isFrozen(source.index)).toBe(false);
        expect(selectWorkspaces).toHaveBeenCalledTimes(1);
        expect(await read(params)).toBe(snapshot);
        expect(selectWorkspaces).toHaveBeenCalledTimes(2);
        expect(loadRegistry).toHaveBeenCalledTimes(3);
      }),
    );
  },
);

it.each([
  { systemOwner: true, sharedWorkspace: false },
  { systemOwner: false, sharedWorkspace: false },
  { systemOwner: true, sharedWorkspace: true },
  { systemOwner: false, sharedWorkspace: true },
])(
  "materializes fleet metadata without inventing an owner (systemOwner=$systemOwner, sharedWorkspace=$sharedWorkspace)",
  ({ systemOwner, sharedWorkspace }) => {
    const configSchema = { type: "object", properties: { label: { type: "string" } } };
    const source = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "shared", providers: ["shared"], configSchema }],
    });
    loadRegistry.mockImplementation(({ workspaceDir }: { workspaceDir?: string }) => ({
      snapshot: { ...source.index, workspaceDir },
      source: "derived",
      diagnostics: [],
      manifestRegistry: source.manifestRegistry,
    }));
    const config = {
      agents: {
        ownership: "explicit" as const,
        ...(systemOwner ? { defaults: { systemAgent: { agentId: "second" } } } : {}),
        entries: Object.fromEntries(
          ["first", "second", "third"].map((id) => [
            id,
            { workspace: path.resolve(`/fleet/${sharedWorkspace ? "shared" : id}`) },
          ]),
        ),
      },
    };
    const freeze = vi.spyOn(Object, "freeze");
    withPluginCache(createPluginCache(), () => {
      const params = { config, env: {}, installRecords: {}, allowCurrent: false };
      const snapshot = resolveConfigWidePluginMetadataSnapshot(params);
      expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["shared"]);
      expect(snapshot.owners.providers.get("shared")).toEqual(["shared"]);
      expect(snapshot.registryIndex.workspaceDir).toBe(
        systemOwner ? path.resolve(`/fleet/${sharedWorkspace ? "shared" : "second"}`) : undefined,
      );
      if (!systemOwner) {
        expect(loadRegistry).toHaveBeenCalledWith(
          expect.objectContaining({
            workspaceDir: undefined,
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ code: "workspace-scope-omitted", level: "warn" }),
            ]),
          }),
        );
      }
      expect(snapshot.manifestRegistry.plugins[0]?.configSchema).toBe(configSchema);
      expect(freeze.mock.calls.filter(([value]) => value === configSchema)).toHaveLength(1);
      expect(Object.isFrozen(configSchema.properties.label)).toBe(true);
      expect(Object.isFrozen(source.index)).toBe(false);
      expect(() => {
        configSchema.properties.label.type = "number";
      }).toThrow();
      expect(resolveConfigWidePluginMetadataSnapshot(params)).toBe(snapshot);
      expect(freeze.mock.calls.filter(([value]) => value === configSchema)).toHaveLength(1);
      expect(loadRegistry).toHaveBeenCalledTimes((sharedWorkspace ? 1 : 3) + (systemOwner ? 0 : 1));
    });
  },
);

it("invalidates the fleet cache when only the system owner changes", () => {
  const source = createPluginMetadataSnapshotFixture({ plugins: [{ id: "shared" }] });
  loadRegistry.mockImplementation(({ workspaceDir }: { workspaceDir?: string }) => ({
    snapshot: { ...source.index, workspaceDir },
    source: "derived",
    diagnostics: [],
    manifestRegistry: source.manifestRegistry,
  }));
  const entries = Object.fromEntries(
    ["first", "second"].map((id) => [id, { workspace: path.resolve(`/fleet/${id}`) }]),
  );
  const config = (agentId: string) => ({
    agents: {
      ownership: "explicit" as const,
      defaults: { systemAgent: { agentId } },
      entries,
    },
  });
  withPluginCache(createPluginCache(), () => {
    const first = resolveConfigWidePluginMetadataSnapshot({
      config: config("first"),
      env: {},
      installRecords: {},
      allowCurrent: false,
    });
    const second = resolveConfigWidePluginMetadataSnapshot({
      config: config("second"),
      env: {},
      installRecords: {},
      allowCurrent: false,
    });
    expect(second).not.toBe(first);
    expect(first.registryIndex.workspaceDir).toBe(entries.first!.workspace);
    expect(second.registryIndex.workspaceDir).toBe(entries.second!.workspace);
    expect(second.plugins).toEqual(first.plugins);
  });
});

it("does not inherit a scoped persona registry when the fleet has no system owner", () => {
  const config = {
    agents: {
      ownership: "explicit" as const,
      entries: {
        first: { workspace: path.resolve("/fleet/first") },
        second: { workspace: path.resolve("/fleet/second") },
      },
    },
  };
  const ownedConfig = {
    agents: { ...config.agents, defaults: { systemAgent: { agentId: "first" } } },
  };
  const source = createPluginMetadataSnapshotFixture({ plugins: [{ id: "shared" }] });
  const policyHash = resolveInstalledPluginIndexPolicyHash(config, {});
  loadRegistry.mockImplementation(({ workspaceDir }: { workspaceDir?: string }) => ({
    snapshot: { ...source.index, policyHash, workspaceDir },
    source: "derived",
    diagnostics: [],
    manifestRegistry: source.manifestRegistry,
  }));
  withPluginCache(createPluginCache(), () => {
    const scoped = resolveConfigWidePluginMetadataSnapshot({
      config: ownedConfig,
      env: {},
      installRecords: {},
      allowCurrent: false,
    });
    loadRegistry.mockClear();
    const result = withPluginMetadataSnapshotScope(
      scoped,
      () => resolveConfigWidePluginMetadataSnapshot({ config, env: {} }),
      { config: ownedConfig, env: {} },
    );
    expect(result.registryIndex.workspaceDir).toBeUndefined();
    expect(result.workspaceDir).toBeUndefined();
    expect(result.plugins.map((plugin) => plugin.id)).toEqual(["shared"]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "workspace-scope-omitted", level: "warn" }),
    );
    expect(loadRegistry).toHaveBeenCalledWith(expect.objectContaining({ workspaceDir: undefined }));
  });
});
