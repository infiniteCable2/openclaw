import { resolveGlobalSingleton } from "./global-singleton.js";

type ToolBindings = Readonly<Record<string, unknown>> | undefined;

const identities = resolveGlobalSingleton(Symbol.for("openclaw.hostToolBindingIdentities"), () => ({
  keys: new WeakMap<object, number>(),
  nextId: 1,
}));

/** Admit immutable host capabilities, not caller-supplied JSON, into native tool binding snapshots. */
export function registerHostToolBinding(value: object): void {
  if (!Object.isFrozen(value)) {
    throw new Error("Host tool bindings must be immutable");
  }
  if (!identities.keys.has(value)) {
    identities.keys.set(value, identities.nextId++);
  }
}

function hostIdentity(value: unknown): number | undefined {
  return typeof value === "object" && value !== null ? identities.keys.get(value) : undefined;
}

/** Clone ordinary policy data; retain only explicitly admitted live capabilities and their guards. */
export function snapshotToolBindings(bindings: ToolBindings): ToolBindings {
  if (bindings === undefined) {
    return undefined;
  }
  const entries = Object.entries(bindings);
  const snapshot: Record<string, unknown> = structuredClone(
    Object.fromEntries(entries.filter(([, value]) => hostIdentity(value) === undefined)),
  );
  for (const [key, value] of entries) {
    if (hostIdentity(value) !== undefined) {
      Object.defineProperty(snapshot, key, { value, enumerable: true });
    }
  }
  return snapshot;
}

/** Identity is for grouping, never authority. Host methods still enforce their owning lifecycle. */
export function describeToolBindings(bindings: ToolBindings): unknown {
  return bindings === undefined
    ? undefined
    : Object.keys(bindings)
        .sort()
        .map((key) => {
          const value = bindings[key];
          const id = hostIdentity(value);
          return id === undefined ? [key, "data", value] : [key, "host", id];
        });
}
