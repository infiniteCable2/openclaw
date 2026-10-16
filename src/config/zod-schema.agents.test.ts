import { describe, expect, it } from "vitest";
import { AgentsSchema } from "./zod-schema.agents.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("agent conversation mode", () => {
  it("keeps native global scope but rejects branch roots in a shared global session", () => {
    expect(
      OpenClawSchema.safeParse({
        session: { scope: "global" },
        agents: { entries: { researcher: {} } },
      }).success,
    ).toBe(true);
    const result = OpenClawSchema.safeParse({
      session: { scope: "global" },
      agents: {
        ownership: "explicit",
        entries: {
          researcher: { conversationMode: "branches" },
          writer: { conversationMode: "branches" },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["session", "scope"] }),
      );
    }
  });
  it.each([undefined, "native", "branches"] as const)(
    "preserves the optional per-agent mode without adding a default (%s)",
    (conversationMode) => {
      const entry = conversationMode === undefined ? {} : { conversationMode };
      const result = AgentsSchema.parse({ entries: { researcher: entry } });
      expect(result?.entries?.researcher).toEqual(entry);
    },
  );

  it.each(["hybrid", "main", "unknown", "", true, 1, null])(
    "rejects unsupported conversation mode %j at the agent entry",
    (conversationMode) => {
      const result = AgentsSchema.safeParse({ entries: { researcher: { conversationMode } } });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({ path: ["entries", "researcher", "conversationMode"] }),
        );
      }
    },
  );

  it("keeps the mode local to each agent instead of inheriting from defaults", () => {
    const result = AgentsSchema.parse({
      ownership: "explicit",
      entries: { researcher: { conversationMode: "branches" }, writer: {} },
    });
    expect(result?.entries?.researcher?.conversationMode).toBe("branches");
    expect(result?.entries?.writer).not.toHaveProperty("conversationMode");
    expect(
      AgentsSchema.safeParse({
        defaults: { conversationMode: "branches" },
        entries: { researcher: {} },
      }).success,
    ).toBe(false);
    expect(
      AgentsSchema.safeParse({ conversationMode: "branches", entries: { researcher: {} } }).success,
    ).toBe(false);
  });
});

describe("agent roster ownership", () => {
  it("rejects an empty roster after load-time migration", () => {
    expect(AgentsSchema.safeParse({ entries: {} }).success).toBe(false);
  });

  it("accepts sole and explicitly owned multi-agent rosters without a stored default", () => {
    expect(AgentsSchema.safeParse({ entries: { Ops: {} } }).success).toBe(true);
    expect(
      AgentsSchema.safeParse({ ownership: "explicit", entries: { alpha: {}, beta: {} } }).success,
    ).toBe(true);
  });

  it("rejects a markerless multi-agent roster without explicit ownership", () => {
    const result = AgentsSchema.safeParse({ entries: { alpha: {}, beta: {} } });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('agents.ownership="explicit"');
      expect(result.error.issues[0]?.message).toContain("run openclaw doctor");
    }
  });

  it("accepts one legacy default marker", () => {
    expect(
      AgentsSchema.safeParse({ entries: { alpha: { default: true }, beta: {} } }).success,
    ).toBe(true);
  });

  it("rejects multiple legacy default markers", () => {
    expect(
      AgentsSchema.safeParse({
        entries: { alpha: { default: true }, beta: { default: true } },
      }).success,
    ).toBe(false);
  });

  it("rejects entry keys that resolve to the same agent id", () => {
    const result = AgentsSchema.safeParse({
      ownership: "explicit",
      entries: { Ops: {}, ops: {} },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ["entries", "ops"],
        message:
          'agents.entries keys "Ops" and "ops" resolve to the same agent id "ops"; rename one key so each agent has a unique id',
      });
    }
  });

  it("rejects a legacy marker with explicit ownership", () => {
    expect(
      AgentsSchema.safeParse({
        ownership: "explicit",
        entries: { alpha: { default: true }, beta: {} },
      }).success,
    ).toBe(false);
  });
});

describe("explicit ambient agent targets", () => {
  it("rejects an unknown explicit target", () => {
    const result = OpenClawSchema.safeParse({
      agents: { defaults: { heartbeat: { agentId: "missing" } }, entries: { main: {} } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Unknown agent id");
    }
  });

  it("accepts configured heartbeat, system-agent, compatibility, and Talk targets", () => {
    expect(
      OpenClawSchema.safeParse({
        agents: {
          defaults: {
            heartbeat: { agentId: "ops" },
            systemAgent: { agentId: "ops" },
            authInheritance: { agentId: "ops" },
            sessionStore: { agentId: "ops" },
          },
          entries: { ops: {} },
        },
        talk: { agentId: "ops" },
      }).success,
    ).toBe(true);
  });

  it("validates targets against the implicit main roster", () => {
    expect(OpenClawSchema.safeParse({ talk: { agentId: "main" } }).success).toBe(true);
    expect(OpenClawSchema.safeParse({ talk: { agentId: "missing" } }).success).toBe(false);
  });

  it("allows upgrade compatibility owners to outlive their roster entries", () => {
    expect(
      OpenClawSchema.safeParse({
        agents: {
          ownership: "explicit",
          defaults: {
            authInheritance: { agentId: "retired-ops" },
            sessionStore: { agentId: "retired-ops" },
          },
          entries: { research: {}, writer: {} },
        },
      }).success,
    ).toBe(true);
  });
});

describe("agent GitHub sandbox identity", () => {
  const profileId = "ghp_0123456789abcdef0123456789abcdef";

  it.each([undefined, false, true])("accepts allowInSandbox=%s for one agent", (allowInSandbox) => {
    const github = { profileId, ...(allowInSandbox === undefined ? {} : { allowInSandbox }) };
    const result = AgentsSchema.safeParse({ entries: { release: { tools: { github } } } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.entries?.release?.tools?.github).toEqual(github);
    }
  });

  it.each(["true", 1, null])("rejects non-boolean allowInSandbox=%s", (allowInSandbox) => {
    const result = AgentsSchema.safeParse({
      entries: { release: { tools: { github: { profileId, allowInSandbox } } } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["entries", "release", "tools", "github", "allowInSandbox"],
        }),
      ]);
    }
  });

  it("rejects a global sandbox identity opt-in", () => {
    const result = OpenClawSchema.safeParse({
      tools: { github: { profileId, allowInSandbox: true } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ["tools", "github"], code: "unrecognized_keys" }),
      ]);
    }
  });
});
