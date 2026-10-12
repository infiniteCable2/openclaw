import { describe, expect, test } from "vitest";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentRoute } from "./resolve-route.js";

describe("explicit ownership with an ambient system agent", () => {
  const sender = { kind: "direct", id: "@alice:example.org" } as const;
  const room = { kind: "channel", id: "!personal:example.org" } as const;
  const cfg = {
    agents: {
      ownership: "explicit",
      entries: { personal: {}, ops: {} },
      defaults: { systemAgent: { agentId: "ops" } },
    },
    bindings: [sender, room].map((peer) => ({
      type: "route" as const,
      agentId: "personal",
      match: { channel: "matrix", accountId: "work", peer },
    })),
  } satisfies OpenClawConfig;

  test.each([
    { name: "sender", peer: sender },
    { name: "room", peer: room },
  ])("routes an exactly bound $name to its persona", ({ peer }) => {
    expect(resolveAgentRoute({ cfg, channel: "matrix", accountId: "work", peer })).toMatchObject({
      agentId: "personal",
      matchedBy: "binding.peer",
    });
  });

  test.each([
    {
      name: "sender",
      route: {
        channel: "matrix",
        accountId: "work",
        peer: { kind: "direct", id: "@unknown:example.org" },
      },
    },
    {
      name: "room",
      route: {
        channel: "matrix",
        accountId: "work",
        peer: { kind: "channel", id: "!unknown:example.org" },
      },
    },
    {
      name: "account",
      route: { channel: "matrix", accountId: "other", peer: sender },
    },
    {
      name: "channel",
      route: { channel: "telegram", accountId: "work", peer: sender },
    },
  ] as const)("rejects an unbound $name without falling back to the system agent", ({ route }) => {
    expect(() => resolveAgentRoute({ cfg, ...route })).toThrow(AgentSelectionRequiredError);
  });

  test("preserves a caller-owned route without treating the ambient owner as admission", () => {
    expect(
      resolveAgentRoute({
        cfg,
        channel: "matrix",
        accountId: "other",
        peer: sender,
        defaultAgentId: "personal",
      }),
    ).toMatchObject({ agentId: "personal", matchedBy: "default" });
  });

  test("preserves the sole-agent route for an explicit roster", () => {
    expect(
      resolveAgentRoute({
        cfg: { agents: { ownership: "explicit", entries: { personal: {} } } },
        channel: "matrix",
        peer: sender,
      }),
    ).toMatchObject({ agentId: "personal", matchedBy: "default" });
  });
});
