import { AsyncResource } from "node:async_hooks";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import {
  createPluginRuntimeMock,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createEmptyPluginRegistry,
  createPluginRecord,
  createPluginRegistry,
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { getRealtimeTranscriptionProvider } from "openclaw/plugin-sdk/realtime-transcription";
import { afterEach, expect, it, vi } from "vitest";
import {
  getMatrixRuntimeLifecycle,
  setMatrixRuntime,
  setMatrixRuntimeLifecycle,
} from "../runtime.js";
import type { CoreConfig } from "../types.js";
import {
  createHarness,
  getRtcControllerMocks,
  ownerId,
  roomId,
} from "./rtc-controller.test-helpers.js";

const mocks = getRtcControllerMocks();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

it("admits new RTC startup from an old socket context through the adopted Matrix owner", async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const oldConfig: CoreConfig = {
    session: { dmScope: "per-channel-peer" },
    agents: { entries: { example_owner: {} } },
    channels: {
      matrix: {
        enabled: true,
        accounts: { default: {} },
        dm: { enabled: true, policy: "allowlist", allowFrom: [ownerId] },
        rtc: {
          enabled: true,
          authServiceUrl: "https://rtc.example.test",
          mediaBridgeCommand: "/usr/local/bin/matrix-rtc-bridge",
          transcriptionProvider: "local-stt",
          admissions: [{ roomId, userId: ownerId, agentId: "example_owner" }],
        },
      },
    },
  };
  const currentConfig: CoreConfig = {
    ...oldConfig,
    session: { dmScope: "per-account-channel-peer" },
  };
  let liveConfig = oldConfig;
  const runtime = createPluginRuntimeMock({
    config: { current: () => liveConfig },
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          agentId: "example_owner",
          channel: "matrix",
          accountId: "default",
          sessionKey: "agent:example_owner:matrix:direct:owner",
          mainSessionKey: "agent:example_owner:main",
          lastRoutePolicy: "session",
          matchedBy: "binding.peer",
        }),
      },
    },
  });
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const first = createPluginRegistry({ logger, runtime, activateGlobalSideEffects: false });
  const record = createPluginRecord({ id: "matrix", origin: "bundled" });
  first.registry.plugins.push(record);
  const api = first.createApi(record, { config: oldConfig });
  const runner = api.lifecycle.runInBackgroundContext!;
  const releaseOld = vi.fn(async () => undefined);
  const releaseCurrent = vi.fn(async () => undefined);
  const oldProvider = vi.fn(async () => ({ release: releaseOld }));
  const currentProvider = vi.fn(async () => ({ release: releaseCurrent }));
  const provider = (prepareSession: typeof oldProvider) => ({
    id: "local-stt",
    label: "Synthetic STT",
    isConfigured: () => true,
    prepareSession,
    createSession: () => {
      throw new Error("No media processing in the startup regression");
    },
  });
  first.registry.realtimeTranscriptionProviders.push({
    pluginId: "local-media",
    provider: provider(oldProvider),
  });
  const successor = createEmptyPluginRegistry();
  successor.plugins.push(record);
  successor.realtimeTranscriptionProviders.push({
    pluginId: "local-media",
    provider: provider(currentProvider),
  });
  setActivePluginRegistry(first.registry);
  const socket = withPluginRuntimeRegistryScope(
    first.registry,
    () => new AsyncResource("matrix-socket"),
  );
  const retainedRunner = runner(() => {
    setMatrixRuntime(api.runtime);
    setMatrixRuntimeLifecycle(api.runtime, api.lifecycle);
    return getMatrixRuntimeLifecycle()?.runInBackgroundContext;
  });
  expect(retainedRunner).toBe(runner);
  const harness = createHarness("matrix_2_0", {
    cfg: oldConfig,
    runtime: api.runtime,
    runInBackgroundContext: retainedRunner!,
  });
  const originalPreparation = mocks.prepareMeetingAgentRealtimeEngine.getMockImplementation()!;
  mocks.prepareMeetingAgentRealtimeEngine.mockImplementation(async (params) => {
    const selected = getRealtimeTranscriptionProvider("local-stt", params.fullConfig);
    const prepared = await selected!.prepareSession!({ providerConfig: {} });
    return {
      release: vi.fn(async () => {
        await prepared?.release();
        return undefined;
      }),
    };
  });
  const emitMembership = () =>
    socket.runInAsyncScope(() => {
      harness.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
    });
  try {
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    socket.runInAsyncScope(() =>
      harness.managerEmitter.emit("session_started", roomId, harness.session),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(oldProvider).toHaveBeenCalledOnce();
    expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();
    const oldEngine = mocks.startMeetingAgentRealtimeEngine.mock.results[0]!.value;

    liveConfig = currentConfig;
    setActivePluginRegistry(successor);
    harness.session.memberships = [];
    emitMembership();
    await vi.advanceTimersByTimeAsync(0);
    expect((await oldEngine).stop).toHaveBeenCalledOnce();
    expect(releaseOld).toHaveBeenCalledOnce();

    harness.remoteMembership.createdTs.mockReturnValue(2);
    harness.session.memberships = [harness.remoteMembership];
    emitMembership();
    await vi.advanceTimersByTimeAsync(0);
    expect(currentProvider).toHaveBeenCalledOnce();
    expect(oldProvider).toHaveBeenCalledOnce();
    expect(mocks.prepareMeetingAgentRealtimeEngine.mock.calls[1]![0].fullConfig).toEqual(
      currentConfig,
    );
    expect(mocks.prepareMeetingAgentRealtimeEngine.mock.calls[1]![0].fullConfig).not.toBe(
      currentConfig,
    );
    const currentEngine = mocks.startMeetingAgentRealtimeEngine.mock.results[1]!.value;

    // The old controller still owns cleanup, even after its instance loses admission.
    setActivePluginRegistry(createEmptyPluginRegistry());
    harness.session.memberships = [];
    emitMembership();
    await vi.advanceTimersByTimeAsync(0);
    expect((await currentEngine).stop).toHaveBeenCalledOnce();
    expect(releaseCurrent).toHaveBeenCalledOnce();
    harness.remoteMembership.createdTs.mockReturnValue(3);
    harness.session.memberships = [harness.remoteMembership];
    expect(emitMembership).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(currentProvider).toHaveBeenCalledOnce();
    expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledTimes(2);
  } finally {
    await harness.controller.stop();
    socket.emitDestroy();
    await disposePluginRegistryInstances(successor);
    await disposePluginRegistryInstances(first.registry);
    mocks.prepareMeetingAgentRealtimeEngine.mockImplementation(originalPreparation);
  }
});
