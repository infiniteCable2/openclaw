import { describe, expect, it } from "vitest";
import { resolveSessionRoutingContract } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConversationRoute } from "./conversation-mode.js";
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
