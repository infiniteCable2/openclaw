import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeObservedClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
  observeClientVoiceConfirmationRun,
  deactivateClientVoiceConfirmationSession,
} from "./client-voice-confirmation.js";
import {
  noteClientVoiceConfirmationUtteranceForTest as noteUtterance,
  resetClientVoiceConfirmationStateForTest,
} from "./client-voice-confirmation.test-support.js";

const scope = { agentId: "main", voiceSessionId: "voice-language" };

function block(language?: string) {
  return checkClientVoiceToolConfirmationPolicy({
    ...scope,
    runId: "blocked",
    toolName: "message",
    toolParams: { action: "send", message: "hello" },
    language,
  });
}

describe("spoken confirmation language", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });
  afterEach(() => {
    resetClientVoiceConfirmationStateForTest();
    vi.useRealTimers();
  });

  it.each(["Ja!", "ja, bitte", "bestätigen", "mach es", "in Ordnung"])(
    "accepts explicit German confirmation: %s",
    (text) => {
      block("de-DE");
      noteUtterance({ ...scope, text, timestamp: 1001 });
      expect(authorizeObservedClientVoiceConfirmation(scope)).toBeDefined();
    },
  );

  it.each([
    "nein",
    "ja, nicht machen",
    "ja, auf keinen Fall",
    "bitte abbrechen",
    "vielleicht",
    "ja und sende noch etwas",
    "yes",
  ])("does not grant a German challenge for: %s", (text) => {
    block("de-DE");
    noteUtterance({ ...scope, text, timestamp: 1001 });
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeUndefined();
  });

  it.each([undefined, "en-US", "fr-FR"])("keeps English fallback for %s", (language) => {
    block(language);
    noteUtterance({ ...scope, text: "ja", timestamp: 1001 });
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeUndefined();
    noteUtterance({ ...scope, text: "yes", timestamp: 1002 });
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeDefined();
  });

  it("keeps a challenge's language through retries and reports its expiry in that language", () => {
    const observation = observeClientVoiceConfirmationRun({ ...scope, runId: "blocked" });
    const first = block("de-DE");
    expect(first).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("nicht ausgeführt"),
    });
    expect(observation.readReply()).toContain('"ja"');
    expect(observation.readReply()).toContain('"nein"');
    expect(block("en")).toEqual(first);
    noteUtterance({ ...scope, text: "Ja.", timestamp: 1001 });
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeDefined();
    deactivateClientVoiceConfirmationSession(scope.agentId, scope.voiceSessionId, ["blocked"]);
    expect(observation.readReply()).toContain("neue Anfrage");
    observation.release();
  });

  it("cancels a German challenge on persisted refusal even after affirmative speech", () => {
    block("de-DE");
    noteUtterance({ ...scope, text: "ja", timestamp: 1001 });
    noteUtterance({ ...scope, text: "nein, doch nicht", timestamp: 1002 });
    expect(authorizeObservedClientVoiceConfirmation(scope)).toBeUndefined();
  });
});
