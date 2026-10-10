import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearBundledDiscoveryModeMemo } from "../plugins/bundled-discovery-state.js";
import {
  recordPluginCandidateInstallOwner,
  resolvePluginCandidateInstallOwner,
} from "../plugins/candidate-install-owner.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { restorePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "../plugins/plugin-metadata.test-support.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const mocks = vi.hoisted(() => ({
  resolvePluginMetadataSnapshotInput: vi.fn(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshotInput,
  resolvePluginMetadataSnapshotInput: mocks.resolvePluginMetadataSnapshotInput,
}));

const { resolveReadOnlyChannelPluginsForConfig } = await import("../channels/plugins/read-only.js");
const { createConfigIoContext } = await import("./io.context.js");
const {
  resolveConfigWidePluginMetadataSnapshot,
  resolveConfigWidePluginMetadataSnapshotAsync,
  resolveConfigWidePluginManifestRegistry,
} = await import("./io.plugin-metadata.js");

const { createCanonicalAgentConfigFixture } = await import("../test-utils/config-roster.js");
const { validateConfigObjectWithPlugins, validateConfigObjectWithPluginsAsync } =
  await import("./validation.js");

const agents = {
  ownership: "explicit" as const,
  defaults: { systemAgent: { agentId: "ops" } },
  entries: {
    ops: { workspace: path.resolve("/srv/ops") },
    research: { workspace: path.resolve("/srv/research") },
  },
};

function manifestRecord(id: string, source: string, channels: string[] = []): PluginManifestRecord {
  return createPluginManifestRecordFixture({
    id,
    source,
    rootDir: source,
    origin: "workspace",
    channels,
    name: id,
    description: "test plugin",
    version: "1.0.0",
  });
}

function workspaceSnapshot(
  workspaceDir: string,
  plugins: PluginManifestRecord[],
  disabledIds: readonly string[] = [],
  policyHash = "test",
) {
  const snapshot = createPluginMetadataSnapshotFixture({ plugins });
  const index = {
    ...snapshot.index,
    workspaceDir,
    policyHash,
    plugins: snapshot.index.plugins.map((plugin) => ({
      ...plugin,
      enabled: !disabledIds.includes(plugin.pluginId),
    })),
  };
  return restorePluginMetadataSnapshot({
    ...snapshot,
    workspaceDir,
    policyHash,
    index,
    registryIndex: index,
    plugins,
    manifestRegistry: { plugins, diagnostics: [] },
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    discovery: {
      candidates: plugins.map((plugin) =>
        recordPluginCandidateInstallOwner(
          {
            idHint: plugin.id,
            source: plugin.source,
            rootDir: plugin.rootDir,
            origin: plugin.origin,
            workspaceDir,
          },
          plugin.id,
        ),
      ),
      diagnostics: [],
    },
  });
}

describe("config IO plugin metadata snapshots", () => {
  beforeEach(() => {
    clearCurrentPluginMetadataSnapshot();
    clearPluginMetadataLifecycleCaches();
    mocks.resolvePluginMetadataSnapshotInput.mockReset();
  });

  it("shares first-access inventory across config reads and alternating plugin selections", () => {
    const primary = manifestRecord("primary", "/srv/ops/primary");
    const secondary = manifestRecord("secondary", "/srv/research/secondary");
    const snapshots = new Map([
      [path.resolve("/srv/ops"), workspaceSnapshot(path.resolve("/srv/ops"), [primary])],
      [
        path.resolve("/srv/research"),
        workspaceSnapshot(path.resolve("/srv/research"), [secondary]),
      ],
    ]);
    mocks.resolvePluginMetadataSnapshotInput.mockImplementation(
      ({ workspaceDir }: { workspaceDir: string }) => snapshots.get(workspaceDir),
    );
    const config = { agents };
    for (let read = 0; read < 2; read++) {
      const context = createConfigIoContext({ env: {}, observe: false });
      const loader = context.createValidationPluginMetadataSnapshotLoader({
        effectiveConfigRaw: config,
        env: {},
      });
      loader.load(config);
      expect(loader.getSnapshot()?.plugins.map((plugin) => plugin.id)).toEqual([
        "primary",
        "secondary",
      ]);
    }
    for (const pluginId of ["primary", "secondary", "primary"]) {
      expect(
        resolveConfigWidePluginManifestRegistry({
          config,
          env: {},
          pluginIds: [pluginId],
        }).plugins.map((plugin) => plugin.id),
      ).toEqual([pluginId]);
    }
    expect(mocks.resolvePluginMetadataSnapshotInput).toHaveBeenCalledTimes(2);
  });

  it("reuses compatible Gateway metadata inside an isolated reload operation", async () => {
    const prepared = manifestRecord("prepared", "/srv/ops/prepared");
    const config = {
      agents: { entries: { ops: { workspace: path.resolve("/srv/ops") } } },
      logging: { level: "info" as const },
      plugins: { entries: { prepared: { enabled: true } } },
    };
    const snapshot = workspaceSnapshot(
      path.resolve("/srv/ops"),
      [prepared],
      [],
      resolveInstalledPluginIndexPolicyHash(config, {}),
    );
    setGatewayPluginMetadataSnapshot(snapshot, { config, env: {} });
    mocks.resolvePluginMetadataSnapshotInput.mockReturnValue(snapshot);

    const loggingOnly = withPluginCache(createPluginCache(), () =>
      resolveConfigWidePluginMetadataSnapshot({
        config: { ...config, logging: { level: "debug" } },
        env: {},
      }),
    );
    expect(loggingOnly).toBe(snapshot);
    expect(mocks.resolvePluginMetadataSnapshotInput).not.toHaveBeenCalled();

    clearBundledDiscoveryModeMemo();
    const asyncLoggingOnly = await withPluginCache(createPluginCache(), () =>
      resolveConfigWidePluginMetadataSnapshotAsync({
        config: { ...config, logging: { level: "warn" } },
        env: {},
      }),
    );
    expect(asyncLoggingOnly).toBe(snapshot);
    expect(mocks.resolvePluginMetadataSnapshotInput).not.toHaveBeenCalled();

    withPluginCache(createPluginCache(), () =>
      resolveConfigWidePluginMetadataSnapshot({
        config: {
          ...config,
          plugins: { ...config.plugins, load: { paths: ["/srv/new-plugin"] } },
        },
        env: {},
      }),
    );
    expect(mocks.resolvePluginMetadataSnapshotInput).toHaveBeenCalledTimes(1);
  });
  it.each(["sync", "async"] as const)(
    "reuses Gateway metadata through %s config validation",
    async (mode) => {
      const config: OpenClawConfig = {
        agents: { entries: { ops: { workspace: path.resolve("/srv/ops") } } },
        logging: { level: "info" },
      };
      const prepared = manifestRecord("prepared", "/srv/ops/prepared");
      const snapshot = workspaceSnapshot(
        path.resolve("/srv/ops"),
        [prepared],
        [],
        resolveInstalledPluginIndexPolicyHash(config, {}),
      );
      setGatewayPluginMetadataSnapshot(snapshot, { config, env: {} });
      mocks.resolvePluginMetadataSnapshotInput.mockReturnValue(snapshot);
      const nextConfig = { ...config, logging: { level: "debug" } };
      const loader = createConfigIoContext({
        env: {},
        observe: false,
      }).createValidationPluginMetadataSnapshotLoader({ env: {} });

      const result = await withPluginCache(createPluginCache(), () =>
        mode === "sync"
          ? validateConfigObjectWithPlugins(nextConfig, {
              env: {},
              loadPluginMetadataSnapshot: loader.load,
            })
          : validateConfigObjectWithPluginsAsync(nextConfig, {
              env: {},
              loadPluginMetadataSnapshotAsync: loader.loadAsync,
            }),
      );

      expect(result.ok).toBe(true);
      expect(loader.getSnapshot()).toBe(snapshot);
      expect(mocks.resolvePluginMetadataSnapshotInput).not.toHaveBeenCalled();
    },
  );

  it("discovers the new workspace when reload changes legacy default ownership", async () => {
    const legacyConfig = (defaultAgent: "ops" | "research") => ({
      agents: {
        defaults: { workspace: path.resolve("/srv/base") },
        entries: {
          ops: { default: defaultAgent === "ops" },
          research: { default: defaultAgent === "research" },
        },
      },
    });
    const config = createCanonicalAgentConfigFixture(legacyConfig("ops")).config;
    const policyHash = resolveInstalledPluginIndexPolicyHash(config, {});
    const initial = workspaceSnapshot(path.resolve("/srv/base"), [], [], policyHash);
    setGatewayPluginMetadataSnapshot(initial, { config, env: {} });
    const added = manifestRecord("new-workspace-plugin", "/srv/base/ops/plugin");
    const snapshots = new Map([
      [path.resolve("/srv/base"), workspaceSnapshot(path.resolve("/srv/base"), [], [], policyHash)],
      [
        path.resolve("/srv/base/ops"),
        workspaceSnapshot(path.resolve("/srv/base/ops"), [added], [], policyHash),
      ],
    ]);
    mocks.resolvePluginMetadataSnapshotInput.mockImplementation(
      ({ workspaceDir }: { workspaceDir: string }) => snapshots.get(workspaceDir),
    );
    const nextConfig = createCanonicalAgentConfigFixture(legacyConfig("research")).config;
    const loader = createConfigIoContext({
      env: {},
      observe: false,
    }).createValidationPluginMetadataSnapshotLoader({ env: {} });

    const result = await withPluginCache(createPluginCache(), () =>
      validateConfigObjectWithPluginsAsync(nextConfig, {
        env: {},
        loadPluginMetadataSnapshotAsync: loader.loadAsync,
      }),
    );

    expect(result.ok).toBe(true);
    expect(loader.getSnapshot()?.plugins.map((plugin) => plugin.id)).toEqual([added.id]);
    expect(
      mocks.resolvePluginMetadataSnapshotInput.mock.calls.map(([params]) => params.workspaceDir),
    ).toEqual([path.resolve("/srv/base/ops"), path.resolve("/srv/base")]);
  });

  it("rejects Gateway metadata when the configured workspace set changes", async () => {
    const prepared = manifestRecord("prepared", "/srv/ops/prepared");
    const config = {
      agents: {
        defaults: { systemAgent: { agentId: "ops" } },
        entries: {
          ops: { workspace: path.resolve("/srv/ops") },
          research: { workspace: path.resolve("/srv/research") },
        },
      },
    };
    const snapshot = workspaceSnapshot(
      path.resolve("/srv/ops"),
      [prepared],
      [],
      resolveInstalledPluginIndexPolicyHash(config, {}),
    );
    setGatewayPluginMetadataSnapshot(snapshot, { config, env: {} });
    mocks.resolvePluginMetadataSnapshotInput.mockReturnValue(snapshot);

    const changedConfigs: OpenClawConfig[] = [
      { agents: { entries: { ops: { workspace: path.resolve("/srv/ops") } } } },
      {
        agents: {
          defaults: { systemAgent: { agentId: "ops" } },
          entries: {
            ops: { workspace: path.resolve("/srv/ops") },
            research: { workspace: path.resolve("/srv/analysis") },
          },
        },
      },
      {
        agents: {
          defaults: { systemAgent: { agentId: "ops" } },
          entries: {
            ops: { workspace: path.resolve("/srv/ops") },
            research: { workspace: path.resolve("/srv/research") },
            support: { workspace: path.resolve("/srv/support") },
          },
        },
      },
    ];
    for (const [index, changedConfig] of changedConfigs.entries()) {
      mocks.resolvePluginMetadataSnapshotInput.mockClear();
      if (index === 1) {
        await withPluginCache(createPluginCache(), () =>
          resolveConfigWidePluginMetadataSnapshotAsync({ config: changedConfig, env: {} }),
        );
      } else {
        withPluginCache(createPluginCache(), () =>
          resolveConfigWidePluginMetadataSnapshot({ config: changedConfig, env: {} }),
        );
      }
      expect(mocks.resolvePluginMetadataSnapshotInput).toHaveBeenCalledTimes(index + 1);
    }
  });

  it.each(["research", undefined])(
    "rejects operation reuse of Gateway metadata when only the system owner changes to %s",
    (agentId) => {
      const entries = {
        ops: { workspace: path.resolve("/srv/ops") },
        research: { workspace: path.resolve("/srv/research") },
      };
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "ops" } },
          entries,
        },
      };
      const policyHash = resolveInstalledPluginIndexPolicyHash(config, {});
      const prepared = workspaceSnapshot(entries.ops.workspace, [], [], policyHash);
      setGatewayPluginMetadataSnapshot(prepared, { config, env: {} });
      mocks.resolvePluginMetadataSnapshotInput.mockImplementation(
        ({ workspaceDir }: { workspaceDir?: string }) => ({
          ...workspaceSnapshot(workspaceDir ?? "", [], [], policyHash),
          workspaceDir,
          index: { ...prepared.index, workspaceDir },
          registryIndex: { ...prepared.registryIndex, workspaceDir },
        }),
      );
      const changedConfig: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          ...(agentId ? { defaults: { systemAgent: { agentId } } } : {}),
          entries,
        },
      };
      const result = withPluginCache(createPluginCache(), () =>
        resolveConfigWidePluginMetadataSnapshot({ config: changedConfig, env: {} }),
      );
      expect(result).not.toBe(prepared);
      expect(result.workspaceDir).toBe(agentId ? entries.research.workspace : undefined);
      expect(result.registryIndex.workspaceDir).toBe(result.workspaceDir);
      expect(mocks.resolvePluginMetadataSnapshotInput).toHaveBeenCalledTimes(agentId ? 2 : 3);
    },
  );
  it("feeds merged workspace plugins to snapshot-backed read-only discovery", () => {
    const primary = manifestRecord("primary", "/srv/ops/primary");
    const secondary = manifestRecord("research-chat-plugin", "/srv/research/research-chat-plugin", [
      "research-chat",
    ]);
    const mergedRegistry = { plugins: [primary, secondary], diagnostics: [] };
    const secondaryDiagnostic = {
      level: "warn" as const,
      code: "persisted-registry-stale-source" as const,
      message: "Retained secondary registry metadata",
    };
    const snapshots = new Map([
      [
        path.resolve("/srv/ops"),
        workspaceSnapshot(path.resolve("/srv/ops"), [primary], ["primary"]),
      ],
      [
        path.resolve("/srv/research"),
        {
          ...workspaceSnapshot(path.resolve("/srv/research"), [secondary]),
          registryDiagnostics: [secondaryDiagnostic],
        },
      ],
    ]);
    mocks.resolvePluginMetadataSnapshotInput.mockImplementation(
      ({ workspaceDir }: { workspaceDir: string }) => snapshots.get(workspaceDir),
    );
    const cfg = {
      agents,
      channels: { "research-chat": { enabled: true } },
      plugins: {
        allow: ["research-chat-plugin"],
        entries: { "research-chat-plugin": { enabled: true } },
      },
    };
    const context = createConfigIoContext({ env: {}, observe: false });
    const loader = context.createValidationPluginMetadataSnapshotLoader({
      env: {},
    });
    loader.load(cfg);
    const snapshot = loader.getSnapshot();

    expect(snapshot?.index.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "primary",
      "research-chat-plugin",
    ]);
    expect(snapshot?.registryIndex).toEqual(snapshots.get(path.resolve("/srv/ops"))?.registryIndex);
    expect(snapshot?.registryIndex.plugins.map((plugin) => plugin.pluginId)).toEqual(["primary"]);
    expect(snapshot?.registryDiagnostics).toEqual([secondaryDiagnostic]);
    expect(snapshot?.plugins).toEqual(mergedRegistry.plugins);
    expect(structuredClone(snapshot?.manifestRegistry)).toEqual(mergedRegistry);
    expect(snapshot?.index.plugins.find((plugin) => plugin.pluginId === "primary")?.enabled).toBe(
      false,
    );
    expect(snapshot?.byPluginId.get("research-chat-plugin")).toBe(secondary);
    expect(snapshot?.owners.channels.get("research-chat")).toEqual(["research-chat-plugin"]);
    expect(snapshot?.discovery?.candidates.map((candidate) => candidate.workspaceDir)).toEqual([
      path.resolve("/srv/ops"),
      path.resolve("/srv/research"),
    ]);
    expect(snapshot?.discovery?.candidates.map(resolvePluginCandidateInstallOwner)).toEqual([
      "primary",
      "research-chat-plugin",
    ]);
    expect(Object.isFrozen(snapshot?.index.plugins)).toBe(true);
    expect(loader.getSnapshot()).toBe(snapshot);
    expect(
      resolveReadOnlyChannelPluginsForConfig(cfg, {
        env: {},
        metadataSnapshot: snapshot,
      }).plugins.map((plugin) => plugin.id),
    ).toContain("research-chat");
  });

  it("preserves shared source order and rejects conflicting IDs throughout the inventory", () => {
    const primary = manifestRecord("primary", "/srv/ops/primary");
    const shared = manifestRecord("shared", "/plugins/shared");
    const secondary = manifestRecord("secondary", "/srv/research/secondary");
    const snapshots = new Map([
      [
        path.resolve("/srv/ops"),
        workspaceSnapshot(path.resolve("/srv/ops"), [
          primary,
          shared,
          manifestRecord("conflict", "/srv/ops/conflict"),
        ]),
      ],
      [
        path.resolve("/srv/research"),
        workspaceSnapshot(path.resolve("/srv/research"), [
          secondary,
          shared,
          manifestRecord("conflict", "/srv/research/conflict"),
        ]),
      ],
    ]);
    mocks.resolvePluginMetadataSnapshotInput.mockImplementation(
      ({ workspaceDir }: { workspaceDir: string }) => snapshots.get(workspaceDir),
    );

    const snapshot = resolveConfigWidePluginMetadataSnapshot({ config: { agents }, env: {} });

    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["primary", "shared", "secondary"]);
    expect(snapshot.index.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "primary",
      "shared",
      "secondary",
    ]);
    expect(snapshot.discovery?.candidates.map((candidate) => candidate.idHint)).toEqual([
      "primary",
      "shared",
      "secondary",
    ]);
    expect(structuredClone(snapshot.manifestRegistry)).toEqual(snapshot.manifestRegistry);
    expect(
      structuredClone(
        resolveConfigWidePluginManifestRegistry({ config: { agents }, env: {}, pluginIds: [] }),
      ).plugins,
    ).toEqual([]);
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "conflict",
        message: expect.stringContaining("present in multiple agent workspaces"),
      }),
    );
  });
});
