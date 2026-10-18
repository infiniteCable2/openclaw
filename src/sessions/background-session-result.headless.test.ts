import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry } from "../config/sessions/types.js";

const mocks = vi.hoisted(() => ({ load: vi.fn(), persist: vi.fn() }));
// mock-isolation: Supply exact row and append spies so the headless refusal cannot open a database.
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: mocks.load,
  persistSessionTranscriptTurn: mocks.persist,
}));
// mock-isolation: Lifecycle scheduling is inline so only target validation is under test.
vi.mock("./session-lifecycle-admission.js", () => ({
  getSessionWorkAdmissionRelease: () => undefined,
  runExclusiveSessionLifecycleMutation: (_reason: string, params: { run(): unknown }) =>
    params.run(),
}));

import { commitBackgroundResultToSession } from "./background-session-result.js";

describe("background completion headless target guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["native", "branches"] as const)(
    "does not prepare display content or append to a persisted root (mode=%s)",
    async (conversationMode) => {
      const entry: InternalSessionEntry = {
        sessionId: "root-session",
        lifecycleRevision: "root-revision",
        updatedAt: 1,
        conversationTopology: { version: 1, role: "root" },
      };
      mocks.load.mockReturnValue(entry);
      const prepareDisplayContent = vi.fn();
      await expect(
        commitBackgroundResultToSession({
          agentId: "example",
          sessionKey: "agent:example:main",
          expectedGeneration: {
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
          },
          text: "Scheduled result",
          prepareDisplayContent,
          idempotencyKey: "cron-result:example",
          provenance: { kind: "cron", jobId: "example-job", runId: "example-run" },
          config: { agents: { entries: { example: { conversationMode } } } },
        }),
      ).rejects.toThrow("consolidating conversation root");
      expect(prepareDisplayContent).not.toHaveBeenCalled();
      expect(mocks.persist).not.toHaveBeenCalled();
    },
  );
});
