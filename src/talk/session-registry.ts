import { randomUUID } from "node:crypto";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { SpeechSessionHandle } from "./speech/types.js";

/** Storage identity is private metadata, never a capability or an external address. */
export type TalkSessionStorageTarget = Readonly<{
  agentId: string;
  sessionKey: string;
  canonicalKey: string;
  storePath: string;
}>;

export type TalkConnectionPresentation = Readonly<{
  kind: "call" | "assistant" | "browser";
  channel: string;
  label: string;
  readTarget: Readonly<{ agentId: string; sessionKey: string; sessionId?: string }>;
  input: Readonly<{ audio: boolean; video?: boolean; text?: boolean }>;
  output: Readonly<{ audio: boolean }>;
  /** Existing native operations only; descriptions do not grant the operation. */
  operations: readonly ("current-turn-reply" | "steer" | "cancel-output")[];
  state(): "preparing" | "ready" | "closed";
  /** The actual transport/source incarnation, independently of cleanup custody. */
  assertCurrent(): void;
}>;

export type TalkSpeechRelayRecord = {
  kind: "speech-relay";
  id: string;
  connId: string;
  sessionTarget: TalkSessionStorageTarget;
  appendAudio(audioBase64: string): void;
  acknowledgeMark(markName: string): void;
  cancelOutput: SpeechSessionHandle["cancelOutput"];
  steer: SpeechSessionHandle["steer"];
  close(): Promise<void>;
};

export type UnifiedTalkSessionRecord = (
  | {
      kind: "realtime-relay";
      connId: string;
      relaySessionId: string;
      sessionTarget: TalkSessionStorageTarget;
    }
  | { kind: "transcription-relay"; connId: string; transcriptionSessionId: string }
  | { kind: "managed-room"; handoffId: string; roomId: string }
  | { kind: "external-speech" }
  | TalkSpeechRelayRecord
) & { presentation?: TalkConnectionPresentation; presentationRef?: string };

// The existing native Talk registry remains the sole process-local session owner.
const unifiedTalkSessions = resolveGlobalMap<string, UnifiedTalkSessionRecord>(
  Symbol.for("openclaw.unifiedTalkSessions"),
  "close-and-restart",
);

export function rememberUnifiedTalkSession(sessionId: string, session: UnifiedTalkSessionRecord) {
  unifiedTalkSessions.set(sessionId, session);
}

export function getUnifiedTalkSession(sessionId: string): UnifiedTalkSessionRecord {
  const session = unifiedTalkSessions.get(sessionId);
  if (!session) throw new Error("Unknown Talk session");
  return session;
}

export function findUnifiedTalkSession(sessionId: string): UnifiedTalkSessionRecord | undefined {
  return unifiedTalkSessions.get(sessionId);
}

export function forgetUnifiedTalkSession(sessionId: string): void {
  unifiedTalkSessions.delete(sessionId);
}

/** Connection cleanup consumes this owner's records, not a shadow session inventory. */
export function listUnifiedTalkSessions(): readonly UnifiedTalkSessionRecord[] {
  return [...unifiedTalkSessions.values()];
}

/** Publish metadata on the real session; shared Speech adapters do not create a second registry. */
export function publishTalkConnectionPresentation(
  sessionId: string,
  presentation: TalkConnectionPresentation,
): () => void {
  presentation.assertCurrent();
  const current = unifiedTalkSessions.get(sessionId);
  if (current?.presentation) throw new Error("Talk session presentation already has an owner");
  const session: UnifiedTalkSessionRecord = current ?? { kind: "external-speech" };
  session.presentation = presentation;
  session.presentationRef = `talk_${randomUUID().replaceAll("-", "")}`;
  unifiedTalkSessions.set(sessionId, session);
  return () => {
    if (unifiedTalkSessions.get(sessionId) !== session || session.presentation !== presentation) {
      return;
    }
    delete session.presentation;
    delete session.presentationRef;
    if (session.kind === "external-speech") unifiedTalkSessions.delete(sessionId);
  };
}

/** Private selected facts; callers must authorize the exact read target before presentation. */
export function selectTalkConnectionPresentations() {
  return [...unifiedTalkSessions.entries()].flatMap(([sessionId, session]) => {
    const presentation = session.presentation;
    const connectionRef = session.presentationRef;
    if (!presentation || !connectionRef) return [];
    const assertCurrent = () => {
      if (
        unifiedTalkSessions.get(sessionId) !== session ||
        session.presentation !== presentation ||
        session.presentationRef !== connectionRef
      ) {
        throw new Error("Talk session presentation was replaced");
      }
      presentation.assertCurrent();
      if (presentation.state() === "closed") throw new Error("Talk output is closed");
    };
    try {
      assertCurrent();
      return [{ connectionRef, presentation, assertCurrent }];
    } catch {
      return [];
    }
  });
}
