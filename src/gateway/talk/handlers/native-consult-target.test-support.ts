import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  resolveAdmittedRunActiveAssertion,
  resolvePreparedRunAdmission,
} from "../../../agents/admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import { claimAgentSessionWriter } from "../../../agents/embedded-agent-runner/run/session-bootstrap.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunTesting,
} from "../../../agents/embedded-agent-runner/runs.test-support.js";
import { resolveAgentRunSessionTarget } from "../../../agents/run-session-target.js";
import { guardSessionManager } from "../../../agents/session-tool-result-guard-wrapper.js";
import { persistAgentSessionMessage } from "../../../agents/sessions/agent-session-transcript.js";
import { withSessionManagerWriteAssertion } from "../../../agents/sessions/session-manager-write-admission.js";
import { SessionManager } from "../../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../../agents/test-helpers/agent-message-fixtures.js";
import { withGatewayToolCallerIdentity } from "../../../agents/tools/gateway-caller-context.js";
import { markCompleteReplyConfig } from "../../../auto-reply/reply/get-reply-fast-path.test-support.js";
import { withOwnedSessionTranscriptWriterFence } from "../../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { validateConfigObject } from "../../../config/validation-core.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
} from "../../../plugins/types.js";
import type { RealtimeTranscriptionSessionCreateRequest } from "../../../realtime-transcription/provider-types.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceGatewayControl,
  RealtimeVoiceProviderCapabilities,
} from "../../../talk/provider-types.js";
import { getUnifiedTalkSession } from "../../../talk/session-registry.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import { SharedGatewaySessionGenerationState } from "../../server-shared-auth-generation.js";
import type { GatewayWsClient } from "../../server/ws-types.js";
import { sharingPolicyClient } from "../../session-sharing.test-utils.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import { drainingRelaySessions } from "../relay/state.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { talkClientHandlers } from "./client.js";
import { talkSessionHandlers } from "./session.js";
import {
  createTalkWebSocketTestClient,
  dispatchTalkWebSocketTestRequest,
} from "./talk-websocket.test-support.js";

const mocks = vi.hoisted(() => ({
  capabilities: {
    transports: ["webrtc", "gateway-relay"],
    inputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
    outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
    supportsToolCalls: false,
  } satisfies RealtimeVoiceProviderCapabilities,
  resolveProvider: vi.fn(),
  prepareSpeech:
    vi.fn<typeof import("../../../plugin-sdk/tts-runtime.js").prepareTextToSpeechTelephony>(),
  streamSpeech:
    vi.fn<typeof import("../../../plugin-sdk/tts-runtime.js").streamTextToSpeechTelephony>(),
  runEmbeddedAgent: vi.fn(async (_params: RunEmbeddedAgentParams) => ({
    payloads: [{ text: "Synthetic consult answer" }],
    meta: { durationMs: 0 },
  })),
}));

// mock-isolation: detached greetings use this native runner entry; keep their admission/presentation real and replace the same controlled model boundary as ordinary replies.
vi.mock("../../../agents/embedded-agent-runner/run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../agents/embedded-agent-runner/run.js")>()),
  runEmbeddedAgent: mocks.runEmbeddedAgent,
}));
vi.mock("../../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: mocks.runEmbeddedAgent,
}));
vi.mock("../../../agents/bootstrap-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../agents/bootstrap-files.js")>()),
  resolveBootstrapFilesForRun: async () => [],
}));
vi.mock("../../../talk/provider-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/provider-resolver.js")>()),
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveProvider,
}));
vi.mock("../../../talk/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/provider-registry.js")>()),
  listRealtimeVoiceProviders: () => [],
}));
// Only the hardware synthesis boundary is synthetic. Runtime construction,
// speech orchestration, native admission and durable voice custody remain real.
vi.mock("../../../plugin-sdk/tts-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugin-sdk/tts-runtime.js")>()),
  prepareTextToSpeechTelephony: mocks.prepareSpeech,
  streamTextToSpeechTelephony: mocks.streamSpeech,
}));

let state: OpenClawTestState;
let config: OpenClawConfig;
let client: GatewayWsClient;
let connection: AbortController;
let generation: SharedGatewaySessionGenerationState;
let callback: RealtimeVoiceAgentConsultRunner | undefined;
let providerInstructions: string | undefined;
const browserVoiceSessionIds = new Set<string>();
const speechRelaySessions = new Set<
  Extract<ReturnType<typeof getUnifiedTalkSession>, { kind: "speech-relay" }>
>();
let browserControl: RealtimeVoiceGatewayControl | undefined;
const submitProviderResult = vi.fn();
const context = {
  getRuntimeConfig: () => config,
  getClientConnIds: (filter?: (current: typeof client) => boolean) =>
    new Set(!filter || filter(client) ? [client.connId] : []),
  chatAbortControllers: new Map(),
  broadcastToConnIds: vi.fn(),
  logGateway: { info: vi.fn(), warn: vi.fn() },
} as unknown as GatewayRequestContext;

function resolveNativeConsultConfig(raw: OpenClawConfig): OpenClawConfig {
  // This fixture has no installed plugin manifests. Use the actual schema and
  // runtime-default materializer before declaring a complete config; marking
  // an arbitrary partial override would hide a real fixture-contract violation.
  const validated = validateConfigObject(raw, {
    manifestRegistry: { plugins: [], diagnostics: [] },
  });
  if (!validated.ok) {
    throw new Error("Invalid native consult fixture configuration", { cause: validated.issues });
  }
  // Preserve real Session/SQLite initialization, rather than the abbreviated
  // fast-test bootstrap. Only hardware/model leaf implementations are mocked.
  return markCompleteReplyConfig(validated.config, { runtimeMode: "full" });
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  handlers: GatewayRequestHandlers = {},
) {
  const respond = vi.fn();
  await dispatchTalkWebSocketTestRequest(
    {
      req: { type: "req", id: "native-consult", method, params },
      client,
      context,
      isWebchatConnect: () => false,
      respond,
      extraHandlers: { ...talkClientHandlers, ...talkSessionHandlers, ...handlers },
    },
    generation.reader,
  );
  const payload = respond.mock.calls.at(-1)?.[1];
  if (
    method === "talk.client.create" &&
    isRecord(payload) &&
    typeof payload.voiceSessionId === "string"
  ) {
    browserVoiceSessionIds.add(payload.voiceSessionId);
  }
  if (
    method === "talk.session.create" &&
    isRecord(payload) &&
    payload.mode === "stt-tts" &&
    typeof payload.sessionId === "string"
  ) {
    const record = getUnifiedTalkSession(payload.sessionId);
    if (record.kind === "speech-relay") {
      speechRelaySessions.add(record);
    }
  }
  return respond;
}

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "talk-native-consult" });
  config = resolveNativeConsultConfig({
    agents: {
      ownership: "explicit",
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "openai/synthetic-native-consult" },
      },
      entries: { primary: {}, voice: { workspace: state.workspaceDir } },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://model.example.test/v1",
          apiKey: "synthetic-native-consult-key",
          api: "openai-responses",
          models: [
            {
              id: "synthetic-native-consult",
              name: "Synthetic native consult model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    talk: { agentId: "voice" },
  });
  connection = new AbortController();
  generation = new SharedGatewaySessionGenerationState({ current: undefined, required: null });
  const identity = sharingPolicyClient({
    user: ensureProfileForEmail("native-listener@example.test").id,
    deviceId: "native-consult-device",
  });
  client = createTalkWebSocketTestClient({
    identity,
    connId: "native-consult-client",
    connectionSignal: connection.signal,
  });
  callback = undefined;
  providerInstructions = undefined;
  browserVoiceSessionIds.clear();
  speechRelaySessions.clear();
  browserControl = undefined;
  vi.clearAllMocks();
  vi.mocked(context.broadcastToConnIds).mockReset();
  mocks.prepareSpeech.mockReset();
  mocks.streamSpeech.mockReset();
  mocks.runEmbeddedAgent.mockReset().mockResolvedValue({
    payloads: [{ text: "Synthetic consult answer" }],
    meta: { durationMs: 0 },
  });
  context.chatAbortControllers.clear();
  setActivePluginRegistry(createEmptyPluginRegistry());
  const provider: RealtimeVoiceProviderPlugin = {
    id: "synthetic-voice",
    label: "Synthetic voice",
    capabilities: mocks.capabilities,
    isConfigured: () => true,
    createBrowserSession: async (request) => {
      providerInstructions = request.instructions;
      callback = request.runAgentConsult;
      browserControl = request.gatewayControl;
      browserControl?.bindBridge({
        connect: async () => undefined,
        sendAudio: () => undefined,
        setMediaTimestamp: () => undefined,
        handleBargeIn: () => undefined,
        submitToolResult: submitProviderResult,
        acknowledgeMark: () => undefined,
        close: () => undefined,
        isConnected: () => true,
      });
      return {
        provider: "synthetic-voice",
        transport: "webrtc",
        clientSecret: "synthetic-offer",
        offerUrl: "/test/offer",
      };
    },
    createBridge: (request) => {
      providerInstructions = request.instructions;
      callback = request.runAgentConsult;
      return {
        connect: async () => undefined,
        sendAudio: () => undefined,
        setMediaTimestamp: () => undefined,
        handleBargeIn: () => undefined,
        submitToolResult: () => undefined,
        acknowledgeMark: () => undefined,
        close: () => undefined,
        isConnected: () => true,
      };
    },
  };
  Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
    value: { isBrowserSessionConfigured: () => true, cancelBrowserSession: async () => undefined },
  });
  mocks.resolveProvider.mockReturnValue({
    provider,
    providerConfig: {},
    capabilities: {
      ...mocks.capabilities,
      supportsGatewayControl: true,
      handlesAgentConsult: true,
    },
  });
});

afterEach(async () => {
  try {
    for (const speechSession of speechRelaySessions) {
      await speechSession.close();
    }
    for (const browserVoiceSessionId of browserVoiceSessionIds) {
      await closeTalkClientGatewayControlSession({
        voiceSessionId: browserVoiceSessionId,
        sessionKey: "main",
        connId: client.connId,
      });
    }
    cleanupTalkConnection(client.connId, context.logGateway);
    await Promise.all(
      [...drainingRelaySessions].map(
        (session) => session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
      ),
    );
  } finally {
    connection.abort();
    clientVoiceSessionTesting.reset();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    setActivePluginRegistry(createEmptyPluginRegistry());
    await state.cleanup();
  }
});

async function createRelayCall(params: Record<string, unknown> = {}) {
  const respond = await dispatch("talk.session.create", {
    sessionKey: "main",
    mode: "realtime",
    transport: "gateway-relay",
    brain: "agent-consult",
    ...params,
  });
  expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
  const sessionId = (respond.mock.calls[0]![1] as { sessionId: string }).sessionId;
  const record = getUnifiedTalkSession(sessionId);
  if (record.kind !== "realtime-relay") {
    throw new Error("Expected realtime relay");
  }
  return { sessionId, target: record.sessionTarget };
}

function installSyntheticSpeechHardware(
  options: { connect?: Promise<void>; finishInput?: () => void | Promise<void> } = {},
) {
  let request: RealtimeTranscriptionSessionCreateRequest | undefined;
  let connected = false;
  let closed = false;
  const releaseStt = vi.fn(async () => undefined);
  const releaseTts = vi.fn(async () => undefined);
  const turnTtsReleases: Array<typeof releaseTts> = [];
  const turnTtsReleased = createDeferredCore();
  const releaseStream = vi.fn(async () => undefined);
  const streamStarted = createDeferredCore();
  const connectStarted = createDeferredCore();
  const closeStarted = createDeferredCore();
  const input = vi.fn<(audio: Buffer) => void>();
  const close = vi.fn(() => {
    closed = true;
    connected = false;
    closeStarted.resolve();
  });
  const output = Buffer.alloc(960, 17);
  const provider: RealtimeTranscriptionProviderPlugin = {
    id: "synthetic-transcription",
    label: "Synthetic transcription hardware",
    transcriptGranularity: "utterance",
    isConfigured: () => true,
    resolveInputAudioFormat: () => "pcm16-16khz",
    prepareSession: vi.fn(async () => ({ release: releaseStt })),
    createSession: vi.fn((created) => {
      request = created;
      return {
        connect: async () => {
          connectStarted.resolve();
          await options.connect;
          connected = !closed;
        },
        sendAudio: input,
        ...(options.finishInput ? { finishInput: options.finishInput } : {}),
        close,
        isConnected: () => connected,
      };
    }),
  };
  const registry = createEmptyPluginRegistry();
  registry.realtimeTranscriptionProviders.push({
    pluginId: "synthetic-transcription",
    source: "synthetic-test",
    provider,
  });
  setActivePluginRegistry(registry);
  // The relay retains its session hold; each consultation acquires a separate hold.
  mocks.prepareSpeech
    .mockResolvedValueOnce({ success: true, release: releaseTts })
    .mockImplementation(async () => {
      const release = vi.fn(async () => {
        turnTtsReleased.resolve();
        return undefined;
      });
      turnTtsReleases.push(release);
      return { success: true, release };
    });
  mocks.streamSpeech.mockImplementation(async () => {
    streamStarted.resolve();
    return {
      success: true,
      sampleRate: 24000,
      audioStream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(output);
          controller.close();
        },
      }),
      release: releaseStream,
    };
  });
  return {
    provider,
    input,
    close,
    output,
    releaseStt,
    releaseTts,
    turnTtsReleases,
    turnTtsReleased: turnTtsReleased.promise,
    releaseStream,
    streamStarted,
    connectStarted,
    closeStarted,
    emitTranscript: (text: string) => {
      if (!request) {
        throw new Error("Expected native speech provider session");
      }
      request.onTranscript?.(text, { utteranceId: "synthetic-utterance" });
    },
  };
}

async function createSpeechRelayCall(params: Record<string, unknown> = {}) {
  const respond = await dispatch("talk.session.create", {
    sessionKey: "main",
    mode: "stt-tts",
    transport: "gateway-relay",
    brain: "agent-consult",
    provider: "synthetic-transcription",
    capabilities: ["isolated-input", "output-gate"],
    ...params,
  });
  expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
  const result = respond.mock.calls[0]![1] as {
    sessionId: string;
    readyMark: string;
    audio: { supportsInputEnd: boolean };
  };
  const record = getUnifiedTalkSession(result.sessionId);
  if (record.kind !== "speech-relay") {
    throw new Error("Expected native STT/TTS speech relay");
  }
  return { ...result, target: record.sessionTarget };
}

async function publishNativeSpeechModelRun(
  input: RunEmbeddedAgentParams,
  work?: (
    persistAssistantMessage: (message: AssistantMessage) => Promise<void>,
  ) => Promise<{ payloads: Array<{ text: string }>; meta: { durationMs: number } }>,
) {
  let params = input;
  if (!params.agentId || !params.sessionKey) {
    throw new Error("The synthetic native speech run requires an explicit agent and session key");
  }
  const { agentId, sessionKey } = params;
  const admitted = await resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
  const assertAdmitted = resolveAdmittedRunActiveAssertion(admitted, params.abortSignal);
  const assertCurrent = () => {
    params.abortSignal?.throwIfAborted();
    assertAdmitted?.();
  };
  // Replacing the embedded model runner also bypasses its lane controller.
  // Retain that owner's real durable writer claim and captured fence before
  // lifecycle callbacks or synthetic model messages can write the transcript.
  const writerClaim = await claimAgentSessionWriter(params);
  assertCurrent();
  if (writerClaim) {
    params = {
      ...params,
      sessionTarget: {
        ...params.sessionTarget,
        expectedLifecycleRevision: writerClaim.expectedLifecycleRevision,
        expectedWriterRunId: writerClaim.expectedWriterRunId,
      },
    };
  }
  const handle = createEmbeddedRunHandle({ runId: params.runId });
  await withGatewayToolCallerIdentity(
    {
      agentId,
      sessionKey,
      operationalRunInstance: admitted.operationalRunInstance,
      embeddedRunToolAuthorityBinding: () => ({
        source: "attempt",
        project: () => "current-authority",
        projectAsync: async () => "current-authority",
        assertActive: () => {},
      }),
    },
    () => setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey),
  );
  try {
    // The replaced embedded runtime owns canonical user persistence even for
    // follow-ups. Exercise its provided recorder, not a handcrafted transcript
    // append: foreground admission is idempotent and queued source credit still
    // has to commit before the synthetic model can see or act on it.
    const recorder = params.userTurnTranscriptRecorder;
    if (recorder) {
      const persistence = recorder.persistApproved().then((persisted) => {
        const message = persisted?.message ?? recorder.getPersistedMessage?.();
        if (message && recorder.hasPersisted()) {
          params.onUserMessagePersisted?.(message);
        }
      });
      recorder.markRuntimePersistencePending(persistence);
      await recorder.waitForRuntimePersistence();
    }
    // The native subscriber emits lifecycle start before model/tool work. Its reply
    // handler prepares the actual transcript boundary before notifying voice custody.
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    let manager: ReturnType<typeof guardSessionManager> | undefined;
    const persistAssistantMessage = async (message: AssistantMessage) => {
      // A controlled model emits an actual completed AssistantMessage here,
      // independently of delivery payloads or Speech/TTS presentation. Replace
      // only the model leaf; retain its native guarded transcript writer.
      assertCurrent();
      if (!manager) {
        if (params.sessionPersistence === "detached") {
          throw new Error("Synthetic model persistence requires its actual durable run target");
        }
        // The real embedded runtime resolves optional run targets at session
        // bootstrap/attempt preparation. Use that same owner, not a target
        // reconstructed from the scenario's expected transcript address.
        const resolved = await resolveAgentRunSessionTarget({
          ...params,
          missingSessionKey: "resolve-existing",
        });
        assertCurrent();
        const target = withOwnedSessionTranscriptWriterFence({
          ...resolved,
          expectedLifecycleRevision: params.sessionTarget?.expectedLifecycleRevision,
          expectedWriterRunId: params.sessionTarget?.expectedWriterRunId,
        });
        manager = guardSessionManager(
          await SessionManager.openAsync(
            target,
            params.workspaceDir,
            undefined,
            params.abortSignal,
          ),
          {
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            runId: params.runId,
            config: params.config,
            prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
          },
        );
      }
      assertCurrent();
      const transcriptManager = manager;
      await withSessionManagerWriteAssertion(transcriptManager, assertCurrent, () =>
        persistAgentSessionMessage(transcriptManager, message, {
          invalidateSerializedPrefixCache: false,
        }),
      );
    };
    if (work) {
      return await work(persistAssistantMessage);
    }
    const text = "The synthetic device is ready.";
    await persistAssistantMessage(
      makeAgentAssistantMessage({
        model: "synthetic-native-consult",
        content: [{ type: "text", text }],
      }),
    );
    await params.onBlockReply?.({ text });
    await params.waitForPendingInput?.(params.abortSignal);
    return { payloads: [{ text }], meta: { durationMs: 0 } };
  } finally {
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
  }
}

export const testState = {
  get config() {
    return config;
  },
  set config(value: OpenClawConfig) {
    config = resolveNativeConsultConfig(value);
  },
  get client() {
    return client;
  },
  set client(value: GatewayWsClient) {
    client = value;
  },
};
export {
  callback,
  providerInstructions,
  browserControl,
  submitProviderResult,
  context,
  mocks,
  dispatch,
  createRelayCall,
  installSyntheticSpeechHardware,
  createSpeechRelayCall,
  publishNativeSpeechModelRun,
};
