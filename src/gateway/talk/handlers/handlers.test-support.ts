import { expectDefined } from "@openclaw/normalization-core";
/** Tests for talk gateway methods that coordinate speech and audio providers. */
import { afterEach, beforeEach, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { setActiveDegradedSecretOwners } from "../../../secrets/runtime-degraded-state.js";
import { resetClientVoiceConfirmationStateForTest } from "../../../talk/client-voice-confirmation.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../../server-methods/types.js";
import { resolveSessionMutationAuthorization } from "../../session-sharing.js";
import { talkHandlers } from "./index.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  getCanonicalUserPreferences: vi.fn<
    () => Promise<{ profileId: string; entries: Record<string, unknown> } | undefined>
  >(async () => undefined),
  readConfigFileSnapshot: vi.fn(),
  canonicalizeSpeechProviderId: vi.fn((providerId: string | undefined) => providerId),
  getSpeechProvider: vi.fn(),
  listSpeechProviders: vi.fn(() => []),
  getResolvedSpeechProviderConfig: vi.fn(() => ({})),
  resolveTtsConfig: vi.fn(() => ({ timeoutMs: 30_000 })),
  synthesizeSpeech: vi.fn(),
  canonicalizeRealtimeVoiceProviderId: vi.fn((providerId: string | undefined) =>
    providerId === "gemini-live" ? "google" : providerId?.trim().toLowerCase(),
  ),
  listRealtimeVoiceProviders: vi.fn(() => []),
  canonicalizeRealtimeTranscriptionProviderId: vi.fn((providerId: string | undefined) =>
    providerId === "openai-realtime" ? "openai" : providerId?.trim().toLowerCase(),
  ),
  getRealtimeTranscriptionProvider: vi.fn(),
  listRealtimeTranscriptionProviders: vi.fn(() => []),
  resolveConfiguredRealtimeVoiceProvider: vi.fn(),
  isRealtimeVoiceProviderConfigured: vi.fn(
    ({
      provider,
      cfg,
      providerConfig,
    }: {
      provider: {
        isConfigured: (ctx: { cfg?: unknown; providerConfig: unknown }) => boolean;
      };
      cfg?: unknown;
      providerConfig: unknown;
    }) => provider.isConfigured({ cfg, providerConfig }),
  ),
  resolveRealtimeVoiceProviderCapabilities: vi.fn(
    ({ provider }: { provider: { capabilities?: unknown } }) => provider.capabilities,
  ),
  resolveInternalRealtimeVoiceGatewayRelayLaunchError: vi.fn(),
  cancelInternalRealtimeVoiceBrowserSession: vi.fn(async () => undefined),
  createTalkRealtimeRelaySession: vi.fn(),
  sendTalkRealtimeRelayAudio: vi.fn(),
  acknowledgeTalkRealtimeRelayMark: vi.fn(),
  cancelTalkRealtimeRelayTurn: vi.fn(),
  stopTalkRealtimeRelaySession: vi.fn(),
  registerTalkRealtimeRelayAgentRun: vi.fn(),
  flushTalkRealtimeRelayVoiceWrites: vi.fn(async () => undefined),
  ensureTalkRealtimeRelayVoiceSession: vi.fn(),
  submitTalkRealtimeRelayToolResult: vi.fn(),
  createTalkTranscriptionRelaySession: vi.fn(),
  sendTalkTranscriptionRelayAudio: vi.fn(),
  stopTalkTranscriptionRelaySession: vi.fn(),
  chatSend: vi.fn(),
  controlRealtimeVoiceAgentRun: vi.fn(),
  steerTalkRealtimeRelayAgentRun: vi.fn(),
  resolveSessionKeyFromResolveParams: vi.fn(),
  resolveRealtimeVoiceAgentContextInstructions: vi.fn(async (): Promise<string> => ""),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-agent-workspace"),
  readSessionPreviewItemsFromTranscriptAsync: vi.fn(() => [
    { role: "user", text: "Earlier question" },
    { role: "assistant", text: "Earlier answer" },
    { role: "tool", text: "internal tool output" },
  ]),
  closeStaleClientVoiceSessions: vi.fn(async () => 0),
  createOrResumeClientVoiceSession: vi.fn(() => "voice-test"),
  ensureClientVoiceAgentSessionEntry: vi.fn(async () => "session-main"),
  resolveClientVoiceAgentSessionId: vi.fn<() => string | undefined>(() => "session-main"),
  assertClientVoiceSessionOpen: vi.fn(),
  registerClientVoiceConsultRun: vi.fn(),
  resolveOpenClientVoiceSessionId: vi.fn(),
  consultRealtimeVoiceAgent: vi.fn(async (_params?: unknown) => ({ text: "agent answer" })),
  closeTalkClientGatewayControlSession: vi.fn(async () => false),
  gatewayControlActivate: vi.fn(),
  gatewayControlAdoptProvider: vi.fn(async () => undefined),
  gatewayControlClose: vi.fn(async () => undefined),
  gatewayControl: { bindBridge: vi.fn() },
  createTalkClientGatewayControlOwner: vi.fn(),
  agentRuntime: {},
}));

vi.mock("../../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../../../state/user-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/user-preferences.js")>()),
  getCanonicalUserPreferences: mocks.getCanonicalUserPreferences,
}));

vi.mock("../../../tts/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tts/provider-registry.js")>()),
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
  listSpeechProviders: mocks.listSpeechProviders,
}));

vi.mock("../../../tts/tts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tts/tts.js")>()),
  getResolvedSpeechProviderConfig: mocks.getResolvedSpeechProviderConfig,
  resolveTtsConfig: mocks.resolveTtsConfig,
  synthesizeSpeech: mocks.synthesizeSpeech,
}));

vi.mock("../../../tts/tts-synthesis.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tts/tts-synthesis.js")>()),
  synthesizeTalkSpeech: mocks.synthesizeSpeech,
}));

vi.mock("../../../talk/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/provider-registry.js")>()),
  canonicalizeRealtimeVoiceProviderId: mocks.canonicalizeRealtimeVoiceProviderId,
  getRealtimeVoiceProvider: (providerId: string | undefined) =>
    mocks
      .listRealtimeVoiceProviders()
      .find((provider: { id: string }) => provider.id === providerId),
  listRealtimeVoiceProviders: mocks.listRealtimeVoiceProviders,
}));

vi.mock("../../../realtime-transcription/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../realtime-transcription/provider-registry.js")
  >()),
  canonicalizeRealtimeTranscriptionProviderId: mocks.canonicalizeRealtimeTranscriptionProviderId,
  getRealtimeTranscriptionProvider: mocks.getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders: mocks.listRealtimeTranscriptionProviders,
}));

vi.mock("../../../talk/provider-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/provider-resolver.js")>()),
  isRealtimeVoiceProviderConfigured: mocks.isRealtimeVoiceProviderConfigured,
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceProviderCapabilities: mocks.resolveRealtimeVoiceProviderCapabilities,
}));

vi.mock("../../../talk/provider-internal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../talk/provider-internal.js")>();
  return {
    ...actual,
    cancelInternalRealtimeVoiceBrowserSession: mocks.cancelInternalRealtimeVoiceBrowserSession,
    resolveInternalRealtimeVoiceGatewayRelayLaunchError:
      mocks.resolveInternalRealtimeVoiceGatewayRelayLaunchError,
  };
});

vi.mock("../../../talk/agent-run-control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/agent-run-control.js")>()),
  controlRealtimeVoiceAgentRun: mocks.controlRealtimeVoiceAgentRun,
}));

vi.mock("../../../talk/agent-consult-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../talk/agent-consult-runtime.js")>();
  return {
    ...actual,
    consultRealtimeVoiceAgent: mocks.consultRealtimeVoiceAgent,
  };
});

vi.mock("../../../plugins/runtime/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/runtime/index.js")>()),
  createPluginRuntime: () => ({ agent: mocks.agentRuntime }),
}));

vi.mock("../../../agents/realtime-bootstrap-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../agents/realtime-bootstrap-context.js")>()),
  resolveRealtimeVoiceAgentContextInstructions: mocks.resolveRealtimeVoiceAgentContextInstructions,
}));

vi.mock("../../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../agents/agent-scope.js")>();
  return {
    ...actual,
    resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  };
});

vi.mock("../../session-transcript-preview.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../session-transcript-preview.js")>()),
  readSessionPreviewItemsFromTranscriptAsync: mocks.readSessionPreviewItemsFromTranscriptAsync,
}));

vi.mock("../../../talk/client-voice-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../talk/client-voice-session.js")>();
  return {
    ...actual,
    assertClientVoiceSessionOpen: mocks.assertClientVoiceSessionOpen,
    closeStaleClientVoiceSessions: mocks.closeStaleClientVoiceSessions,
    createOrResumeClientVoiceSession: mocks.createOrResumeClientVoiceSession,
    ensureClientVoiceAgentSessionEntry: mocks.ensureClientVoiceAgentSessionEntry,
    registerClientVoiceConsultRun: mocks.registerClientVoiceConsultRun,
    resolveClientVoiceAgentSessionId: mocks.resolveClientVoiceAgentSessionId,
    resolveOpenClientVoiceSessionId: mocks.resolveOpenClientVoiceSessionId,
  };
});

// mock-isolation: This handler fixture simulates session creation; real snapshot
// admission and exact native rows are covered by conversation-context/target tests.
vi.mock("../conversation-context.js", () => ({
  prepareTalkProviderConversationContext: async () => ({
    instructions: "",
    assertCurrent() {},
    async release() {},
  }),
}));

vi.mock("../../server-methods/chat-send-handler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server-methods/chat-send-handler.js")>()),
  handleChatSend: mocks.chatSend,
  handleTrustedInternalChatSend: mocks.chatSend,
}));

vi.mock("../../sessions-resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions-resolve.js")>()),
  withPreparedSessionResolve: async (
    { isCurrent: _isCurrent, ...params }: Record<string, unknown>,
    consume: (result: unknown) => unknown,
  ) => consume(mocks.resolveSessionKeyFromResolveParams(params)),
}));

vi.mock("../relay/session-create.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../relay/session-create.js")>()),
  createTalkRealtimeRelaySession: mocks.createTalkRealtimeRelaySession,
}));

// The handler fixture replaces actual relay creation; real registry/lifecycle proof owns publication.
vi.mock("../relay/presentation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../relay/presentation.js")>()),
  publishTalkRealtimeRelayPresentation: vi.fn(),
}));

vi.mock("../relay/operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../relay/operations.js")>()),
  acknowledgeTalkRealtimeRelayMark: mocks.acknowledgeTalkRealtimeRelayMark,
  cancelTalkRealtimeRelayTurn: mocks.cancelTalkRealtimeRelayTurn,
  ensureTalkRealtimeRelayVoiceSession: mocks.ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites: mocks.flushTalkRealtimeRelayVoiceWrites,
  registerTalkRealtimeRelayAgentRun: mocks.registerTalkRealtimeRelayAgentRun,
  sendTalkRealtimeRelayAudio: mocks.sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun: mocks.steerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession: mocks.stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult: mocks.submitTalkRealtimeRelayToolResult,
}));

vi.mock("../client-gateway-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client-gateway-control.js")>();
  return {
    ...actual,
    closeTalkClientGatewayControlSession: mocks.closeTalkClientGatewayControlSession,
    createTalkClientGatewayControlOwner: mocks.createTalkClientGatewayControlOwner,
  };
});

vi.mock("../transcription-relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../transcription-relay.js")>();
  return {
    ...actual,
    createTalkTranscriptionRelaySession: mocks.createTalkTranscriptionRelaySession,
    sendTalkTranscriptionRelayAudio: mocks.sendTalkTranscriptionRelayAudio,
    stopTalkTranscriptionRelaySession: mocks.stopTalkTranscriptionRelaySession,
  };
});

function createBrowserProvider(
  createBrowserSession: NonNullable<RealtimeVoiceProviderPlugin["createBrowserSession"]>,
) {
  return {
    id: "openai",
    label: "OpenAI Realtime",
    isConfigured: () => true,
    createBrowserSession,
    createBridge: vi.fn(),
  };
}

function createBrowserSessionMock() {
  return vi.fn(async (_input: unknown) => ({
    provider: "openai",
    transport: "webrtc" as const,
    clientSecret: "secret",
  }));
}

function setSourceConfig(config: OpenClawConfig) {
  mocks.readConfigFileSnapshot.mockResolvedValue({
    path: "/tmp/openclaw.json",
    hash: "test-hash",
    valid: true,
    config,
  });
}

type TalkHandlerCallOptions = {
  params: Record<string, unknown>;
  respond: RespondFn;
  config?: OpenClawConfig;
  context?: unknown;
  client?: unknown;
  id?: string;
};

async function callTalkHandler(
  method: keyof typeof talkHandlers,
  {
    params,
    respond,
    config = {},
    context = { getRuntimeConfig: () => config },
    client = { connId: "conn-1" },
    id = "1",
  }: TalkHandlerCallOptions,
) {
  const admission =
    method === "talk.client.create" ||
    method === "talk.session.create" ||
    method === "talk.client.toolCall"
      ? resolveSessionMutationAuthorization({
          client: client as GatewayClient,
          context: context as GatewayRequestContext,
          method,
          requestParams: params,
        })
      : undefined;
  if (admission?.error) {
    respond(false, undefined, admission.error);
    return;
  }
  await expectDefined(
    talkHandlers[method],
    `talkHandlers["${method}"] test invariant`,
  )({
    req: { type: "req", id, method },
    params: params as never,
    client: client as never,
    isWebchatConnect: () => false,
    respond,
    context: context as never,
    // Row creation is mocked here; talk-target.test covers the real post-ensure fence.
    ...(admission?.authorization
      ? {
          sessionMutationAuthorization: {
            ...admission.authorization,
            assertTargetCurrent: vi.fn(),
          },
        }
      : {}),
  });
}

beforeEach(() => {
  setActiveDegradedSecretOwners([]);
  mocks.getRealtimeTranscriptionProvider.mockImplementation((providerId: string | undefined) => {
    const normalized = providerId?.trim().toLowerCase();
    const providers = mocks.listRealtimeTranscriptionProviders() as Array<{
      id: string;
      aliases?: string[];
    }>;
    return providers.find(
      (provider) =>
        provider.id.toLowerCase() === normalized ||
        provider.aliases?.some((alias) => alias.toLowerCase() === normalized),
    );
  });
});

afterEach(() => resetClientVoiceConfirmationStateForTest());

function markTalkOwnerCold(ownerId: string): void {
  setActiveDegradedSecretOwners([
    {
      ownerKind: "capability",
      ownerId,
      state: "unavailable",
      paths: [],
      refKeys: [],
      reason: "secret reference was not found",
    },
  ]);
}

export {
  mocks,
  createBrowserProvider,
  createBrowserSessionMock,
  setSourceConfig,
  callTalkHandler,
  markTalkOwnerCold,
};
