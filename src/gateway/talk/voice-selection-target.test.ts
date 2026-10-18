import { afterEach, describe, expect, it } from "vitest";
import { resolveTalkSessionTargetInput } from "../session-sharing-target-input.js";
import { cleanupTalkConnection } from "./session-registry.js";
import {
  registerTalkVoiceSession,
  resolveTalkVoiceSessionTarget,
  unregisterTalkVoiceSession,
} from "./voice-selection.js";

const target = Object.freeze({
  agentId: "primary",
  sessionKey: "main",
  canonicalKey: "agent:primary:talk:gateway:direct:speech:original-connection",
  storePath: "/synthetic/sessions.sqlite",
});
const connId = "original-connection";
const voiceSessionId = "original-voice";
function register() {
  return registerTalkVoiceSession({
    voiceSessionId,
    connId,
    sessionTarget: target,
    selection: { provider: "synthetic", voices: [], canChange: false },
    launch: { provider: "synthetic" },
    providerReady: true,
  });
}
afterEach(() => {
  unregisterTalkVoiceSession(voiceSessionId, connId, target.agentId);
  cleanupTalkConnection(connId, {
    warn: (message) => {
      throw new Error(message);
    },
  });
});

describe("connection-owned Talk target retention", () => {
  it("keeps the original canonical branch for transcript/close without promoting the raw alias", () => {
    register();
    for (const method of ["talk.client.transcript", "talk.client.close"]) {
      const input = resolveTalkSessionTargetInput(
        method,
        { sessionKey: "main", voiceSessionId },
        connId,
      );
      expect(input).toMatchObject({ kind: "retained", purpose: "settlement", target });
      if (input?.kind !== "retained") {
        throw new Error("Missing original owner");
      }
      expect(input.target).toBe(target);
      expect(input.isCurrent()).toBe(true);
    }
  });
  it("retains identified native consult targets, without a settlement/input-policy exemption", () => {
    register();
    const input = resolveTalkSessionTargetInput(
      "talk.client.toolCall",
      { sessionKey: "main", voiceSessionId },
      connId,
    );
    expect(input).toMatchObject({ kind: "retained", target });
    expect(input).not.toHaveProperty("purpose");
  });
  it("requires the original connection, voice identity and matching caller alias", () => {
    register();
    for (const request of [
      { connId: "different", voiceSessionId, sessionKey: "main" },
      { connId, voiceSessionId: "different", sessionKey: "main" },
      { connId, voiceSessionId, sessionKey: "agent:primary:other" },
      { connId, sessionKey: "main" },
    ]) {
      expect(resolveTalkVoiceSessionTarget(request)).toBeUndefined();
    }
  });
  it("revokes captured metadata when its actual native owner is removed", () => {
    const release = register();
    const captured = resolveTalkVoiceSessionTarget({ connId, voiceSessionId, sessionKey: "main" });
    expect(captured?.isCurrent()).toBe(true);
    release();
    expect(captured?.isCurrent()).toBe(false);
    expect(resolveTalkVoiceSessionTarget({ connId, voiceSessionId })).toBeUndefined();
    expect(
      resolveTalkSessionTargetInput(
        "talk.client.transcript",
        {
          sessionKey: "main",
          voiceSessionId,
        },
        connId,
      ),
    ).toEqual({ kind: "request", sessionKey: "main", purpose: "settlement" });
  });
});
