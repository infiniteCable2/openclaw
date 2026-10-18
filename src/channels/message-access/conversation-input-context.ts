import { ConversationInputAdmissionError } from "../../talk/conversation-input-admission.js";
import type { AdmittedConversationInput } from "../../talk/conversation-input-admission.js";
import {
  contextAdmissionScope,
  ingressHandoffScopeMatches,
  type ChannelIngressAdmissionScope,
} from "./admission-evidence-scope-key.js";
import {
  bindConsumedHostChannelContextAdmissionEvidence,
  type consumeHostChannelIngressAdmission,
} from "./admission-evidence.js";
import type { ChannelConversationInputContextFacts } from "./conversation-input.types.js";
import type { ChannelIngressHostOwner, ChannelParticipantInput } from "./ingress-host-owner.js";
import { bindPreparedChannelParticipantInputs } from "./participant-input.js";

/** Capture canonical text-free facts at the original admission boundary, not at model dispatch. */
export function captureConversationInputContext(
  facts: ChannelConversationInputContextFacts,
  scope: ChannelIngressAdmissionScope,
): ChannelConversationInputContextFacts {
  const captured = {
    channel: facts.channel,
    accountId: facts.accountId,
    provider: facts.provider,
    surface: facts.surface,
    from: facts.from,
    sender: { ...facts.sender, roles: facts.sender.roles && [...facts.sender.roles] },
    conversation: {
      ...facts.conversation,
      routePeer: facts.conversation.routePeer && { ...facts.conversation.routePeer },
    },
    // Native enumerable binding observations must survive; they are not reconstructed from IDs.
    route: { ...facts.route },
    reply: { ...facts.reply },
    // These ordinary prepared policy/display facts are pinned once for queued execution.
    // The live route observation above is deliberately retained rather than serialized.
    access: facts.access && structuredClone(facts.access),
    channelContext: facts.channelContext && structuredClone(facts.channelContext),
  };
  const observed = contextAdmissionScope({
    channelId: captured.channel,
    accountId: captured.accountId,
    rawPrincipalRef: captured.sender.id,
    contextParams: {
      ...captured,
      messageId: scope.binding.messageId,
      message: { inboundEventKind: scope.binding.inboundEventKind },
    },
  });
  if (
    !observed ||
    !captured.from.trim() ||
    !ingressHandoffScopeMatches({
      binding: {
        channelId: scope.channelId,
        accountId: scope.accountId,
        rawPrincipalRef: scope.rawPrincipalRef,
        scope: { conversation: scope.conversation },
        contextBinding: scope.binding,
      },
      scope: observed,
    })
  ) {
    throw new ConversationInputAdmissionError();
  }
  return captured;
}

export function createConversationInputContextFactory(params: {
  facts: ChannelConversationInputContextFacts;
  scope: ChannelIngressAdmissionScope;
  owner: ChannelIngressHostOwner;
  participant: ChannelParticipantInput;
  accepted: ReturnType<typeof consumeHostChannelIngressAdmission>;
  assertCurrent: () => void;
}): NonNullable<AdmittedConversationInput["prepareContext"]> {
  const { facts, scope, owner, participant, accepted, assertCurrent } = params;
  return async (text) => {
    assertCurrent();
    const { buildChannelInboundEventContext } = await import("../inbound-event/context.js");
    assertCurrent();
    const context = buildChannelInboundEventContext({
      ...facts,
      messageId: scope.binding.messageId,
      timestamp: participant.promptedAt,
      message: {
        rawBody: text,
        sourceModality: "audio",
        inboundEventKind: scope.binding.inboundEventKind,
      },
    });
    bindConsumedHostChannelContextAdmissionEvidence({
      context,
      owner,
      scope,
      evidence: accepted.evidence,
      resolver: accepted.resolver,
    });
    bindPreparedChannelParticipantInputs({
      channelId: scope.channelId,
      owner,
      binding: scope.binding,
      context,
      inputs: [participant],
    });
    // Spoken text is ordinary conversation, not an authenticated slash-command transport.
    context.CommandInterpretationSuppressed = true;
    assertCurrent();
    return context;
  };
}
