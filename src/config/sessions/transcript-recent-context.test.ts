// Recent-context readers keep canonical history distinct from supplemental delivery context.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import { CRON_DIRECT_DELIVERY_CONTEXT_KIND } from "../../shared/transcript-only-openclaw-assistant.js";
import { resolveSessionTranscriptPathInDir } from "./paths.js";
import {
  appendTranscriptEvent,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { transcriptMessage } from "./transcript-message.test-support.js";
import {
  appendAssistantMessageToSessionTranscript,
  readRecentUserAssistantTextForSession,
} from "./transcript.js";
import type { SessionEntry } from "./types.js";

type SessionEntryFixture = Partial<SessionEntry> & { channel?: string };

describe("readRecentUserAssistantTextForSession", () => {
  const fixture = useTempSessionsFixture("transcript-recent-context-test-");
  const sessionId = "test-session-id";
  const sessionKey = "agent:main:test-session";
  function createFixtureTranscriptScope() {
    return { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() };
  }

  function writeLegacyTranscriptFixture(params: {
    transcriptPath: string;
    message: { role: "user"; content: string; timestamp: number };
  }) {
    const entries = [
      {
        type: "session",
        version: 4,
        id: sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: fixture.sessionsDir(),
      },
      {
        type: "message",
        id: "legacy-message",
        parentId: null,
        timestamp: new Date(params.message.timestamp).toISOString(),
        message: params.message,
      },
    ];
    fs.writeFileSync(
      params.transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  }

  async function writeTranscriptStore(entry: SessionEntryFixture = {}) {
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath: fixture.storePath() },
      normalizeLegacySessionEntryDelivery({
        sessionId,
        chatType: "direct",
        updatedAt: 1,
        channel: "discord",
        ...entry,
      } as SessionEntry),
    );
  }

  async function writeTranscriptSessionEntry(params: {
    entry: SessionEntryFixture & Pick<SessionEntry, "sessionId">;
    sessionKey: string;
  }) {
    await replaceSessionEntry(
      { agentId: "main", sessionKey: params.sessionKey, storePath: fixture.storePath() },
      normalizeLegacySessionEntryDelivery({ updatedAt: 1, ...params.entry } as SessionEntry),
    );
  }

  it("resolves recent transcript context from session identity", async () => {
    await writeTranscriptStore();
    await persistSessionTranscriptTurn(createFixtureTranscriptScope(), {
      updateMode: "none",
      messages: [{ message: { role: "user", content: "from shared session", timestamp: 4_000 } }],
    });

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
        beforeTimestampMs: 5_000,
      }),
    ).resolves.toEqual([
      {
        id: expect.any(String),
        role: "user",
        text: "from shared session",
        timestamp: 4_000,
      },
    ]);
  });

  it("admits only marked Cron delivery context when explicitly requested", async () => {
    await writeTranscriptStore();
    await persistSessionTranscriptTurn(createFixtureTranscriptScope(), {
      updateMode: "none",
      messages: [
        { eventId: "user", message: { role: "user", content: "ordinary user" } },
        { eventId: "assistant", message: { role: "assistant", content: "ordinary assistant" } },
      ],
    });
    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      text: "scheduled result",
      idempotencyKey: "cron-delivery",
      deliveryMirror: { kind: CRON_DIRECT_DELIVERY_CONTEXT_KIND },
    });
    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      text: "ordinary delivery mirror",
      idempotencyKey: "channel-delivery",
      deliveryMirror: { kind: "channel-final" },
    });
    const params = {
      agentId: "main",
      sessionKey,
      storePath: fixture.storePath(),
      limit: 10,
    };

    await expect(readRecentUserAssistantTextForSession(params)).resolves.toEqual([
      expect.objectContaining({ role: "user", text: "ordinary user" }),
      expect.objectContaining({ role: "assistant", text: "ordinary assistant" }),
    ]);
    await expect(
      readRecentUserAssistantTextForSession({
        ...params,
        includeCronDirectDeliveryContext: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ role: "user", text: "ordinary user" }),
      expect.objectContaining({ role: "assistant", text: "ordinary assistant" }),
      expect.objectContaining({ role: "assistant", text: "scheduled result" }),
    ]);
    await expect(
      readRecentUserAssistantTextForSession({
        ...params,
        includeCronDirectDeliveryContext: true,
        onlyCronDirectDeliveryContext: true,
      }),
    ).resolves.toEqual([expect.objectContaining({ role: "assistant", text: "scheduled result" })]);
    await persistSessionTranscriptTurn(createFixtureTranscriptScope(), {
      updateMode: "none",
      messages: [
        { eventId: "later-user", message: { role: "user", content: "later ordinary user" } },
      ],
    });
    await expect(
      readRecentUserAssistantTextForSession({
        ...params,
        limit: 1,
        includeCronDirectDeliveryContext: true,
        onlyCronDirectDeliveryContext: true,
      }),
    ).resolves.toEqual([]);
  });

  it.each(["compaction", "reset"] as const)(
    "does not restore ordinary history across a native %s boundary",
    async (boundaryType) => {
      await writeTranscriptStore();
      const scope = createFixtureTranscriptScope();
      await persistSessionTranscriptTurn(scope, {
        updateMode: "none",
        messages: [
          transcriptMessage("old-user", null, {
            role: "user",
            content: "original already owned by model history",
            timestamp: 1_000,
          }),
          transcriptMessage("old-assistant", "old-user", {
            role: "assistant",
            content: "original assistant answer",
            timestamp: 2_000,
          }),
          transcriptMessage("excluded-user", "old-assistant", {
            role: "user",
            content: "explicitly excluded original",
            excludeFromContext: true,
            timestamp: 3_000,
          }),
        ],
      });
      await appendTranscriptEvent(scope, {
        type: boundaryType,
        id: "native-boundary",
        parentId: "excluded-user",
        timestamp: new Date(4_000).toISOString(),
        ...(boundaryType === "compaction"
          ? { summary: "Native summary", firstKeptEntryId: "native-boundary", tokensBefore: 100 }
          : { reason: "new" }),
      });
      await appendAssistantMessageToSessionTranscript({
        sessionKey,
        storePath: fixture.storePath(),
        text: "new scheduled delivery",
        idempotencyKey: "post-boundary-cron",
        deliveryMirror: { kind: CRON_DIRECT_DELIVERY_CONTEXT_KIND },
      });
      await expect(
        readRecentUserAssistantTextForSession({
          agentId: "main",
          sessionKey,
          storePath: fixture.storePath(),
          includeCronDirectDeliveryContext: true,
          onlyCronDirectDeliveryContext: true,
          limit: 10,
        }),
      ).resolves.toEqual([
        expect.objectContaining({ role: "assistant", text: "new scheduled delivery" }),
      ]);
      const originals = await loadTranscriptEvents(scope);
      expect(originals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "old-user" }),
          expect.objectContaining({ id: "old-assistant" }),
          expect.objectContaining({ id: "excluded-user" }),
          expect.objectContaining({ id: "native-boundary" }),
        ]),
      );
    },
  );

  it("reads recent context only from the active transcript branch", async () => {
    await writeTranscriptStore();
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      {
        updateMode: "none",
        messages: [
          transcriptMessage("root-user", null, {
            role: "user",
            content: "keep this branch",
            timestamp: 1_000,
          }),
          transcriptMessage("active-reply", "root-user", {
            role: "assistant",
            content: "active answer",
            timestamp: 2_000,
          }),
          transcriptMessage("abandoned-reply", "root-user", {
            role: "assistant",
            content: "abandoned answer",
            timestamp: 3_000,
          }),
        ],
      },
    );
    await appendTranscriptEvent(
      { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      { type: "leaf", id: "active-leaf", parentId: "abandoned-reply", targetId: "active-reply" },
    );

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
      }),
    ).resolves.toEqual([]);
    const databasePath = resolveSqliteTargetFromSessionStorePath(fixture.storePath(), {
      agentId: "main",
    }).path;
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: databasePath });

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
      }),
    ).resolves.toEqual([
      { id: "root-user", role: "user", text: "keep this branch", timestamp: 1_000 },
      { id: "active-reply", role: "assistant", text: "active answer", timestamp: 2_000 },
    ]);

    const futureMessages = Array.from({ length: 260 }, (_, index) => ({
      eventId: `future-${index}`,
      parentId: index === 0 ? "active-reply" : `future-${index - 1}`,
      message: { role: "user" as const, content: `future ${index}`, timestamp: 10_000 + index },
    }));
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      { updateMode: "none", messages: futureMessages },
    );
    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
        beforeTimestampMs: 2_500,
        limit: 2,
      }),
    ).resolves.toEqual([
      { id: "root-user", role: "user", text: "keep this branch", timestamp: 1_000 },
      { id: "active-reply", role: "assistant", text: "active answer", timestamp: 2_000 },
    ]);
  });

  it("rejects a session key scoped to a different agent", async () => {
    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey: "agent:worker:main",
        storePath: fixture.storePath(),
      }),
    ).rejects.toMatchObject({
      code: "SESSION_TRANSCRIPT_AGENT_SCOPE_MISMATCH",
      name: "SessionTranscriptAgentScopeMismatchError",
    });
  });

  it("resolves an unscoped main alias with the configured agent owner", async () => {
    const mainSessionKey = "agent:main:main";
    await writeTranscriptSessionEntry({ entry: { sessionId }, sessionKey: mainSessionKey });
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey: mainSessionKey, storePath: fixture.storePath() },
      {
        updateMode: "none",
        messages: [{ message: { role: "user", content: "from main alias", timestamp: 4_000 } }],
      },
    );

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey: "main",
        storePath: fixture.storePath(),
        beforeTimestampMs: 5_000,
      }),
    ).resolves.toEqual([
      {
        id: expect.any(String),
        role: "user",
        text: "from main alias",
        timestamp: 4_000,
      },
    ]);
  });

  it("prefers SQLite transcript rows for recent context from session identity", async () => {
    await writeTranscriptStore();
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    writeLegacyTranscriptFixture({
      transcriptPath: sessionFile,
      message: { role: "user", content: "stale jsonl context", timestamp: 1_000 },
    });
    await persistSessionTranscriptTurn(createFixtureTranscriptScope(), {
      updateMode: "none",
      messages: [
        {
          message: { role: "user", content: "sqlite identity context", timestamp: 4_000 },
        },
      ],
    });

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
        beforeTimestampMs: 5_000,
      }),
    ).resolves.toEqual([
      {
        id: expect.any(String),
        role: "user",
        text: "sqlite identity context",
        timestamp: 4_000,
      },
    ]);
  });

  it("does not fall back to stale JSONL when SQLite rows are outside the recent window", async () => {
    await writeTranscriptStore();
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    writeLegacyTranscriptFixture({
      transcriptPath: sessionFile,
      message: { role: "user", content: "stale jsonl context", timestamp: 1_000 },
    });
    await persistSessionTranscriptTurn(createFixtureTranscriptScope(), {
      updateMode: "none",
      messages: [
        {
          message: { role: "user", content: "sqlite future context", timestamp: 10_000 },
        },
      ],
    });

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
        beforeTimestampMs: 5_000,
      }),
    ).resolves.toEqual([]);
  });

  it("does not fall back to stale JSONL when SQLite has no transcript rows", async () => {
    await writeTranscriptStore({
      sessionFile: `sqlite:main:${sessionId}:${fixture.storePath()}`,
    });
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    writeLegacyTranscriptFixture({
      transcriptPath: sessionFile,
      message: { role: "user", content: "stale jsonl context", timestamp: 1_000 },
    });

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
        beforeTimestampMs: 5_000,
      }),
    ).resolves.toEqual([]);
  });

  it("ignores stored session files outside the sessions directory for recent context", async () => {
    // openclaw-temp-dir: allow verifies the reader refuses a raw external transcript path
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-outside-"));
    try {
      const outsideFile = path.join(outsideDir, "outside.jsonl");
      await writeTranscriptStore({ sessionFile: outsideFile });
      writeLegacyTranscriptFixture({
        transcriptPath: outsideFile,
        message: { role: "user", content: "outside text", timestamp: 1_000 },
      });
      const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
      writeLegacyTranscriptFixture({
        transcriptPath: sessionFile,
        message: { role: "user", content: "contained text", timestamp: 2_000 },
      });
      await persistSessionTranscriptTurn(createFixtureTranscriptScope(), {
        updateMode: "none",
        messages: [{ message: { role: "user", content: "sqlite text", timestamp: 2_500 } }],
      });

      await expect(
        readRecentUserAssistantTextForSession({
          agentId: "main",
          sessionKey,
          storePath: fixture.storePath(),
          beforeTimestampMs: 3_000,
        }),
      ).resolves.toEqual([
        {
          id: expect.any(String),
          role: "user",
          text: "sqlite text",
          timestamp: 2_500,
        },
      ]);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
