import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveCanonicalMainSessionKey } from "./main-session-key.js";
import { resolveAgentMainSessionKey } from "./main-session.js";
import { resolveAgentConversationRootSessionKey } from "./session-conversation-root-key.js";

describe("internal conversation root identity", () => {
  it.each([undefined, "primary", "another-main"])(
    "normalizes the agent independently of native main %s",
    (mainKey) => {
      const cfg = { session: { mainKey } };
      expect(resolveAgentConversationRootSessionKey({ cfg, agentId: " Researcher " })).toBe(
        "agent:researcher:internal:conversation-root",
      );
      expect(resolveAgentMainSessionKey({ cfg, agentId: " Researcher " })).toBe(
        `agent:researcher:${mainKey ?? "main"}`,
      );
    },
  );

  it.each(["native", "branches"] as const)(
    "does not make scope or conversation mode %s part of the internal identity",
    (conversationMode) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { researcher: { conversationMode } } },
        session: { scope: "global", mainKey: "primary" },
      };
      expect(resolveAgentConversationRootSessionKey({ cfg, agentId: "researcher" })).toBe(
        "agent:researcher:internal:conversation-root",
      );
      expect(
        resolveCanonicalMainSessionKey({
          agentId: "researcher",
          mainKey: cfg.session?.mainKey,
          sessionScope: cfg.session?.scope,
        }),
      ).toBe("global");
    },
  );

  it.each(["internal:conversation-root", " INTERNAL:CONVERSATION-ROOT "])(
    "rejects the native main alias collision %s",
    (mainKey) => {
      expect(() =>
        resolveAgentConversationRootSessionKey({
          cfg: { session: { mainKey } },
          agentId: "researcher",
        }),
      ).toThrow("collides with the reserved internal conversation root");
    },
  );
});
