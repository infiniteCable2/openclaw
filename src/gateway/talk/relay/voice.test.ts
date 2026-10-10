import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../../../infra/sqlite-worker-contract.js";
import { createClientVoiceConfirmationReadiness } from "../../../talk/client-voice-confirmation-readiness.js";
import { captureClientVoiceSessionSettlement } from "../../../talk/client-voice-session-lifecycle.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../../../talk/voice-transcript.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { RelaySession } from "./state.js";
import { closeRelayVoiceSession, enqueueRelayVoiceTranscript } from "./voice.js";

const voiceSessionMocks = vi.hoisted(() => ({
  appendRelayVoiceTranscript: vi.fn(),
  closeRelayVoiceSessionRecord: vi.fn(),
  createOrResumeClientVoiceSession: vi.fn(),
}));

// The durable writer boundary supplies failures; queue admission, settlement,
// accepted-prefix barriers and relay close ownership remain native.
vi.mock("../../../talk/client-voice-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/client-voice-session.js")>()),
  ...voiceSessionMocks,
}));

function createRelaySession(): {
  session: RelaySession;
  failSession: ReturnType<typeof vi.fn>;
} {
  const failSession = vi.fn(() => {
    void closeRelayVoiceSession(session);
  });
  const session = {
    id: "relay-voice-bounded",
    sessionTarget: {
      agentId: "main",
      sessionKey: "main",
      canonicalKey: "agent:main:work",
      storePath: "/tmp/relay-voice-sessions.sqlite",
    },
    provider: "openai",
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    },
    confirmationReadiness: createClientVoiceConfirmationReadiness({
      agentId: "main",
      voiceSessionId: "relay-voice-bounded",
      flushTranscript: async () => await session.voiceTranscriptQueue.flush(),
    }),
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue(),
    failSession,
  } as unknown as RelaySession;
  return { session, failSession };
}

describe("realtime relay voice transcript persistence", () => {
  beforeEach(() => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockReset();
    voiceSessionMocks.closeRelayVoiceSessionRecord.mockReset().mockResolvedValue(undefined);
    voiceSessionMocks.createOrResumeClientVoiceSession.mockReset();
  });

  it("joins its accepted prefix after close settlement admission is lost", async () => {
    await withOpenClawTestState({ scenario: "minimal", label: "relay-close-refusal" }, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const append = createDeferred();
      voiceSessionMocks.appendRelayVoiceTranscript.mockReturnValue(append.promise);
      const { session } = createRelaySession();
      const entryError = new Error("relay queue entry refused");
      const enqueue = vi
        .spyOn(session.voiceTranscriptQueue, "enqueue")
        .mockImplementationOnce(() => {
          throw entryError;
        });
      try {
        expect(() => enqueueRelayVoiceTranscript(session, "user", "not accepted")).toThrow(
          entryError,
        );
      } finally {
        enqueue.mockRestore();
      }
      expect(session.voiceTranscriptSeq).toBe(0);
      expect(enqueueRelayVoiceTranscript(session, "user", "accepted")).toBe(true);
      const accepted = captureClientVoiceSessionSettlement();
      const close = accepted.run(() =>
        AsyncLocalStorage.bind(() => closeRelayVoiceSession(session)),
      );
      accepted.release();
      const closing = close();
      let settled = false;
      void closing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();
        append.resolve();
        await expect(closing).rejects.toThrow();
        expect(session.voiceTranscriptQueue.isIdle).toBe(true);
        expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();
      } finally {
        append.resolve();
        await closing.catch(() => {});
        vi.useRealTimers();
      }
    });
  });

  it("bounds stalled finals, drains the accepted prefix, and closes once", async () => {
    const firstAppend = createDeferred();
    voiceSessionMocks.appendRelayVoiceTranscript.mockImplementation(
      async ({ entryId }: { entryId: string }) => {
        if (entryId === "1") {
          await firstAppend.promise;
        }
      },
    );
    const { session, failSession } = createRelaySession();
    let accepted = enqueueRelayVoiceTranscript(session, "user", `  ${"x".repeat(9_000)}  `) ? 1 : 0;

    for (let index = 0; index < 10_000; index += 1) {
      expect(enqueueRelayVoiceTranscript(session, "user", " \t\n ")).toBe(true);
    }

    for (let index = 1; index < 10_000; index += 1) {
      if (
        enqueueRelayVoiceTranscript(
          session,
          index % 2 === 0 ? "user" : "assistant",
          `  ${"x".repeat(9_000)}  `,
        )
      ) {
        accepted += 1;
      }
    }

    expect(accepted).toBe(41);
    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledOnce();
    expect(voiceSessionMocks.appendRelayVoiceTranscript.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "main",
        sessionTarget: {
          sessionKey: "agent:main:work",
          storePath: "/tmp/relay-voice-sessions.sqlite",
        },
      }),
    );
    expect(failSession).toHaveBeenCalledOnce();
    const close = session.voiceSessionClose;
    expect(close).toBeDefined();
    expect(closeRelayVoiceSession(session)).toBe(close);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();

    firstAppend.resolve();
    await close;

    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledTimes(41);
    expect(
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.map(
        ([params]) => (params as { entryId: string }).entryId,
      ),
    ).toEqual(Array.from({ length: 41 }, (_, index) => String(index + 1)));
    expect(
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.every(
        ([params]) => (params as { text: string }).text.length === 8_000,
      ),
    ).toBe(true);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledOnce();
    expect(enqueueRelayVoiceTranscript(session, "user", "too late")).toBe(false);
  });

  it("retries a definite close-record failure without replaying its accepted transcript", async () => {
    await withOpenClawTestState({ scenario: "minimal", label: "relay-close-retry" }, async () => {
      const failure = new Error("close record refused before commit");
      voiceSessionMocks.appendRelayVoiceTranscript.mockResolvedValue(undefined);
      voiceSessionMocks.closeRelayVoiceSessionRecord
        .mockRejectedValueOnce(failure)
        .mockResolvedValue(undefined);
      const { session } = createRelaySession();
      expect(enqueueRelayVoiceTranscript(session, "user", "Accepted before close.")).toBe(true);
      const first = closeRelayVoiceSession(session);
      expect(closeRelayVoiceSession(session)).toBe(first);
      await expect(first).rejects.toBe(failure);
      expect(session.voiceSessionClose).toBeUndefined();
      const retried = closeRelayVoiceSession(session);
      expect(retried).not.toBe(first);
      expect(closeRelayVoiceSession(session)).toBe(retried);
      await retried;
      expect(session.voiceSessionClose).toBe(retried);
      expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledOnce();
      expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledTimes(2);
      expect(voiceSessionMocks.createOrResumeClientVoiceSession).toHaveBeenCalledOnce();
    });
  });

  it.each(["definite", "unknown"])(
    "never reports a successful close when required voice record creation has a %s failure",
    async (kind) => {
      await withOpenClawTestState(
        { scenario: "minimal", label: "relay-close-create-failure" },
        async () => {
          const failure =
            kind === "unknown"
              ? new SqliteWorkerError("Voice creation outcome unknown", "outcome-unknown")
              : new Error("Voice record creation refused");
          voiceSessionMocks.createOrResumeClientVoiceSession.mockImplementationOnce(() => {
            throw failure;
          });
          const { session } = createRelaySession();
          const first = closeRelayVoiceSession(session);
          await expect(first).rejects.toBe(failure);
          expect(session.voiceSessionCreated).toBe(false);
          expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();
          if (kind === "unknown") {
            expect(closeRelayVoiceSession(session)).toBe(first);
            await expect(closeRelayVoiceSession(session)).rejects.toBe(failure);
            expect(voiceSessionMocks.createOrResumeClientVoiceSession).toHaveBeenCalledOnce();
          } else {
            expect(session.voiceSessionClose).toBeUndefined();
            await closeRelayVoiceSession(session);
            expect(session.voiceSessionCreated).toBe(true);
            expect(voiceSessionMocks.createOrResumeClientVoiceSession).toHaveBeenCalledTimes(2);
            expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledOnce();
          }
        },
      );
    },
  );

  it.each(["cause", "aggregate"])(
    "retains a %s-wrapped unknown close outcome and never retries the native write",
    async (envelope) => {
      await withOpenClawTestState(
        { scenario: "minimal", label: "relay-close-unknown" },
        async () => {
          const unknown = new SqliteWorkerError("Close receipt was lost", "outcome-unknown");
          const failure =
            envelope === "cause"
              ? new Error("close owner failed", { cause: unknown })
              : new AggregateError(
                  [new Error("cleanup also failed"), unknown],
                  "close owner failed",
                );
          voiceSessionMocks.closeRelayVoiceSessionRecord.mockRejectedValueOnce(failure);
          const { session } = createRelaySession();
          const closing = closeRelayVoiceSession(session);
          await expect(closing).rejects.toBe(failure);
          expect(session.voiceSessionClose).toBe(closing);
          expect(closeRelayVoiceSession(session)).toBe(closing);
          await expect(closeRelayVoiceSession(session)).rejects.toBe(failure);
          expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledOnce();
        },
      );
    },
  );

  it("refuses successful close after an accepted transcript fails and does not replay that prefix", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "relay-prefix-close-failure" },
      async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const failure = new Error("accepted transcript refused");
        voiceSessionMocks.appendRelayVoiceTranscript.mockRejectedValue(failure);
        const { session } = createRelaySession();
        try {
          expect(
            enqueueRelayVoiceTranscript(session, "user", "Must not be silently discarded."),
          ).toBe(true);
          const closing = closeRelayVoiceSession(session);
          const rejected = expect(closing).rejects.toBe(failure);
          // Only the native writer's documented definite-failure retry delays.
          await vi.advanceTimersByTimeAsync(2500);
          await rejected;
          expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledTimes(3);
          expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();
          await expect(closeRelayVoiceSession(session)).rejects.toBe(failure);
          expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledTimes(3);
          expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      },
    );
  });

  it("preserves unknown prefix custody even when close loses its native settlement admission", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "relay-prefix-close-lost-owner" },
      async () => {
        const append = createDeferred();
        voiceSessionMocks.appendRelayVoiceTranscript.mockReturnValue(append.promise);
        const { session } = createRelaySession();
        expect(enqueueRelayVoiceTranscript(session, "user", "Accepted before owner release.")).toBe(
          true,
        );
        const accepted = captureClientVoiceSessionSettlement();
        const close = accepted.run(() =>
          AsyncLocalStorage.bind(() => closeRelayVoiceSession(session)),
        );
        accepted.release();
        const closing = close();
        const failure = new SqliteWorkerError("Transcript outcome unknown", "outcome-unknown");
        append.reject(failure);
        await expect(closing).rejects.toBeInstanceOf(AggregateError);
        const observed = await closing.catch((error: unknown) => error);
        expect(hasSqliteWorkerOutcomeUnknown(observed)).toBe(true);
        expect(session.voiceSessionClose).toBe(closing);
        expect(closeRelayVoiceSession(session)).toBe(closing);
        expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledOnce();
        expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();
      },
    );
  });

  it("retains unknown accepted-prefix custody without closing the record or replaying its transcript", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "relay-prefix-close-unknown" },
      async () => {
        const failure = new SqliteWorkerError(
          "Transcript commit outcome unknown",
          "outcome-unknown",
        );
        voiceSessionMocks.appendRelayVoiceTranscript.mockRejectedValue(failure);
        const { session } = createRelaySession();
        expect(enqueueRelayVoiceTranscript(session, "user", "Possibly committed.")).toBe(true);
        const closing = closeRelayVoiceSession(session);
        await expect(closing).rejects.toBe(failure);
        expect(session.voiceSessionClose).toBe(closing);
        expect(closeRelayVoiceSession(session)).toBe(closing);
        expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledOnce();
        expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();
      },
    );
  });
});
