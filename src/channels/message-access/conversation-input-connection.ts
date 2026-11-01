import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/account-id.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { ConversationInputAdmissionError } from "../../talk/conversation-input-admission.js";
import { snapshotIngressAdmissionScope } from "./admission-evidence-scope-key.js";
import { consumeHostChannelIngressAdmission } from "./admission-evidence.js";
import type { ChannelConversationInputRuntimeV1 } from "./conversation-input.types.js";
import type { ChannelIngressHostOwner } from "./ingress-host-owner.js";
import {
  prepareBoundChannelPrivateAudience,
  selectBoundChannelParticipantInputs,
} from "./participant-input.js";

const log = createSubsystemLogger("conversation-knowledge");

const loadConnection = createLazyRuntimeModule(async () => {
  const [initialization, knowledge, paths, roots, publication] = await Promise.all([
    import("../../talk/client-voice-session-initialization.js"),
    import("../../auto-reply/reply/conversation-knowledge-open.js"),
    import("../../config/sessions/session-store-path.js"),
    import("../../config/sessions/session-conversation-root-key.js"),
    import("../../config/sessions/session-accessor.sqlite-entry-cache-publication.js"),
  ]);
  return {
    ensureSession: initialization.ensureClientVoiceAgentSessionEntry,
    openRecipient: knowledge.openConversationKnowledgeRecipient,
    openRoot: knowledge.openConversationKnowledgeRoot,
    resolveStorePath: paths.resolveSessionStorePathForScope,
    resolveRootKey: roots.resolveAgentConversationRootSessionKey,
    readSharingChange: publication.readPreparedSessionSharingChange,
  };
});

/** The existing ingress owner alone qualifies a recipient; opening is not a synthetic user turn. */
export async function prepareChannelConversationConnection(
  owner: ChannelIngressHostOwner,
  params: Parameters<NonNullable<ChannelConversationInputRuntimeV1["prepareConnection"]>>[0],
): Promise<void> {
  params.signal?.throwIfAborted();
  params.assertCurrent();
  const scope = snapshotIngressAdmissionScope(params.scope);
  if (!scope || scope.binding.messageId !== undefined) {
    throw new ConversationInputAdmissionError();
  }
  const rootOnly = params.purpose === "root-preparation";
  if (
    rootOnly &&
    (!params.signal ||
      !params.retainCleanup ||
      scope.binding.inboundEventKind !== "room_event" ||
      params.ingress.state.event.kind !== "conversation" ||
      params.ingress.state.event.authMode !== "inbound" ||
      params.ingress.state.event.mayPair)
  ) {
    throw new ConversationInputAdmissionError();
  }
  const accepted = consumeHostChannelIngressAdmission({ owner, ingress: params.ingress, scope });
  const [input] =
    selectBoundChannelParticipantInputs({
      channelId: scope.channelId,
      owner,
      binding: scope.binding,
      inputs: accepted.accepted ? [accepted.participantInput] : [],
    }) ?? [];
  const gateway = input?.gatewayContext;
  if (!input || !gateway) {
    throw new ConversationInputAdmissionError();
  }
  const original = prepareBoundChannelPrivateAudience({
    channelId: scope.channelId,
    accountId: scope.accountId ?? DEFAULT_ACCOUNT_ID,
    owner,
    binding: scope.binding,
    inputs: [input],
    purpose: params.purpose,
  });
  if (!original) {
    return;
  }
  const { assertCurrent: assertConnectionCurrent, signal } = params;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    assertConnectionCurrent();
    original.assertCurrent();
    if (input.requesterProfile?.isCurrent() === false) {
      throw new ConversationInputAdmissionError();
    }
  };
  assertCurrent();
  const getRuntimeConfig = () => gateway.getRuntimeConfig();
  if (resolveAgentConversationMode(getRuntimeConfig(), scope.binding.agentId) !== "branches") {
    return;
  }
  const cfg = getRuntimeConfig();
  const connection = await loadConnection();
  assertCurrent();
  const target = {
    agentId: scope.binding.agentId,
    sessionKey: scope.binding.sessionKey,
    storePath: connection.resolveStorePath(scope.binding, cfg),
  };
  const rootSessionKey = connection.resolveRootKey({ cfg, agentId: target.agentId });
  const assertTargetCurrent = () => {
    assertCurrent();
    const current = getRuntimeConfig();
    if (
      resolveAgentConversationMode(current, target.agentId) !== "branches" ||
      connection.resolveStorePath(scope.binding, current) !== target.storePath ||
      connection.resolveRootKey({ cfg: current, agentId: target.agentId }) !== rootSessionKey
    ) {
      throw new ConversationInputAdmissionError();
    }
  };
  const audience = Object.freeze({ ...original, assertCurrent: assertTargetCurrent });
  assertTargetCurrent();
  if (rootOnly) {
    // The native handoff above binds the original endpoint classification; a
    // caller's purpose alone cannot turn arbitrary ingress into startup authority.
    let registration: Awaited<ReturnType<typeof connection.openRoot>>;
    let opening: ReturnType<typeof connection.openRoot> | undefined;
    let forgetCleanup: (() => void) | undefined;
    let unsubscribe = () => {};
    let active = true;
    let state: "registered" | "prepared" | "unavailable" | "invalidated" | undefined;
    const notify = (next: NonNullable<typeof state>) => {
      if (state !== next) {
        state = next;
        params.onRootPreparationState?.(next);
      }
    };
    const close = async () => {
      active = false;
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      const current = registration ?? (await opening?.catch(() => undefined));
      await current?.close();
      forgetCleanup?.();
      forgetCleanup = undefined;
    };
    const onAbort = () => {
      // RootOwner retains and diagnoses failed cleanup; the account also joins it.
      void close().catch(() => {});
    };
    const prepared = () => {
      if (!active || !registration || !params.onRootPreparationState || state === "prepared") {
        return;
      }
      const frame = registration.acquireInitialFrame();
      if (frame) {
        void frame
          .release()
          .then(() => {
            if (active) {
              assertTargetCurrent();
              notify("prepared");
            }
          })
          .catch(() => {});
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // Publication hints never grant access. A fresh host admission must qualify
      // the endpoint again, including when its native row was absent at startup.
      unsubscribe = sessionChanges.subscribeProjection((change) => {
        if (!active) {
          return;
        }
        const relevant =
          "all" in change
            ? typeof change.scope === "string"
              ? ["config", "config-presentation", "config-profiles", "profiles"].includes(
                  change.scope,
                )
              : (change.scope.agentId === undefined || change.scope.agentId === target.agentId) &&
                (change.scope.storePath === undefined ||
                  change.scope.storePath === target.storePath)
            : change.sessionKey === target.sessionKey &&
              (change.agentId === undefined || change.agentId === target.agentId) &&
              (change.storePath === undefined || change.storePath === target.storePath) &&
              change.scope !== "runtime" &&
              change.scope !== "transcript" &&
              change.scope !== "acp" &&
              change.scope !== "automation" &&
              ((change.factsInvalidated === true && change.scope === "session-entry") ||
                connection.readSharingChange(change) === "changed" ||
                (change.facts !== undefined &&
                  (["owner", "participants", "member", "removed"].includes(change.facts.kind) ||
                    ((change.facts.kind === "entry" || change.facts.kind === "replacement") &&
                      change.facts.lifecycleChanged === true) ||
                    (change.facts.kind === "entry" &&
                      (change.facts.clearMembers ||
                        change.facts.previousSessionId !== change.facts.sessionId)))));
        if (relevant) {
          const invalidated = () => {
            if (!signal?.aborted) {
              notify("invalidated");
            }
          };
          void close()
            .then(invalidated)
            .catch(() => {
              // The original retained account cleanup remains retryable. A failed
              // close is not a successful retirement and cannot announce rearm.
              log.warn("Related-history connection cleanup remains pending.");
            });
        }
      });
      opening = connection.openRoot({
        target,
        participant: audience.participant,
        audience,
        getRuntimeConfig,
        signal,
        onReady: params.onRootPreparationState ? prepared : undefined,
      });
      registration = await opening;
      assertTargetCurrent();
      if (!active) {
        await close();
        return;
      }
      forgetCleanup = params.retainCleanup?.(close) || undefined;
      assertTargetCurrent();
      notify(registration ? "registered" : "unavailable");
      prepared();
    } catch (error) {
      await close();
      throw error;
    }
    return;
  }
  const sessionId = await connection.ensureSession({
    ...target,
    cfg,
    getRuntimeConfig,
    chatType: scope.conversation.kind,
    privateAudience: audience,
    assertCommitAllowed: assertTargetCurrent,
  });
  assertTargetCurrent();
  await connection.openRecipient({
    target: { ...target, sessionId },
    participant: audience.participant,
    audience,
    getRuntimeConfig,
    signal,
  });
  assertTargetCurrent();
}
