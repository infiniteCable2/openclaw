import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
// mock-isolation: Exact existing Gateway row resolution is the only database boundary;
// the native cron validator and conversation target policy remain real.
vi.mock("../session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: mocks.load }));

import { assertCronDoesNotTargetAgentHarness } from "./cron-input-validation.js";

describe("cron creation conversation target validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { sessionTarget: "current", sessionKey: "agent:example:main" },
    { sessionTarget: "isolated", sessionKey: "agent:example:main" },
    { sessionTarget: "session:agent:example:main" },
    { sessionTarget: "main" },
  ])("rejects persisted headless roots even after mode opt-out (%j)", (target) => {
    const cfg: OpenClawConfig = {};
    mocks.load.mockReturnValue({
      cfg,
      agentId: "example",
      canonicalKey: "agent:example:main",
      entry: {
        sessionId: "root-session",
        updatedAt: 1,
        conversationTopology: { version: 1, role: "root" },
      },
    });
    expect(() =>
      assertCronDoesNotTargetAgentHarness({ agentId: "example", ...target }, cfg),
    ).toThrow("consolidating conversation root");
  });

  it("does not materialize a missing branch-mode root as a scheduled target", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { example: { conversationMode: "branches" } } },
    };
    mocks.load.mockReturnValue({ cfg, agentId: "example", canonicalKey: "agent:example:main" });
    expect(() =>
      assertCronDoesNotTargetAgentHarness({ agentId: "example", sessionTarget: "main" }, cfg),
    ).toThrow("reserves main for consolidation");
  });

  it("does not apply a source harness lock to an independent isolated task", () => {
    const cfg: OpenClawConfig = {};
    const sessionKey = "agent:example:conversation";
    mocks.load.mockReturnValue({
      cfg,
      agentId: "example",
      canonicalKey: sessionKey,
      entry: { sessionId: "source-session", updatedAt: 1, modelSelectionLocked: true },
    });
    expect(() =>
      assertCronDoesNotTargetAgentHarness(
        { agentId: "example", sessionTarget: "isolated", sessionKey },
        cfg,
      ),
    ).not.toThrow();
    expect(() =>
      assertCronDoesNotTargetAgentHarness(
        { agentId: "example", sessionTarget: `session:${sessionKey}` },
        cfg,
      ),
    ).toThrow("session identity is locked");
  });
});
