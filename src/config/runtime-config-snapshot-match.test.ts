import { afterEach, expect, it } from "vitest";
import { createConfigResolutionFacts, setConfigResolutionFacts } from "./resolution-facts.js";
import { captureRuntimeConfigWithSource } from "./runtime-config-capture-state.js";
import { createRuntimeConfigSnapshotMatcher } from "./runtime-config-snapshot-match.js";
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

it("retains successful immutable native captures and compares each replacement", () => {
  const cfg = { gateway: { port: 19001 } };
  const matches = createRuntimeConfigSnapshotMatcher(cfg);
  const capture = captureRuntimeConfigWithSource(cfg, cfg);
  expect(matches(capture)).toBe(true);
  expect(matches(capture)).toBe(true);
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
