import { vi } from "vitest";
import type { SessionManager } from "../sessions/session-manager.js";

export function createCompactionSessionManagerMock(messages: unknown[]) {
  const open = (target: Parameters<typeof SessionManager.open>[0]) => ({
    getSessionTarget: () => ({ ...target }),
    getTranscriptSnapshotVersion: vi.fn<SessionManager["getTranscriptSnapshotVersion"]>(),
    buildSessionContext: vi.fn(() => ({ messages })),
  });
  return {
    open: vi.fn(open),
    openAsync: vi.fn(async (target: Parameters<typeof SessionManager.openAsync>[0]) =>
      open(target),
    ),
  };
}
