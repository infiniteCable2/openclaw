import { describe, expect, it } from "vitest";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import type { DeepReadonly } from "./readonly.js";
import {
  cloneRuntimeConfigSnapshot,
  collectEnvSecretRefIds,
  copyConfigResolutionFactsThroughRewrite,
  createConfigResolutionFacts,
  getAuthoredConfigSecretRef,
  getConfigResolutionFacts,
  getResolvedConfigEnvSecretRef,
  hasUnresolvedConfigPath,
  setConfigResolutionFacts,
} from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("owned runtime config copy", () => {
  it("makes frozen readonly config independently writable without selecting a global source", () => {
    const source: DeepReadonly<OpenClawConfig> = freezeJsonSnapshot({
      tools: { allow: ["read"] },
      bindings: [{ agentId: "primary", match: { channel: "matrix" } }],
    });
    const copied = cloneRuntimeConfigSnapshot(source);
    expect(copied).toEqual(source);
    expect(copied).not.toBe(source);
    expect(copied.tools?.allow).not.toBe(source.tools?.allow);
    expect(copied.bindings?.[0]).not.toBe(source.bindings?.[0]);
    copied.tools?.allow?.push("write");
    copied.bindings?.splice(0, 1);
    expect(source.tools?.allow).toEqual(["read"]);
    expect(source.bindings).toHaveLength(1);
    expect(Object.isFrozen(source.tools?.allow)).toBe(true);
    expect(cloneRuntimeConfigSnapshot(source)).toEqual(source);
  });

  it.each([false, true])("retains authoritative empty resolution facts: %s", (resolved) => {
    const source = { hooks: { token: "${LITERAL_NOT_A_REFERENCE}" } };
    if (resolved) {
      setConfigResolutionFacts(source, createConfigResolutionFacts([]));
    }
    const copied = cloneRuntimeConfigSnapshot(source);
    expect(getConfigResolutionFacts(copied)).toBe(getConfigResolutionFacts(source));
    expect(collectEnvSecretRefIds(copied)).toEqual(
      resolved ? new Set() : new Set(["LITERAL_NOT_A_REFERENCE"]),
    );
  });

  it("retains pending and resolved environment provenance from the supplied source", () => {
    const source = {
      hooks: { token: "${PENDING_TOKEN}" },
      env: { vars: { EXAMPLE: "resolved literal" } },
    };
    setConfigResolutionFacts(
      source,
      createConfigResolutionFacts(
        [{ configPath: "hooks.token", varName: "PENDING_TOKEN" }],
        new Map([["hooks.token", "PENDING_TOKEN"]]),
        "default",
        new Map([["env.vars.EXAMPLE", "RESOLVED_TOKEN"]]),
      ),
    );
    const copied = cloneRuntimeConfigSnapshot(source);
    expect(hasUnresolvedConfigPath(copied, "hooks.token")).toBe(true);
    expect(getAuthoredConfigSecretRef(copied, "hooks.token")?.id).toBe("PENDING_TOKEN");
    expect(getResolvedConfigEnvSecretRef(copied, "env.vars.EXAMPLE")?.id).toBe("RESOLVED_TOKEN");
    expect(collectEnvSecretRefIds(copied)).toEqual(new Set(["PENDING_TOKEN", "RESOLVED_TOKEN"]));
    expect(getConfigResolutionFacts(copied)).toBe(getConfigResolutionFacts(source));
  });
});

describe("resolution facts through config rewrites", () => {
  const array = () => ({ items: [{ key: "value" }] });
  const record = () => ({ items: { "0": { key: "value" } } });
  it.each<[string, string, object, object, boolean]>([
    ["array item", "items[0].key", array(), array(), true],
    ["array changed to record", "items[0].key", array(), record(), false],
    ["record changed to array", 'items["0"].key', record(), array(), false],
    ["two missing paths", "missing", {}, {}, false],
    ["undefined own values", "key", { key: undefined }, { key: undefined }, true],
    ["removed undefined value", "key", { key: undefined }, {}, false],
    ["inherited source", "key", Object.create({ key: "value" }), { key: "value" }, false],
    ["inherited target", "key", { key: "value" }, Object.create({ key: "value" }), false],
    ["sparse arrays", "items[0]", { items: Array(1) }, { items: Array(1) }, false],
    ["malformed path", "items[0]tail", { items: ["value"] }, { items: ["value"] }, false],
    [
      "blocked path",
      "constructor.key",
      { constructor: { key: "value" } },
      { constructor: { key: "value" } },
      false,
    ],
  ])("handles %s without retaining stale provenance", (_name, path, source, target, survives) => {
    setConfigResolutionFacts(
      source,
      createConfigResolutionFacts([], new Map(), "default", new Map([[path, "REWRITE_KEY"]])),
    );
    copyConfigResolutionFactsThroughRewrite(source, target);
    expect(getResolvedConfigEnvSecretRef(target, path)?.id ?? null).toBe(
      survives ? "REWRITE_KEY" : null,
    );
    expect(collectEnvSecretRefIds(target)).toEqual(new Set(survives ? ["REWRITE_KEY"] : []));
    expect(collectEnvSecretRefIds(source)).toEqual(new Set(["REWRITE_KEY"]));
    expect(getConfigResolutionFacts(target)).not.toBeNull();
  });

  it("carries pending references and invalidates their unresolved-path facts together", () => {
    const source = { keep: "${PENDING_KEEP}", drop: "${PENDING_DROP}" };
    const pending = new Map([
      ["keep", "PENDING_KEEP"],
      ["drop", "PENDING_DROP"],
    ]);
    setConfigResolutionFacts(
      source,
      createConfigResolutionFacts(
        [...pending].map(([configPath, varName]) => ({ configPath, varName })),
        pending,
      ),
    );
    const target = { keep: source.keep };
    copyConfigResolutionFactsThroughRewrite(source, target);
    expect(hasUnresolvedConfigPath(target, "keep")).toBe(true);
    expect(hasUnresolvedConfigPath(target, "drop")).toBe(false);
    expect(getAuthoredConfigSecretRef(target, "keep")?.id).toBe("PENDING_KEEP");
    expect(getAuthoredConfigSecretRef(target, "drop")).toBeNull();
  });

  it("clears target facts when the source has no authoritative resolution", () => {
    const target = { key: "value" };
    setConfigResolutionFacts(
      target,
      createConfigResolutionFacts([], new Map(), "default", new Map([["key", "OLD_KEY"]])),
    );
    copyConfigResolutionFactsThroughRewrite({ key: "value" }, target);
    expect(getConfigResolutionFacts(target)).toBeNull();
  });
});
