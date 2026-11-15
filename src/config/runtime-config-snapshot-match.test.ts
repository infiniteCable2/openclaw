import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { createConfigResolutionFacts, setConfigResolutionFacts } from "./resolution-facts.js";
import { captureRuntimeConfigWithSource } from "./runtime-config-capture-state.js";
import {
  configSnapshotsMatch,
  createRuntimeConfigSnapshotMatcher,
  stableConfigStringify,
} from "./runtime-config-snapshot-match.js";
import {
  clearRuntimeConfigSnapshot,
  createRuntimeConfigReader,
  setRuntimeConfigSnapshot,
} from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.openclaw.js";

afterEach(() => clearRuntimeConfigSnapshot());

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

it("avoids temporary property-value arrays when comparing interleaved mutable configurations", () => {
  const cfg: OpenClawConfig = { gateway: { port: 19001 } };
  const other = structuredClone(cfg);
  const matches = createRuntimeConfigSnapshotMatcher(cfg);
  expect(matches(cfg)).toBe(true);
  const map = vi.spyOn(Array.prototype, "map");
  onTestFinished(() => map.mockRestore());
  let allMatched = true;
  for (let index = 0; index < 50; index++) {
    allMatched &&= matches(cfg) && matches(other);
  }
  const propertyArrayCount = map.mock.calls.length;
  map.mockRestore();
  expect(allMatched).toBe(true);
  expect(propertyArrayCount).toBe(0);
  other.gateway!.port = 19002;
  expect(matches(other)).toBe(false);
  expect(matches(cfg)).toBe(true);
  cfg.gateway!.port = 19003;
  expect(matches(cfg)).toBe(false);
});

it.each([
  [undefined, null],
  [-0, 0],
  [Number.NaN, null],
  [Number.POSITIVE_INFINITY, null],
])("preserves byte-equivalent fallback values: %s / %s", (leftValue, rightValue) => {
  const left: OpenClawConfig = {};
  const right: OpenClawConfig = {};
  Reflect.set(left, "edge", leftValue);
  Reflect.set(right, "edge", rightValue);
  expect(configSnapshotsMatch(freezeJsonSnapshot(left), right)).toBe(true);
});

it("retains serialization rejection for equal cyclic graphs and bigint values", () => {
  for (const cyclic of [false, true]) {
    const left: OpenClawConfig = {};
    const right: OpenClawConfig = {};
    Reflect.set(left, "edge", cyclic ? left : 1n);
    Reflect.set(right, "edge", cyclic ? right : 1n);
    expect(configSnapshotsMatch(freezeJsonSnapshot(left), right)).toBe(false);
  }
});

it("reads mutable accessors only through the existing serialization fallback", () => {
  const left = freezeJsonSnapshot({ gateway: { port: 19001 } });
  const readPort = vi.fn(() => 19001);
  const right = { gateway: Object.defineProperty({}, "port", { enumerable: true, get: readPort }) };
  expect(configSnapshotsMatch(left, right)).toBe(true);
  expect(readPort).toHaveBeenCalledTimes(1);
});

it("preserves sorted escaped keys and sparse array bytes", () => {
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[1] = undefined;
  expect(stableConfigStringify({ z: sparse, 'a"': { b: undefined, a: [] } })).toBe(
    '{"a\\\"":{"a":[],"b":null},"z":[,null]}',
  );
});
