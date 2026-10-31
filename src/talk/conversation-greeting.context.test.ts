import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

it("detaches only recent greeting cues from a large source without truncating its history", async () => {
  await withOpenClawTestState({ label: "bounded-greeting-context" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "greeting-source",
      sessionKey: "agent:main:greeting-source",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(target);
    for (let i = 0; i < 32; i++) {
      await source.appendMessageAsync(makeUserMessage(`older-${i}: ${"x".repeat(96 * 1024)}`, i));
    }
    for (let i = 0; i < 16; i++) {
      await source.appendMessageAsync(makeUserMessage(`recent greeting cue ${i}`, 100 + i));
    }
    await waitForSessionTranscriptProjection(target);
    const before = source.getPersistedEntries();
    const started = performance.now();
    const truncated = vi.fn();
    const detached = await SessionManager.openDetachedBoundedAsync(target, {
      maxBytes: 32 * 1024,
      maxEvents: 16,
      onTruncated: truncated,
    });
    const elapsedMs = Math.round(performance.now() - started);
    const context = detached.buildSessionContext();
    expect(truncated).toHaveBeenCalledOnce();
    expect(detached.isPersisted()).toBe(false);
    expect(context.messages.length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(context.messages)).not.toContain("older-");
    expect(JSON.stringify(context.messages)).toContain("recent greeting cue 15");
    await detached.appendMessageAsync(makeUserMessage("unplayed detached greeting", 200));
    await source.reloadPersistedTranscriptAsync();
    expect(source.getPersistedEntries()).toEqual(before);
    console.info(
      JSON.stringify({
        scenario: "bounded-greeting-context",
        sourceMessages: 48,
        sourceTextBytesAtLeast: 32 * 96 * 1024,
        detachedMessages: context.messages.length,
        detachedContextBytes: Buffer.byteLength(JSON.stringify(context.messages)),
        elapsedMs,
        sourceHistoryUnchanged: true,
      }),
    );
  });
});
