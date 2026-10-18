import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { recordAcceptedSessionParticipantInput } from "./session-participant-input-recording.js";
import { prepareSessionParticipantInput } from "./session-participant-input.js";
import {
  recordSessionParticipantBestEffort,
  waitForSessionParticipantRecording,
} from "./session-participant-recording.js";

const { recordParticipant } = vi.hoisted(() => ({
  recordParticipant:
    vi.fn<typeof import("../config/sessions/session-accessor.js").recordSessionParticipant>(),
}));

// mock-isolation: Inspect deferred native writer arguments; SQLite incarnation refusal has its own worker suite.
vi.mock("../config/sessions/session-accessor.js", () => ({
  recordSessionParticipant: recordParticipant,
}));

beforeEach(() => {
  resetGatewayWorkAdmission();
  recordParticipant.mockReset();
});
afterEach(resetGatewayWorkAdmission);

const target = {
  identity: { type: "profile" as const, id: "viewer" },
  agentId: "main",
  sessionKey: "agent:main:participant",
  storePath: "/synthetic/participant.sqlite",
  promptedAt: 1,
};

it("snapshots the original principal, target and incarnation before deferred persistence", async () => {
  const started = createDeferredCore();
  const persistence = createDeferredCore<"inserted">();
  const work = new AsyncWorkScope();
  const reported: unknown[] = [];
  const expectedSession = { sessionId: "original-session", lifecycleRevision: "original-life" };
  const input = {
    ...target,
    identity: { ...target.identity },
    expectedSession: { ...expectedSession },
    onError: (error: unknown) => reported.push(error),
  };
  recordParticipant.mockImplementation(() => {
    started.resolve();
    return persistence.promise;
  });
  try {
    work.run(() => recordSessionParticipantBestEffort(input));
    expect(recordParticipant).not.toHaveBeenCalled();
    input.identity.id = "replacement-person";
    input.sessionKey = "agent:main:replacement";
    input.expectedSession.sessionId = "replacement-session";
    input.expectedSession.lifecycleRevision = "replacement-life";
    await started.promise;
    expect(recordParticipant).toHaveBeenCalledExactlyOnceWith(
      { agentId: target.agentId, sessionKey: target.sessionKey, storePath: target.storePath },
      {
        identity: target.identity,
        promptedAt: target.promptedAt,
        sessionAgentId: target.agentId,
        expectedSession,
      },
    );
    const refused = new Error("Original participant input session changed before commit");
    persistence.reject(refused);
    await waitForSessionParticipantRecording(target);
    await work.drain();
    expect(reported).toEqual([refused]);
  } finally {
    persistence.resolve("inserted");
    await work.drain();
  }
});

it("carries an accepted input's native incarnation without manufacturing another contribution", async () => {
  const work = new AsyncWorkScope();
  const context = {};
  prepareSessionParticipantInput(context, target.identity, target.promptedAt);
  const selected = {
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
    expectedSession: { sessionId: "accepted-session", lifecycleRevision: "accepted-life" },
  };
  recordParticipant.mockResolvedValue("inserted");
  work.run(() => {
    recordAcceptedSessionParticipantInput(context, selected);
    recordAcceptedSessionParticipantInput({ ...context }, selected);
  });
  await waitForSessionParticipantRecording(selected);
  await work.drain();
  expect(recordParticipant).toHaveBeenCalledExactlyOnceWith(
    { agentId: target.agentId, sessionKey: target.sessionKey, storePath: target.storePath },
    {
      identity: target.identity,
      promptedAt: target.promptedAt,
      sessionAgentId: target.agentId,
      expectedSession: selected.expectedSession,
    },
  );
});

it.each(["resolve", "reject"] as const)(
  "joins participant persistence without retaining its caller root when it %ss",
  async (outcome) => {
    const persistence = createDeferredCore<"inserted">();
    const started = createDeferredCore();
    const failures = new Set<unknown>();
    const reported: unknown[] = [];
    const work = new AsyncWorkScope(failures);
    const root = tryBeginGatewayRootWorkAdmission("test:participant");
    if (!root) {
      throw new Error("Participant fixture could not acquire its root");
    }
    recordParticipant.mockImplementation(() => {
      started.resolve();
      return persistence.promise;
    });
    try {
      await root.run(async () => {
        work.run(() => {
          expect(
            recordSessionParticipantBestEffort({
              ...target,
              onError: (error) => reported.push(error),
            }),
          ).toBeUndefined();
          expect(recordParticipant).not.toHaveBeenCalled();
        });
      });
      root.release();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      await started.promise;
      let joined = false;
      const joinedRecording = waitForSessionParticipantRecording(target).then(() => {
        joined = true;
      });
      let drained = false;
      const drainage = work.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(drained).toBe(false);
      expect(joined).toBe(false);
      const failure = new Error("Participant persistence failed");
      if (outcome === "reject") {
        persistence.reject(failure);
      } else {
        persistence.resolve("inserted");
      }
      await drainage;
      await joinedRecording;
      expect(joined).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(reported).toEqual(outcome === "reject" ? [failure] : []);
      expect(failures.size).toBe(0);
    } finally {
      persistence.resolve("inserted");
      await work.drain();
      root.release();
    }
  },
);

it("keeps unrooted participant work unrooted while Gateway admission is closed", async () => {
  const persistence = createDeferredCore<"inserted">();
  const started = createDeferredCore();
  const work = new AsyncWorkScope();
  recordParticipant.mockImplementation(() => {
    started.resolve();
    return persistence.promise;
  });
  markGatewayRestartDraining();
  try {
    work.run(() => recordSessionParticipantBestEffort(target));
    await started.promise;
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
  } finally {
    persistence.resolve("inserted");
    await work.drain();
  }
});
