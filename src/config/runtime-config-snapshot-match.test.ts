import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createConfigResolutionFacts, setConfigResolutionFacts } from "./resolution-facts.js";
import {
  captureRuntimeConfigWithSource,
  getPublishedRuntimeConfigCapture,
} from "./runtime-config-capture-state.js";
import { createRuntimeConfigSnapshotMatcher } from "./runtime-config-snapshot-match.js";
import {
  clearRuntimeConfigSnapshot,
  createRuntimeConfigReader,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSourceSnapshotIfCurrent,
} from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.openclaw.js";

afterEach(() => clearRuntimeConfigSnapshot());

it("selects the existing capture of each native publication, including source rollback", () => {
  const config = { gateway: { port: 19001 } };
  const source = structuredClone(config);
  setRuntimeConfigSnapshot(config, source);
  const original = getPublishedRuntimeConfigCapture(config)!;
  expect(original).toBe(getRuntimeConfigSnapshot({ capture: true }));
  expect(getPublishedRuntimeConfigCapture(config)).toBe(original);
  const tentative = { gateway: { port: 19002 } };
  setRuntimeConfigSnapshot(tentative);
  expect(getPublishedRuntimeConfigCapture(config)).toBe(original);
  expect(getPublishedRuntimeConfigCapture(tentative)).toBe(
    getRuntimeConfigSnapshot({ capture: true }),
  );
  setRuntimeConfigSnapshot(config, source);
  const matches = createRuntimeConfigSnapshotMatcher(config);
  const changedSource = structuredClone(source);
  setConfigResolutionFacts(
    changedSource,
    createConfigResolutionFacts([], new Map([["gateway.port", "EXAMPLE_CHANGED_PORT"]])),
  );
  const publishSource = (value: OpenClawConfig) =>
    setRuntimeConfigSourceSnapshotIfCurrent({
      expectedRevision: getRuntimeConfigSnapshotMetadata()!.revision,
      sourceConfig: value,
    });
  expect(publishSource(changedSource)).toBe(true);
  const changed = getPublishedRuntimeConfigCapture(config)!;
  expect(changed).not.toBe(original);
  expect(matches(changed)).toBe(false);
  expect(publishSource(source)).toBe(true);
  expect(matches(getPublishedRuntimeConfigCapture(config)!)).toBe(true);
  expect(original).toEqual({ gateway: { port: 19001 } });
  config.gateway.port = 19003;
  setRuntimeConfigSnapshot(config, { gateway: { port: 19003 } });
  expect(getPublishedRuntimeConfigCapture(config)!.gateway!.port).toBe(19003);
});

it("does not reuse a former publication for a mutated no-op input or an opaque replacement", () => {
  const former = { gateway: { port: 19001 } };
  setRuntimeConfigSnapshot(former);
  const original = getPublishedRuntimeConfigCapture(former)!;
  const current = { gateway: { port: 19002 } };
  setRuntimeConfigSnapshot(current);
  former.gateway.port = 19002;
  setRuntimeConfigSnapshot(former);
  expect(getRuntimeConfigSnapshot()).toBe(current);
  expect(getPublishedRuntimeConfigCapture(former)).toBeUndefined();
  expect(getPublishedRuntimeConfigCapture({})).toBeUndefined();
  setRuntimeConfigSnapshot(Object.assign(current, { opaque: () => true }));
  expect(getPublishedRuntimeConfigCapture(current)).toBeUndefined();
  expect(original.gateway!.port).toBe(19001);
});

it("follows native publications as immutable captures while preserving scoped configuration", () => {
  const runtime = { gateway: { port: 19001 } };
  const scoped = { gateway: { port: 19002 } };
  setRuntimeConfigSnapshot(runtime);
  const nativeReader = createRuntimeConfigReader(runtime, { capture: true });
  const scopedReader = createRuntimeConfigReader(scoped, { capture: true });
  const initial = nativeReader();
  expect(initial).not.toBe(runtime);
  expect(nativeReader()).toBe(initial);
  expect(scopedReader()).toBe(scoped);
  const next = { gateway: { port: 19003 } };
  setRuntimeConfigSnapshot(next);
  expect(nativeReader()).toEqual(next);
  expect(nativeReader()).not.toBe(initial);
  expect(scopedReader()).toBe(scoped);
});

it("reuses immutable bytes across interleaved captures and compares each replacement", () => {
  const cfg = { gateway: { port: 19001 } };
  const matches = createRuntimeConfigSnapshotMatcher(cfg);
  const capture = captureRuntimeConfigWithSource(cfg, cfg);
  expect(matches(capture)).toBe(true);
  expect(matches(capture)).toBe(true);
  const equivalent = captureRuntimeConfigWithSource(cfg, cfg);
  expect(matches(equivalent)).toBe(true);
  const serialize = vi.spyOn(JSON, "stringify");
  onTestFinished(() => serialize.mockRestore());
  expect(matches(capture)).toBe(true);
  expect(matches(equivalent)).toBe(true);
  expect(serialize).not.toHaveBeenCalled();
  serialize.mockRestore();
  const changed = { gateway: { port: 19002 } };
  expect(matches(captureRuntimeConfigWithSource(changed, changed))).toBe(false);
  expect(matches(capture)).toBe(true);
});

it("rejects same-value native captures when their original resolution provenance changes", () => {
  const cfg = { gateway: { port: 19001 } };
  setConfigResolutionFacts(
    cfg,
    createConfigResolutionFacts([], new Map([["gateway.port", "EXAMPLE_PORT_A"]])),
  );
  const matches = createRuntimeConfigSnapshotMatcher(cfg);
  expect(matches(captureRuntimeConfigWithSource(cfg, cfg))).toBe(true);
  const changed = structuredClone(cfg);
  setConfigResolutionFacts(
    changed,
    createConfigResolutionFacts([], new Map([["gateway.port", "EXAMPLE_PORT_B"]])),
  );
  expect(changed).toEqual(cfg);
  expect(matches(captureRuntimeConfigWithSource(changed, changed))).toBe(false);
});

it.each([false, true])("does not retain mutable or shallow-frozen matches: %s", (freeze) => {
  const cfg: OpenClawConfig = { gateway: { port: 19001 } };
  const matches = createRuntimeConfigSnapshotMatcher(cfg);
  if (freeze) {
    Object.freeze(cfg);
  }
  expect(matches(cfg)).toBe(true);
  cfg.gateway!.port = 19002;
  expect(matches(cfg)).toBe(false);
});
