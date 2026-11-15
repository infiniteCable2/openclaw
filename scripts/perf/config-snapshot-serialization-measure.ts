// Isolate the configuration-comparison hotspot; this is not a whole-Gateway benchmark.
// node --import ./scripts/tsx.mjs scripts/perf/config-snapshot-serialization-measure.ts
//   --output <new-file> --iterations 10000 --pairs 5
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { stableConfigStringify } from "../../src/config/runtime-config-snapshot-match.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    iterations: { type: "string", default: "10000" },
    pairs: { type: "string", default: "5" },
  },
});
assert(values.output, "Supply --output <new-file>");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 10000,
});
const pairs = parseStrictIntegerOption({ raw: values.pairs, label: "pairs", min: 5, fallback: 5 });

// Original serializer, kept only as a measurement reference. Both sides retain
// sorted keys, primitive encoding, array behavior, and identical returned bytes.
function baseline(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => baseline(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${baseline(record[key])}`)
    .join(",")}}`;
}

const workloads = [1, 40].map((count) => ({
  name: count === 1 ? "small" : "nested",
  config: {
    agents: {
      entries: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `synthetic-agent-${index}`,
          {
            model: "example/model",
            conversationMode: "branches",
            tools: { allow: ["message", "sessions_history"] },
          },
        ]),
      ),
    },
  },
}));
const records: {
  workload: string;
  pair: number;
  variant: string;
  wallMs: number;
  cpuUs: number;
  hostLoad: number[];
}[] = [];
for (const { name, config } of workloads) {
  const expected = baseline(config);
  assert.equal(stableConfigStringify(config), expected);
  for (const serialize of [baseline, stableConfigStringify]) {
    for (let index = 0; index < 1000; index++) {
      serialize(config);
    }
  }
  for (let pair = 0; pair < pairs; pair++) {
    for (const variant of ["base", "candidate"]) {
      const serialize = variant === "base" ? baseline : stableConfigStringify;
      const hostLoad = loadavg();
      const cpu = process.cpuUsage();
      const start = performance.now();
      let result = "";
      for (let index = 0; index < iterations; index++) {
        result = serialize(config);
      }
      const wallMs = performance.now() - start;
      const elapsedCpu = process.cpuUsage(cpu);
      assert.equal(result, expected);
      records.push({
        workload: name,
        pair,
        variant,
        wallMs,
        cpuUs: elapsedCpu.user + elapsedCpu.system,
        hostLoad,
      });
    }
  }
}
const summary = Object.fromEntries(
  workloads.map(({ name }) => [
    name,
    Object.fromEntries(
      ["base", "candidate"].map((variant) => {
        const rows = records.filter((row) => row.workload === name && row.variant === variant);
        const stats = (key: "wallMs" | "cpuUs") => {
          const sorted = rows.map((row) => row[key]).toSorted((a, b) => a - b);
          return {
            median:
              (sorted[Math.floor((sorted.length - 1) / 2)]! +
                sorted[Math.floor(sorted.length / 2)]!) /
              2,
            p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
            min: sorted[0],
            max: sorted.at(-1),
          };
        };
        return [variant, { wallMs: stats("wallMs"), cpuUs: stats("cpuUs") }];
      }),
    ),
  ]),
);
writeFileSync(values.output, JSON.stringify({ iterations, pairs, records, summary }), {
  flag: "wx",
});
console.log(JSON.stringify({ iterations, pairs, summary }));
