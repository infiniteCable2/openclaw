import { expect, it } from "vitest";
import { captureRuntimeConfigWithSource } from "./runtime-config-capture-state.js";
import { createRuntimeConfigSnapshotMatcher } from "./runtime-config-snapshot-match.js";
import type { OpenClawConfig } from "./types.openclaw.js";

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
