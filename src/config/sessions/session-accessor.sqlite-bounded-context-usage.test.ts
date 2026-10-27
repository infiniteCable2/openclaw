import { expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  readSessionTranscriptBoundedActiveContextCore,
  readSessionTranscriptBoundedActiveContextUsageCore,
} from "./session-accessor.sqlite-active-context.js";
import {
  countAcquiredTranscriptPayloadBytes,
  withBoundedContextScope,
} from "./session-accessor.sqlite-bounded-context.test-support.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

it("sizes bounded context without acquiring message payloads, including header and cutoff budgets", async () => {
  await withBoundedContextScope(async (scope) => {
    const marker = "synthetic-context-sizing-payload:";
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("old", null, { role: "user", content: marker + "x".repeat(8192) }),
        transcriptMessage("new", "old", { role: "assistant", content: marker }),
      ],
      touchSessionEntry: false,
    });
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const full = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 16_384,
      maxEvents: 10,
    });
    const headerBytes = Buffer.byteLength(JSON.stringify(full.events[0])) + 1;
    for (const limits of [
      { maxBytes: 16_384, maxEvents: 10 },
      { maxBytes: 16_384, maxEvents: 1 },
      { maxBytes: 1024, maxEvents: 10 },
      { maxBytes: headerBytes, maxEvents: 10 },
    ]) {
      const context = readSessionTranscriptBoundedActiveContextCore(scope, limits);
      const acquiredBytes = countAcquiredTranscriptPayloadBytes(db, marker, () => {
        expect(readSessionTranscriptBoundedActiveContextUsageCore(scope, limits)).toEqual({
          eventCount: context.events.length,
          serializedBytes: context.serializedBytes,
          truncated: context.truncated,
        });
      });
      expect(acquiredBytes).toBe(0);
    }
    expect(() =>
      readSessionTranscriptBoundedActiveContextUsageCore(scope, {
        maxBytes: headerBytes - 1,
        maxEvents: 10,
      }),
    ).toThrow(RangeError);
  });
});
