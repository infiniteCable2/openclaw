import { EventType } from "matrix-js-sdk/lib/@types/event.js";
import { CallMembership } from "matrix-js-sdk/lib/matrixrtc/CallMembership.js";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import { MatrixEvent } from "matrix-js-sdk/lib/models/event.js";
import { beforeEach, expect, it, vi } from "vitest";
import { MATRIX_RTC_CONVERSATION_KEY, readMatrixRtcConversationRequest } from "./rtc-assistant.js";
import {
  createHarness,
  flushPromises,
  getRtcControllerMocks,
  ownerId,
  roomId,
} from "./rtc-controller.test-helpers.js";

const mocks = getRtcControllerMocks();
const request = { version: 1, purpose: "assistant-voice", request_id: "call_1-uuid" };
const marker = { [MATRIX_RTC_CONVERSATION_KEY]: request };

beforeEach(() => vi.clearAllMocks());

it.each(["compatibility", "matrix_2_0"] as const)(
  "uses SDK-normalized %s application data without changing Matrix authority",
  async (mode) => {
    const content =
      mode === "compatibility"
        ? {
            application: "m.call",
            call_id: "",
            device_id: "OWNERDEVICE",
            expires: 60_000,
            focus_active: { type: "livekit" },
            foci_preferred: [],
            ...marker,
          }
        : {
            slot_id: "m.call#ROOM",
            application: { type: "m.call", ...marker },
            member: { user_id: ownerId, device_id: "OWNERDEVICE", id: "owner-member" },
            transports: { published: [], can_subscribe: [] },
            versions: [],
            sticky_key: "member",
          };
    const member = await CallMembership.parseFromEvent(
      new MatrixEvent({
        event_id: "$membership",
        sender: ownerId,
        origin_server_ts: 1,
        type: mode === "compatibility" ? EventType.GroupCallMemberPrefix : EventType.RTCMembership,
        content,
      }),
    );
    expect(readMatrixRtcConversationRequest(member.applicationData)).toEqual({
      requestId: request.request_id,
      purpose: request.purpose,
    });
    expect(member.userId).toBe(ownerId);
    expect(member.memberId).toBe(
      mode === "compatibility" ? `${ownerId}:OWNERDEVICE` : "owner-member",
    );
  },
);

it.each([
  null,
  {},
  { ...request, version: 2 },
  { ...request, purpose: "other" },
  { ...request, request_id: "" },
  { ...request, request_id: "a".repeat(129) },
  { ...request, request_id: "has space" },
  { ...request, request_id: "ü" },
  { ...request, request_id: "valid\n" },
])("rejects an invalid explicit assistant marker %j", (value) => {
  expect(() => readMatrixRtcConversationRequest({ [MATRIX_RTC_CONVERSATION_KEY]: value })).toThrow(
    "request is invalid",
  );
});

function assistantHarness(
  mode: "compatibility" | "matrix_2_0" = "matrix_2_0",
  captions: unknown = true,
) {
  const h = createHarness(mode, { greeting: true });
  h.remoteMembership.applicationData = { [MATRIX_RTC_CONVERSATION_KEY]: { ...request, captions } };
  h.setRoomKnown(true);
  h.session.memberships = [h.remoteMembership];
  const start = () => h.managerEmitter.emit("session_started", roomId, h.session);
  const syncOwn = (requestId = request.request_id) => {
    const joinData = h.session.join.mock.calls[0]![2]!.applicationData!;
    const own = {
      ...h.remoteMembership,
      userId: h.sdkClient.getUserId(),
      deviceId: h.sdkClient.getDeviceId(),
      // Legacy own-member IDs need not equal the ephemeral UUID supplied to join.
      memberId: "own-published-member",
      applicationData: {
        type: "m.call",
        "m.call.intent": "audio",
        capabilities: ["audio"],
        "example.other": true,
        ...joinData,
        [MATRIX_RTC_CONVERSATION_KEY]: {
          ...(joinData[MATRIX_RTC_CONVERSATION_KEY] as object),
          request_id: requestId,
        },
      },
    };
    h.session.memberships = [h.remoteMembership, own];
    h.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
  };
  const event = (
    type: "session.ready" | "session.error" | "session.closed",
    sessionId?: string,
  ) => {
    const engine = mocks.startMeetingAgentRealtimeEngine.mock.calls[0]![0];
    engine.onTalkEvent?.({
      type,
      sessionId: sessionId ?? engine.meetingSessionId,
      id: "event",
      seq: 1,
      timestamp: "2026-01-01T00:00:00Z",
      mode: "stt-tts",
      transport: "gateway-relay",
      brain: "agent-consult",
      payload: {},
    });
  };
  const ready = async () => {
    syncOwn();
    event("session.ready");
    await flushPromises();
  };
  return { ...h, start, syncOwn, event, ready };
}

it.each(["compatibility", "matrix_2_0"] as const)(
  "publishes %s ready only after real speech readiness, successful startup and own membership sync",
  async (mode) => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof mocks.startMeetingAgentRealtimeEngine>>>();
    mocks.startMeetingAgentRealtimeEngine.mockReturnValueOnce(pending.promise);
    const h = assistantHarness(mode);
    try {
      h.start();
      await flushPromises();
      expect(mocks.prepareMeetingAgentGreeting).not.toHaveBeenCalled();
      const binding = mocks.createMeetingRealtimeEngineBindingsV2.mock.calls[0]![0];
      expect(binding).toMatchObject({
        platform: { id: "matrix-rtc" },
        config: { realtime: { toolPolicy: "owner" } },
        ttsContext: { agentId: "example_owner", channelId: "matrix", accountId: "default" },
        connectionPresentation: {
          kind: "assistant",
          channel: "matrix",
          label: "Matrix Assistant Voice",
        },
      });
      expect(h.session.join.mock.calls[0]![2]!.applicationData).toEqual({
        [MATRIX_RTC_CONVERSATION_KEY]: {
          ...request,
          state: "preparing",
          caller: { user_id: ownerId, device_id: "OWNERDEVICE", member_id: "owner-member" },
        },
      });
      h.event("session.ready", "stale-session");
      h.syncOwn("previous-request");
      h.event("session.ready");
      expect(h.session.updateApplicationData).not.toHaveBeenCalled();
      pending.resolve({ stop: vi.fn(async () => undefined) });
      await flushPromises();
      expect(h.session.updateApplicationData).not.toHaveBeenCalled();
      h.syncOwn();
      // The SDK updates its membership manager after emitting MembershipsChanged.
      expect(h.session.updateApplicationData).not.toHaveBeenCalled();
      await flushPromises();
      expect(h.session.updateApplicationData).toHaveBeenCalledExactlyOnceWith({
        type: "m.call",
        "m.call.intent": "audio",
        capabilities: ["audio"],
        "example.other": true,
        [MATRIX_RTC_CONVERSATION_KEY]: {
          ...request,
          state: "ready",
          captions: true,
          caller: { user_id: ownerId, device_id: "OWNERDEVICE", member_id: "owner-member" },
        },
      });
      h.event("session.error");
      h.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
      await flushPromises();
      expect(h.session.leave).not.toHaveBeenCalled();
      expect(h.session.updateApplicationData).toHaveBeenCalledOnce();
      h.event("session.closed");
      await flushPromises();
      expect(h.session.leave).toHaveBeenCalledOnce();
    } finally {
      pending.resolve({ stop: vi.fn(async () => undefined) });
      await h.controller.stop();
    }
  },
);

it("waits for successful startup when the current own membership and speech readiness arrive first", async () => {
  const pending =
    Promise.withResolvers<Awaited<ReturnType<typeof mocks.startMeetingAgentRealtimeEngine>>>();
  mocks.startMeetingAgentRealtimeEngine.mockReturnValueOnce(pending.promise);
  const h = assistantHarness("compatibility");
  try {
    h.start();
    await flushPromises();
    h.syncOwn();
    h.event("session.ready");
    await flushPromises();
    expect(h.session.updateApplicationData).not.toHaveBeenCalled();
    pending.resolve({ stop: vi.fn(async () => undefined) });
    await flushPromises();
    expect(h.session.updateApplicationData).toHaveBeenCalledOnce();
  } finally {
    pending.resolve({ stop: vi.fn(async () => undefined) });
    await h.controller.stop();
  }
});

it("does not revive a closed call when an in-flight readiness update fails", async () => {
  const h = assistantHarness();
  const update = Promise.withResolvers<void>();
  h.session.updateApplicationData.mockReturnValueOnce(update.promise);
  try {
    h.start();
    await flushPromises();
    h.syncOwn();
    h.event("session.ready");
    await flushPromises();
    expect(h.session.updateApplicationData).toHaveBeenCalledOnce();
    await h.controller.stop();
    update.reject(new Error("membership already left"));
    h.event("session.ready");
    h.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
    await flushPromises();
    expect(h.session.updateApplicationData).toHaveBeenCalledOnce();
    expect(h.session.leave).toHaveBeenCalledOnce();
    expect(h.logger.warn).not.toHaveBeenCalledWith(
      "matrix rtc: assistant readiness publication failed",
    );
  } finally {
    update.resolve();
    await h.controller.stop();
  }
});

it("never publishes ready when startup fails after the speech ready event", async () => {
  const pending =
    Promise.withResolvers<Awaited<ReturnType<typeof mocks.startMeetingAgentRealtimeEngine>>>();
  mocks.startMeetingAgentRealtimeEngine.mockReturnValueOnce(pending.promise);
  const h = assistantHarness();
  try {
    h.start();
    await flushPromises();
    h.syncOwn();
    h.event("session.ready");
    pending.reject(new Error("speech startup failed"));
    await flushPromises();
    expect(h.session.updateApplicationData).not.toHaveBeenCalled();
    expect(h.session.leave).toHaveBeenCalledOnce();
  } finally {
    pending.resolve({ stop: vi.fn(async () => undefined) });
    await h.controller.stop();
  }
});

it("does not announce readiness from successful start alone and ignores late readiness after stop", async () => {
  const h = assistantHarness();
  h.start();
  await flushPromises();
  h.syncOwn();
  expect(h.session.updateApplicationData).not.toHaveBeenCalled();
  await h.controller.stop();
  h.event("session.ready");
  expect(h.session.updateApplicationData).not.toHaveBeenCalled();
});

it.each(["request_id", "purpose"] as const)(
  "ends an assistant call if %s changes",
  async (field) => {
    const h = assistantHarness();
    try {
      h.start();
      await flushPromises();
      h.remoteMembership.applicationData = {
        [MATRIX_RTC_CONVERSATION_KEY]: { ...request, [field]: "changed" },
      };
      h.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
      await flushPromises();
      expect(h.session.leave).toHaveBeenCalledOnce();
      expect(h.session.updateApplicationData).not.toHaveBeenCalled();
    } finally {
      await h.controller.stop();
    }
  },
);

it("queues encrypted captions in order only to the admitted caller device and tolerates send failure", async () => {
  const h = assistantHarness();
  const first = Promise.withResolvers<void>();
  h.sdkClient.encryptAndSendToDevice.mockReturnValueOnce(first.promise);
  try {
    h.start();
    await flushPromises();
    await h.ready();
    const caption = mocks.startMeetingAgentRealtimeEngine.mock.calls[0]![0].onSpeechCaption!;
    caption({ role: "user", text: "My question." });
    caption({ role: "assistant", text: "First spoken segment." });
    await flushPromises();
    expect(h.sdkClient.encryptAndSendToDevice).toHaveBeenCalledExactlyOnceWith(
      "io.openclaw.conversation.caption",
      [{ userId: ownerId, deviceId: "OWNERDEVICE" }],
      {
        version: 1,
        room_id: roomId,
        request_id: request.request_id,
        seq: 1,
        role: "user",
        text: "My question.",
      },
    );
    h.sdkClient.encryptAndSendToDevice.mockRejectedValueOnce(
      new Error("synthetic sensitive error"),
    );
    first.resolve();
    await flushPromises();
    expect(h.sdkClient.encryptAndSendToDevice.mock.calls[1]?.[2]).toEqual({
      version: 1,
      room_id: roomId,
      request_id: request.request_id,
      seq: 2,
      role: "assistant",
      text: "First spoken segment.",
    });
    expect(h.logger.warn).toHaveBeenCalledWith(
      "matrix rtc: assistant caption queue admission failed",
    );
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain("synthetic sensitive error");
    expect(h.session.leave).not.toHaveBeenCalled();
    caption({ role: "assistant", text: "Next segment." });
    await flushPromises();
    expect(h.sdkClient.encryptAndSendToDevice.mock.calls[2]?.[2]).toMatchObject({
      seq: 3,
      text: "Next segment.",
    });
  } finally {
    first.resolve();
    await h.controller.stop();
  }
});

it.each(["close", "caller-change", "captions-removed"] as const)(
  "discards queued captions after %s without delaying call closure",
  async (change) => {
    const h = assistantHarness();
    const first = Promise.withResolvers<void>();
    h.sdkClient.encryptAndSendToDevice.mockReturnValueOnce(first.promise);
    try {
      h.start();
      await flushPromises();
      await h.ready();
      const caption = mocks.startMeetingAgentRealtimeEngine.mock.calls[0]![0].onSpeechCaption!;
      caption({ role: "user", text: "Question." });
      caption({ role: "assistant", text: "Queued answer." });
      await flushPromises();
      if (change === "close") {
        await h.controller.stop();
      } else if (change === "caller-change") {
        h.remoteMembership.deviceId = "OTHERDEVICE";
      } else {
        h.remoteMembership.applicationData = marker;
      }
      first.resolve();
      await flushPromises();
      expect(h.sdkClient.encryptAndSendToDevice).toHaveBeenCalledOnce();
      if (change === "captions-removed") {
        h.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
        await flushPromises();
        expect(h.session.leave).not.toHaveBeenCalled();
      }
    } finally {
      first.resolve();
      await h.controller.stop();
    }
  },
);

it.each([undefined, false, "true"])(
  "does not send or advertise captions without strict true offer (%s)",
  async (offer) => {
    const h = assistantHarness("compatibility", false);
    h.remoteMembership.applicationData = {
      [MATRIX_RTC_CONVERSATION_KEY]: { ...request, captions: offer },
    };
    try {
      h.start();
      await flushPromises();
      h.syncOwn();
      h.event("session.ready");
      mocks.startMeetingAgentRealtimeEngine.mock.calls[0]![0].onSpeechCaption?.({
        role: "user",
        text: "Question.",
      });
      await flushPromises();
      expect(h.sdkClient.encryptAndSendToDevice).not.toHaveBeenCalled();
      expect(h.session.updateApplicationData).toHaveBeenCalledOnce();
      expect(
        h.session.updateApplicationData.mock.calls[0]?.[0][MATRIX_RTC_CONVERSATION_KEY],
      ).toMatchObject({ state: "ready" });
      expect(
        h.session.updateApplicationData.mock.calls[0]?.[0][MATRIX_RTC_CONVERSATION_KEY],
      ).toHaveProperty("captions", false);
      expect(mocks.prepareMeetingAgentGreeting).not.toHaveBeenCalled();
      expect(h.session.leave).not.toHaveBeenCalled();
    } finally {
      await h.controller.stop();
    }
  },
);

it.each(["call", "assistant-voice"] as const)(
  "negotiates captions false → true → false within a %s without changing audio",
  async (purpose) => {
    const h = assistantHarness("compatibility", false);
    const offer = (captions: boolean) => {
      h.remoteMembership.applicationData = {
        [MATRIX_RTC_CONVERSATION_KEY]: { ...request, purpose, captions },
      };
    };
    offer(false);
    const updating = Promise.withResolvers<void>();
    try {
      h.start();
      await flushPromises();
      await h.ready();
      const caption = mocks.startMeetingAgentRealtimeEngine.mock.calls[0]![0].onSpeechCaption!;
      caption({ role: "user", text: "Not offered." });
      h.session.updateApplicationData.mockReturnValueOnce(updating.promise);
      offer(true);
      h.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
      await flushPromises();
      caption({ role: "user", text: "Not acknowledged yet." });
      await flushPromises();
      expect(h.sdkClient.encryptAndSendToDevice).not.toHaveBeenCalled();
      updating.resolve();
      await flushPromises();
      caption({ role: "assistant", text: "Confirmed caption." });
      await flushPromises();
      offer(false);
      h.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
      await flushPromises();
      caption({ role: "assistant", text: "No longer offered." });
      await flushPromises();
      expect(h.sdkClient.encryptAndSendToDevice).toHaveBeenCalledOnce();
      expect(h.sdkClient.encryptAndSendToDevice.mock.calls[0]?.[2]).toMatchObject({
        seq: 1,
        text: "Confirmed caption.",
      });
      expect(
        h.session.updateApplicationData.mock.calls.map(
          ([data]) => data[MATRIX_RTC_CONVERSATION_KEY],
        ),
      ).toEqual(
        [false, true, false].map((captions) => ({
          ...request,
          purpose,
          state: "ready",
          captions,
          caller: { user_id: ownerId, device_id: "OWNERDEVICE", member_id: "owner-member" },
        })),
      );
      expect(mocks.prepareMeetingAgentGreeting).toHaveBeenCalledTimes(purpose === "call" ? 1 : 0);
      expect(
        mocks.createMeetingRealtimeEngineBindingsV2.mock.calls[0]![0].connectionPresentation?.kind,
      ).toBe(purpose === "call" ? "call" : "assistant");
      expect(h.session.leave).not.toHaveBeenCalled();
    } finally {
      updating.resolve();
      await h.controller.stop();
    }
  },
);
