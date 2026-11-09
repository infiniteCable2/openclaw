import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { recordDeliveredCommandExchange } from "../../plugin-sdk/session-transcript-runtime.js";
import { persistSessionTranscriptTurn, updateSessionEntry } from "./session-accessor.js";
import type { useTempSessionsFixture } from "./test-helpers.js";
import { createExactAssistantMessage } from "./transcript-message.test-support.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
  readRecentUserAssistantTextForSession,
} from "./transcript.js";
import type { InternalSessionEntry } from "./types.js";

export function createTranscriptAppendFixture(params: {
  sessionId: string;
  sessionKey: string;
  fixture: Pick<ReturnType<typeof useTempSessionsFixture>, "storePath">;
}) {
  const { sessionId, sessionKey, fixture } = params;
  function transcriptScope() {
    return { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() };
  }
  type FixtureAppend<P> = Omit<P, "sessionKey" | "storePath">;
  function appendMirror(
    text: string,
    params: Omit<
      FixtureAppend<Parameters<typeof appendAssistantMessageToSessionTranscript>[0]>,
      "text"
    > = {},
  ) {
    return appendAssistantMessageToSessionTranscript({
      text,
      sessionKey,
      storePath: fixture.storePath(),
      ...params,
    });
  }
  function appendExact(
    params: FixtureAppend<Parameters<typeof appendExactAssistantMessageToSessionTranscript>[0]>,
  ) {
    return appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      ...params,
    });
  }
  function persistMessages(
    messages: Parameters<typeof persistSessionTranscriptTurn>[1]["messages"],
  ) {
    return persistSessionTranscriptTurn(transcriptScope(), { updateMode: "none", messages });
  }
  function recentText(
    params: Partial<Parameters<typeof readRecentUserAssistantTextForSession>[0]> = {},
  ) {
    return readRecentUserAssistantTextForSession({
      agentId: "main",
      sessionKey,
      storePath: fixture.storePath(),
      ...params,
    });
  }
  function appendText(
    text: string,
    params: Omit<Parameters<typeof appendExact>[0], "message"> = {},
  ) {
    return appendExact({ ...params, message: createExactAssistantMessage({ text }) });
  }
  async function recordCommand(
    params: Omit<Parameters<typeof recordDeliveredCommandExchange>[0], "sessionKey" | "storePath">,
  ) {
    return recordDeliveredCommandExchange({
      sessionKey,
      storePath: fixture.storePath(),
      ...params,
    });
  }
  function startEntryChange(patch: Partial<InternalSessionEntry>) {
    const gate = createDeferred();
    const started = createDeferred();
    const change = updateSessionEntry(transcriptScope(), async () => {
      started.resolve();
      await gate.promise;
      return patch;
    });
    // Return retirement ownership before waiting: a missing entry never calls the updater.
    return {
      started: awaitGateBeforeSettlement(
        started.promise,
        change,
        "session entry change settled before its updater started",
      ),
      finish: () => {
        gate.resolve();
        return change;
      },
    };
  }
  return {
    transcriptScope,
    appendMirror,
    appendExact,
    persistMessages,
    recentText,
    appendText,
    recordCommand,
    startEntryChange,
  };
}
