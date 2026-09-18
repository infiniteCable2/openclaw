import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

type ForkSessionEntryFromParent =
  typeof import("../auto-reply/reply/session-fork.js").forkSessionEntryFromParent;
export type ForkSessionEntryFromParentParams = Parameters<ForkSessionEntryFromParent>[0];
export type ForkSessionEntryFromParentResult = Awaited<ReturnType<ForkSessionEntryFromParent>>;

const sessionForkMocks = vi.hoisted(() => ({
  forkSessionEntryFromParent: vi.fn<ForkSessionEntryFromParent>(),
}));

export { sessionForkMocks };

vi.mock("../auto-reply/reply/session-fork.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/reply/session-fork.js")>();
  return {
    ...actual,
    forkSessionEntryFromParent: sessionForkMocks.forkSessionEntryFromParent,
  };
});

let testTempDir: string | undefined;

export function testTempPath(name: string): string {
  if (!testTempDir) {
    throw new Error("Expected an isolated consult runtime test directory");
  }
  return path.join(testTempDir, name);
}

export function createAgentRuntime(payloads: unknown[] = [{ text: "Speak this." }]) {
  const sessionStore: Record<
    string,
    {
      sessionId?: string;
      updatedAt?: number;
      createdVia?: SessionEntry["createdVia"];
      createdActor?: SessionEntry["createdActor"];
      createdAt?: number;
      sandbox?: SessionEntry["sandbox"];
      archivedAt?: number;
      sessionFile?: string;
      spawnedBy?: string;
      agentHarnessId?: string;
      modelSelectionLocked?: boolean;
      forkedFromParent?: boolean;
      totalTokens?: number;
      delivery?: SessionEntry["delivery"];
      permissionMode?: SessionEntry["permissionMode"];
      toolOverrides?: SessionEntry["toolOverrides"];
    }
  > = {};
  const runEmbeddedAgent = vi.fn(async (_params?: RunEmbeddedAgentParams) => ({
    payloads,
    meta: {},
  }));
  const updateSessionStore = vi.fn(
    async (
      _storePath: string,
      mutator: (store: Record<string, { sessionId?: string; updatedAt?: number }>) => unknown,
    ) => {
      return await mutator(sessionStore);
    },
  );
  const getSessionEntry = vi.fn(
    (params: { sessionKey: string }) => sessionStore[params.sessionKey],
  );
  const patchSessionEntry = vi.fn(
    async (params: {
      sessionKey: string;
      fallbackEntry?: Record<string, unknown>;
      update: (
        entry: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
    }) => {
      const existing = sessionStore[params.sessionKey] ?? params.fallbackEntry;
      if (!existing) {
        return null;
      }
      const patch = await params.update({ ...existing });
      if (!patch) {
        return existing;
      }
      const next = { ...existing, ...patch };
      sessionStore[params.sessionKey] = next;
      return next;
    },
  );
  const upsertSessionEntry = vi.fn(
    async (params: { sessionKey: string; entry: Record<string, unknown> }) => {
      sessionStore[params.sessionKey] = { ...params.entry };
    },
  );
  return {
    runtime: {
      resolveAgentDir: vi.fn(() => testTempPath("agent")),
      resolveAgentWorkspaceDir: vi.fn(() => testTempPath("workspace")),
      ensureAgentWorkspace: vi.fn(async () => {}),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      session: {
        resolveStorePath: vi.fn(() => testTempPath("sessions.json")),
        loadSessionStore: vi.fn(() => sessionStore),
        saveSessionStore: vi.fn(async () => {}),
        updateSessionStore,
        getSessionEntry,
        patchSessionEntry,
        upsertSessionEntry,
        resolveSessionFilePath: vi.fn(
          (_sessionId: string, entry?: { sessionFile?: string }) =>
            entry?.sessionFile ?? testTempPath("session.json"),
        ),
      },
      runEmbeddedAgent,
    },
    runEmbeddedAgent,
    sessionStore,
  };
}

export function requireEmbeddedAgentCall(runEmbeddedAgent: {
  mock: { calls: unknown[][] };
}): RunEmbeddedAgentParams {
  const [call] = runEmbeddedAgent.mock.calls;
  if (!call) {
    throw new Error("Expected embedded OpenClaw agent call");
  }
  const [params] = call;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Expected embedded OpenClaw agent params to be an object");
  }
  return params as RunEmbeddedAgentParams;
}

export function useConsultRuntimeTestHooks() {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      sessionForkMocks.forkSessionEntryFromParent.mockReset();
      const tempDir = testTempDir;
      testTempDir = undefined;
      if (tempDir) {
        closeOpenClawAgentDatabaseByPath(path.join(tempDir, "openclaw-agent.sqlite"));
        clientVoiceSessionTesting.reset();
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
      envSnapshot.restore();
      cleanup();
    }),
  );
  beforeEach(async () => {
    sessionForkMocks.forkSessionEntryFromParent.mockImplementation(async (params) => {
      const actual = await vi.importActual<typeof import("../auto-reply/reply/session-fork.js")>(
        "../auto-reply/reply/session-fork.js",
      );
      return await actual.forkSessionEntryFromParent(params);
    });
    testTempDir = tempDirs.make("openclaw-talk-consult-");
    setTestEnvValue("OPENCLAW_STATE_DIR", testTempDir);
  });
}
