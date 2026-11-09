import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
// mock-isolation: Supply exact persisted row facts without opening the Gateway session database.
vi.mock("../session-utils.js", () => ({ loadGatewaySessionEntryReadOnlyInWorker: mocks.load }));

import { assertCronDoesNotTargetAgentHarness } from "./cron-input-validation.js";

describe("cron creation conversation target validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { sessionTarget: "current", sessionKey: "agent:example:main" },
    { sessionTarget: "isolated", sessionKey: "agent:example:main" },
    { sessionTarget: "session:agent:example:main" },
    { sessionTarget: "main" },
  ])("rejects persisted headless roots even after mode opt-out (%j)", async (target) => {
    const cfg: OpenClawConfig = {};
    mocks.load.mockResolvedValue({
      cfg,
      agentId: "example",
      canonicalKey: "agent:example:main",
      entry: {
        sessionId: "root-session",
        updatedAt: 1,
        conversationTopology: { version: 1, role: "root" },
      },
    });
    await expect(
      assertCronDoesNotTargetAgentHarness({ agentId: "example", ...target }, cfg),
    ).rejects.toThrow("consolidating conversation root");
  });

  it("does not materialize a missing branch-mode root as a scheduled target", async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { example: { conversationMode: "branches" } } },
    };
    const sessionKey = "agent:example:internal:conversation-root";
    mocks.load.mockResolvedValue({ cfg, agentId: "example", canonicalKey: sessionKey });
    await expect(
      assertCronDoesNotTargetAgentHarness(
        { agentId: "example", sessionTarget: `session:${sessionKey}` },
        cfg,
      ),
    ).rejects.toThrow("reserves its internal root for consolidation");
    mocks.load.mockResolvedValue({ cfg, agentId: "example", canonicalKey: "agent:example:main" });
    await expect(
      assertCronDoesNotTargetAgentHarness({ agentId: "example", sessionTarget: "main" }, cfg),
    ).resolves.toBeUndefined();
  });

  it("does not apply a source harness lock to an independent isolated task", async () => {
    const cfg: OpenClawConfig = {};
    const sessionKey = "agent:example:conversation";
    mocks.load.mockResolvedValue({
      cfg,
      agentId: "example",
      canonicalKey: sessionKey,
      entry: { sessionId: "source-session", updatedAt: 1, modelSelectionLocked: true },
    });
    await expect(
      assertCronDoesNotTargetAgentHarness(
        { agentId: "example", sessionTarget: "isolated", sessionKey },
        cfg,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertCronDoesNotTargetAgentHarness(
        { agentId: "example", sessionTarget: `session:${sessionKey}` },
        cfg,
      ),
    ).rejects.toThrow("session identity is locked");
  });
});
