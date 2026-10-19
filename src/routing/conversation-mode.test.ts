import { describe, expect, it } from "vitest";
import { resolveSessionRoutingContract } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertExternalConversationTarget,
  resolveAgentConversationRoute,
  resolveAgentSpeechConversationRoute,
} from "./conversation-mode.js";
import { resolveAgentRoute, resolveInboundLastRouteSessionKey } from "./resolve-route.js";

function config(conversationMode?: "native" | "branches"): OpenClawConfig {
  return {
    agents: { entries: { researcher: { conversationMode } } },
    session: { dmScope: "main", groupScope: "main" },
  };
}

function route(cfg: OpenClawConfig, peerId = "person-a", accountId = "default") {
  return resolveAgentRoute({
    cfg,
    channel: "matrix",
    accountId,
    peer: { kind: "direct", id: peerId },
  });
}

describe("agent conversation routing", () => {
  it("uses a direct non-task audio branch while preserving native source routing", () => {
    const input = {
      agentId: "researcher",
      channel: "matrix",
      accountId: "primary",
      sourceSessionKey: "agent:researcher:matrix:room:source",
      conversationId: "call-one",
    };
    expect(
      resolveAgentSpeechConversationRoute({ ...input, cfg: config("native") }).sessionKey,
    ).toBe(input.sourceSessionKey);
    const branch = resolveAgentSpeechConversationRoute({ ...input, cfg: config("branches") });
    expect(branch.sessionKey).not.toContain(":subagent:");
    expect(branch.sessionKey).not.toBe(branch.rootSessionKey);
    expect(branch.sessionKey).not.toBe(input.sourceSessionKey);
    expect(
      resolveAgentSpeechConversationRoute({
        ...input,
        cfg: config("branches"),
        conversationId: "call-two",
      }).sessionKey,
    ).not.toBe(branch.sessionKey);
    expect(() =>
      resolveAgentSpeechConversationRoute({
        ...input,
        cfg: config("branches"),
        conversationId: " ",
      }),
    ).toThrow("connection identity");
  });
  it.each([undefined, "native", "branches"] as const)(
    "does not recycle a persisted headless root as external conversation after mode %s",
    (mode) => {
      const target = {
        cfg: config(mode),
        agentId: "researcher",
        sessionKey: "agent:researcher:retained-root",
        isSystemEvent: false,
        entry: {
          sessionId: "root",
          updatedAt: 1,
          conversationTopology: { version: 1, role: "root" } as const,
        },
      };
      expect(() => assertExternalConversationTarget(target)).toThrow("Explicitly migrate");
      expect(() =>
        assertExternalConversationTarget({ ...target, isSystemEvent: true }),
      ).not.toThrow();
    },
  );
  it("rejects external root overrides at final admission while preserving native and internal targets", () => {
    const cfg = config("branches");
    const target = {
      cfg,
      agentId: "researcher",
      sessionKey: "agent:researcher:internal:conversation-root",
      isSystemEvent: false,
    };
    expect(() => assertExternalConversationTarget(target)).toThrow(
      "reserves its internal root for consolidation",
    );
    expect(() =>
      assertExternalConversationTarget({ ...target, sessionKey: "internal:conversation-root" }),
    ).toThrow("reserves its internal root for consolidation");
    expect(() =>
      assertExternalConversationTarget({
        ...target,
        sessionKey: "agent:other:internal:conversation-root",
      }),
    ).not.toThrow();
    expect(() =>
      assertExternalConversationTarget({
        ...target,
        sessionKey: "agent:researcher:matrix:default:direct:peer",
      }),
    ).not.toThrow();
    expect(() =>
      assertExternalConversationTarget({ ...target, cfg: config("native") }),
    ).not.toThrow();
    expect(() =>
      assertExternalConversationTarget({ ...target, isSystemEvent: true }),
    ).not.toThrow();
    expect(() =>
      assertExternalConversationTarget({
        ...target,
        cfg: { ...cfg, session: { mainKey: "consolidation" } },
        sessionKey: "agent:researcher:consolidation",
      }),
    ).not.toThrow();
    expect(() =>
      assertExternalConversationTarget({ ...target, sessionKey: "agent:researcher:main" }),
    ).not.toThrow();
    expect(() =>
      assertExternalConversationTarget({
        ...target,
        cfg: { ...cfg, session: { scope: "global" } },
        sessionKey: "global",
      }),
    ).toThrow("cannot be global");
  });
  it.each([undefined, "native"] as const)("preserves native routing for %s", (mode) => {
    expect(route(config(mode))).toMatchObject({
      agentId: "researcher",
      sessionKey: "agent:researcher:main",
      mainSessionKey: "agent:researcher:main",
      lastRoutePolicy: "main",
      dmScope: "main",
    });
  });

  it("keeps external peers and accounts separate but gives the agent one root", () => {
    const cfg = config("branches");
    const first = route(cfg);
    const otherPerson = route(cfg, "person-b");
    const otherAccount = route(cfg, "person-a", "secondary");
    expect(first).toMatchObject({
      sessionKey: "agent:researcher:matrix:default:direct:person-a",
      mainSessionKey: "agent:researcher:main",
      lastRoutePolicy: "session",
      dmScope: "per-account-channel-peer",
    });
    expect(new Set([first.sessionKey, otherPerson.sessionKey, otherAccount.sessionKey]).size).toBe(
      3,
    );
    expect(otherPerson.mainSessionKey).toBe(first.mainSessionKey);
    expect(otherAccount.mainSessionKey).toBe(first.mainSessionKey);
    expect(resolveInboundLastRouteSessionKey({ route: first, sessionKey: first.sessionKey })).toBe(
      first.sessionKey,
    );
    expect(first).not.toHaveProperty("spawnedBy");
  });

  it("keeps a custom native main separate across branch and native mode changes", () => {
    const cfg = config("branches");
    cfg.session = { ...cfg.session, mainKey: "primary" };
    const input = {
      cfg,
      agentId: "researcher",
      channel: "matrix",
      accountId: "default",
      peer: { kind: "direct" as const, id: "person-a" },
      dmScope: "main" as const,
      groupScope: "main" as const,
    };
    expect(resolveAgentConversationRoute(input).rootSessionKey).toBe(
      "agent:researcher:internal:conversation-root",
    );
    expect(route(cfg)).toMatchObject({
      mainSessionKey: "agent:researcher:primary",
      sessionKey: "agent:researcher:matrix:default:direct:person-a",
    });
    cfg.agents = config("native").agents;
    expect(route(cfg).sessionKey).toBe("agent:researcher:primary");
    expect(resolveAgentConversationRoute(input).rootSessionKey).toBe("agent:researcher:primary");
    cfg.session.mainKey = "internal:conversation-root";
    expect(route(cfg).sessionKey).toBe("agent:researcher:internal:conversation-root");
    cfg.agents = config("branches").agents;
    expect(() => route(cfg)).toThrow("collides with the reserved internal conversation root");
  });

  it("keeps linked identity normalization without merging histories across channel defaults", () => {
    const cfg = config("branches");
    cfg.session = {
      ...cfg.session,
      identityLinks: { member: ["matrix:person-a", "telegram:12345"] },
    };
    const matrix = route(cfg);
    const telegram = resolveAgentRoute({
      cfg,
      channel: "telegram",
      peer: { kind: "direct", id: "12345" },
    });
    expect(matrix.sessionKey).toBe("agent:researcher:matrix:default:direct:member");
    expect(telegram.sessionKey).toBe("agent:researcher:telegram:default:direct:member");
    expect(telegram.mainSessionKey).toBe(matrix.mainSessionKey);
  });

  it("selects mode after agent bindings and does not let a main-scope override expose the root", () => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { researcher: { conversationMode: "branches" }, writer: {} },
      },
      bindings: [
        {
          type: "route",
          agentId: "researcher",
          match: { channel: "matrix", peer: { kind: "direct", id: "person-a" } },
          session: { dmScope: "main" },
        },
        { type: "route", agentId: "writer", match: { channel: "matrix" } },
      ],
    };
    expect(route(cfg)).toMatchObject({
      agentId: "researcher",
      sessionKey: "agent:researcher:matrix:default:direct:person-a",
    });
    expect(route(cfg, "person-b")).toMatchObject({
      agentId: "writer",
      sessionKey: "agent:writer:main",
      lastRoutePolicy: "main",
    });
  });

  it("preserves opaque room IDs while keeping rooms away from the root", () => {
    const cfg = config("branches");
    const group = resolveAgentRoute({
      cfg,
      channel: "matrix",
      peer: { kind: "group", id: "!RoomCase:example.org" },
    });
    expect(group).toMatchObject({
      sessionKey: "agent:researcher:matrix:group:!RoomCase:example.org",
      mainSessionKey: "agent:researcher:main",
      groupScope: "per-group",
      lastRoutePolicy: "session",
    });
  });

  it("refuses a shared global root instead of conflating branch-mode personas", () => {
    const cfg = config("branches");
    expect(route(cfg).lastRoutePolicy).toBe("session");
    cfg.session = { ...cfg.session, scope: "global" };
    expect(() => route(cfg)).toThrow("per-agent roots");
  });

  it("revalidates an in-place change to global scope before returning a warm branch route", () => {
    const session: NonNullable<OpenClawConfig["session"]> = { scope: "per-sender" };
    const cfg = { ...config("branches"), session };
    expect(route(cfg).lastRoutePolicy).toBe("session");
    session.scope = "global";
    expect(() => route(cfg)).toThrow("per-agent roots");
  });

  it.each([null, { kind: "direct" as const, id: " " }])(
    "refuses an unidentified default branch instead of collapsing into main (%j)",
    (peer) => {
      expect(() => resolveAgentRoute({ cfg: config("branches"), channel: "matrix", peer })).toThrow(
        "identified peer",
      );
    },
  );

  it("keeps native empty-channel identity normalization", () => {
    const cfg: OpenClawConfig = {
      session: { identityLinks: { member: ["unknown:person-a"] } },
    };
    expect(
      resolveAgentConversationRoute({
        cfg,
        agentId: "researcher",
        channel: " ",
        accountId: "default",
        peer: { kind: "direct", id: "person-a" },
        dmScope: "per-peer",
        groupScope: "per-group",
      }).sessionKey,
    ).toBe("agent:researcher:direct:member");
    expect(() =>
      resolveAgentRoute({
        cfg: config("branches"),
        channel: " ",
        peer: { kind: "direct", id: "a" },
      }),
    ).toThrow("requires a channel");
  });

  it("invalidates cached routes and captured routing contracts on agent mode replacement", () => {
    const cfg = config();
    const nativeContract = resolveSessionRoutingContract(cfg);
    expect(route(cfg).lastRoutePolicy).toBe("main");
    cfg.agents = config("branches").agents;
    expect(route(cfg).lastRoutePolicy).toBe("session");
    expect(resolveSessionRoutingContract(cfg)).not.toBe(nativeContract);
    cfg.agents = config("native").agents;
    expect(route(cfg).lastRoutePolicy).toBe("main");
    expect(resolveSessionRoutingContract(cfg)).toBe(nativeContract);
  });

  it("makes the mode contract independent of roster ordering", () => {
    const first: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          researcher: { conversationMode: "branches" },
          writer: { conversationMode: "branches" },
        },
      },
    };
    const second: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          writer: { conversationMode: "branches" },
          researcher: { conversationMode: "branches" },
        },
      },
    };
    expect(resolveSessionRoutingContract(first)).toBe(resolveSessionRoutingContract(second));
  });

  it("invalidates a warm route after an in-place mode edit", () => {
    const entry: { conversationMode?: "native" | "branches" } = {};
    const cfg: OpenClawConfig = { agents: { entries: { researcher: entry } } };
    const nativeContract = resolveSessionRoutingContract(cfg);
    expect(route(cfg).lastRoutePolicy).toBe("main");
    entry.conversationMode = "branches";
    expect(resolveSessionRoutingContract(cfg)).not.toBe(nativeContract);
    expect(route(cfg).lastRoutePolicy).toBe("session");
    entry.conversationMode = "native";
    expect(route(cfg).lastRoutePolicy).toBe("main");
    expect(resolveSessionRoutingContract(cfg)).toBe(nativeContract);
  });
});
