import {
  ErrorCodes,
  errorShape,
  readAgentRuntimeRestrictionErrorDetails,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveTextCommand } from "../../auto-reply/commands-registry.js";
import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import { resolveAgentConversationRootSessionKey } from "../../config/sessions/session-conversation-root-key.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { isBrowserOperatorUiClient } from "../../utils/message-channel.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import {
  captureGatewayPrivateConversationAudience,
  resolveGatewayInputParticipant,
} from "../session-input-participant.js";
import { loadSessionEntry, resolveSessionModelRef } from "../session-utils.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSessionEntry, type PreparedChatSendSession } from "./chat-send-session.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { resolveSessionNativeRuntimeRestriction } from "./sessions-patch-model-selection.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
/** Refuse before send admission so confirmation can retain the unsent composer. */
export async function prepareChatSendNativeRuntimeRestriction(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  assertCurrent?: () => void;
  assertCurrentAsync?: () => Promise<void>;
}): Promise<ErrorShape | undefined> {
  const { request, session, client, context } = params;
  const { entry, cfg, agentId, sessionKey, resolvedSessionModel } = session;
  if (
    request.turnKind !== "main" ||
    request.stopCommand ||
    (!entry && session.requestedSessionId) ||
    (!request.suppressCommandInterpretation && resolveTextCommand(request.inboundMessage, cfg))
  ) {
    return undefined;
  }
  const runtime = resolveEffectiveAgentRuntime({
    cfg,
    agentId,
    sessionKey,
    sessionEntry: entry,
    provider: resolvedSessionModel.provider,
    modelId: resolvedSessionModel.model,
  });
  if (runtime === "openclaw") {
    return undefined;
  }
  // Availability and implicit-runtime fallback belong to the execution selector.
  const harness = getRegisteredAgentHarness(runtime)?.harness;
  if (!harness || harness.executionEnvironment !== "host-only") {
    return undefined;
  }
  const restrictionFor = (
    config: OpenClawConfig,
    selectedEntry: Parameters<typeof resolveSessionNativeRuntimeRestriction>[0]["entry"],
    model: typeof resolvedSessionModel,
    persistedEntry?: SessionEntry,
  ) =>
    resolveSessionNativeRuntimeRestriction({
      operation: "send",
      cfg: config,
      agentId,
      sessionKey,
      entry: selectedEntry,
      persistedEntry,
      harness,
      provider: model.provider,
      modelId: model.model,
      callerCanConsent: hasGatewayAdminScope(client),
    });
  const creation = resolveOperatorSessionCreation(client);
  const prospectiveEntry =
    entry ??
    buildSessionCreationStamp({
      ...creation,
      sandbox: resolveCreatorSandbox(cfg, creation),
      now: session.now,
    });
  const restriction = restrictionFor(cfg, prospectiveEntry, resolvedSessionModel, entry);
  const details = readAgentRuntimeRestrictionErrorDetails(restriction?.details);
  if (
    entry ||
    !restriction ||
    !hasGatewayAdminScope(client) ||
    !details ||
    details.reason === "sandbox-required" ||
    details.reason === "remote-execution"
  ) {
    return restriction;
  }

  // The original authorized send initializes its real row, not its input or a run.
  // Reuse reply initialization so consent can bind the existing incarnation contract.
  const [
    { loadReplySessionInitializationSnapshot, commitReplySessionInitialization },
    { recordSessionCreated },
  ] = await Promise.all([
    import("../../config/sessions/session-accessor.reset.js"),
    import("../../sessions/session-created.js"),
  ]);
  await (params.assertCurrentAsync ? params.assertCurrentAsync() : params.assertCurrent?.());
  const scope = { agentId, sessionKey, storePath: session.storePath };
  const rootSessionKey =
    resolveAgentConversationMode(cfg, agentId) === "branches" && !isIncognitoSessionKey(sessionKey)
      ? resolveAgentConversationRootSessionKey({ cfg, agentId })
      : undefined;
  const participant = resolveGatewayInputParticipant(client, request.systemInputProvenance);
  const operator =
    rootSessionKey &&
    participant?.type === "profile" &&
    isBrowserOperatorUiClient(request.clientInfo) &&
    !request.explicitOrigin
      ? await (
          await import("../operator-run-authority.js")
        ).captureGatewayOperatorRunAuthority({
          client,
          context,
          invocationAuthority: { assertCurrent: () => params.assertCurrent?.() },
        })
      : undefined;
  try {
    const audience = operator
      ? captureGatewayPrivateConversationAudience({
          agentId,
          sessionKey,
          participant,
          operatorAuthority: operator.authority,
          assertCurrent: () => {
            params.assertCurrent?.();
            session.assertSessionTargetCurrent();
          },
        })
      : undefined;
    if (rootSessionKey) {
      const { prepareSessionConversationActivation } =
        await import("../../config/sessions/session-conversation-activation.js");
      await prepareSessionConversationActivation({
        ...scope,
        cfg,
        getConfig: context.getRuntimeConfig,
        assertCurrent: () => {
          params.assertCurrent?.();
          session.assertSessionTargetCurrent();
        },
      });
    }
    const snapshot = await loadReplySessionInitializationSnapshot(scope);
    await (params.assertCurrentAsync ? params.assertCurrentAsync() : params.assertCurrent?.());
    const sessionChanged = () =>
      errorShape(ErrorCodes.INVALID_REQUEST, "Session changed before native confirmation. Retry.");
    if (snapshot.currentEntry) {
      return sessionChanged();
    }
    const prepared = await prepareChatSendSessionEntry({
      cfg,
      client,
      agentId,
      getRuntimeConfig: context.getRuntimeConfig,
    });
    const committed = await commitReplySessionInitialization({
      ...scope,
      activeSessionKey: sessionKey,
      expectedRevision: snapshot.revision,
      sessionEntry: { ...prepared.entry, ...(audience ? { visibility: "draft" as const } : {}) },
      ...(rootSessionKey ? { branchRootSessionKey: rootSessionKey } : {}),
      ...(audience
        ? {
            prepareInitialContext: async (sessionEntry: SessionEntry) => {
              const { prepareConversationKnowledgeInitialContext } =
                await import("../../auto-reply/reply/conversation-knowledge-initial-context.js");
              return prepareConversationKnowledgeInitialContext({
                ...scope,
                cfg,
                getRuntimeConfig: context.getRuntimeConfig,
                sessionEntry,
                audience,
                assertCurrent: () => {
                  params.assertCurrent?.();
                  session.assertSessionTargetCurrent();
                },
              });
            },
          }
        : {}),
      commitGuard: () => {
        params.assertCurrent?.();
        session.assertSessionTargetCurrent();
        prepared.assertSkillSelection();
        const currentConfig = context.getRuntimeConfig();
        const current = loadSessionEntry(session.sessionLoadKey, session.sessionLoadOptions);
        const currentCreation = resolveOperatorSessionCreation(client);
        const currentModel = resolveSessionModelRef(currentConfig, undefined, agentId);
        const creationError = authorizeGatewaySessionCreation({
          cfg: currentConfig,
          client,
          agentId,
        });
        const currentRestriction = readAgentRuntimeRestrictionErrorDetails(
          restrictionFor(currentConfig, prepared.entry, currentModel)?.details,
        );
        if (
          creationError ||
          !hasGatewayAdminScope(client) ||
          current.entry ||
          current.storePath !== session.storePath ||
          current.canonicalKey !== sessionKey ||
          session.sessionRoutingChanged(currentConfig) ||
          currentCreation.actor?.id !== prepared.entry.createdActor?.id ||
          resolveCreatorSandbox(currentConfig, currentCreation) !== prepared.entry.sandbox ||
          currentModel.provider !== resolvedSessionModel.provider ||
          currentModel.model !== resolvedSessionModel.model ||
          currentRestriction?.reason !== details.reason ||
          resolveEffectiveAgentRuntime({
            cfg: currentConfig,
            agentId,
            sessionKey,
            provider: currentModel.provider,
            modelId: currentModel.model,
          }) !== runtime
        ) {
          throw new Error(
            creationError?.message ?? "Native session creation changed before commit.",
          );
        }
      },
    });
    if (!committed.ok) {
      return sessionChanged();
    }
    await recordSessionCreated(cfg, { agentId, sessionKey, entry: committed.sessionEntry });
    emitSessionsChanged(context, { agentId, sessionKey, reason: "create" });
    return restrictionFor(
      context.getRuntimeConfig(),
      committed.sessionEntry,
      resolvedSessionModel,
      committed.sessionEntry,
    );
  } finally {
    operator?.release();
  }
}
