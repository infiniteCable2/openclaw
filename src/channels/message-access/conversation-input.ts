import { captureCommandOwnerAssertion } from "../../auto-reply/command-owner-authority.js";
import { getRequesterProfile } from "../../auto-reply/requester-profile.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/account-id.js";
import {
  createConversationInputAdmission,
  ConversationInputAdmissionError,
} from "../../talk/conversation-input-admission.js";
import { snapshotIngressAdmissionScope } from "./admission-evidence-scope-key.js";
import { consumeHostChannelIngressAdmission } from "./admission-evidence.js";
import {
  captureConversationInputContext,
  createConversationInputContextFactory,
} from "./conversation-input-context.js";
import type { AdmitChannelConversationInputV1 } from "./conversation-input.types.js";
import type { ChannelIngressHostOwner } from "./ingress-host-owner.js";
import {
  bindPreparedChannelParticipantInputs,
  selectBoundChannelParticipantInputs,
  selectChannelConversationParticipant,
  prepareBoundChannelPrivateAudience,
} from "./participant-input.js";

/** Registered host owner consumes the original policy result without constructing a chat message. */
export function admitChannelConversationInput(
  owner: ChannelIngressHostOwner,
  params: AdmitChannelConversationInputV1,
) {
  params.signal?.throwIfAborted();
  params.assertCurrent();
  const scope = snapshotIngressAdmissionScope(params.scope);
  if (
    !scope ||
    params.input.agentId !== scope.binding.agentId ||
    params.input.inputId !== scope.binding.messageId
  ) {
    throw new ConversationInputAdmissionError();
  }
  const facts = captureConversationInputContext(params.context, scope);
  const accepted = consumeHostChannelIngressAdmission({
    owner,
    ingress: params.ingress,
    scope,
  });
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
  // Captured methods and objects keep the original lifetime if a caller reuses its options object.
  const { assertCurrent: assertTransportCurrent, signal } = params;
  const requester = input.requesterProfile;
  const assertCurrent = () => {
    if (
      !owner.isLive() ||
      owner.resolveGatewayContext?.() !== gateway ||
      requester?.isCurrent() === false
    ) {
      throw new ConversationInputAdmissionError();
    }
  };
  const assertInputCurrent = composeSessionSourceAssertion(
    [assertCurrent, assertTransportCurrent],
    (assertSources) => {
      signal?.throwIfAborted();
      assertSources();
    },
  );
  // The same native binding owner qualifies text-free input and later STT materialization.
  // This carrier holds identity facts only; it is never a synthetic chat message.
  const authorityContext: MsgContext = {
    SenderId: facts.sender.id,
    AccountId: facts.route.accountId ?? facts.accountId,
    Provider: facts.provider ?? facts.channel,
    Surface: facts.surface ?? facts.channel,
    OriginatingChannel: facts.channel,
  };
  bindPreparedChannelParticipantInputs({
    channelId: scope.channelId,
    owner,
    binding: scope.binding,
    context: authorityContext,
    inputs: [input],
  });
  const preparedRequester = getRequesterProfile(authorityContext);
  if (requester && !preparedRequester) {
    throw new ConversationInputAdmissionError();
  }
  const assertOwnerCurrent = captureCommandOwnerAssertion(authorityContext);
  const operatorAuthority = preparedRequester?.operatorAuthority;
  return createConversationInputAdmission({
    scope: params.input,
    source: {
      channelId: scope.channelId,
      accountId: scope.accountId,
      sessionKey: input.binding.sessionKey,
      nativeChannelId: input.binding.nativeChannelId,
    },
    participant: {
      identity: selectChannelConversationParticipant(input),
      promptedAt: input.promptedAt,
    },
    privateAudience: prepareBoundChannelPrivateAudience({
      channelId: scope.channelId,
      accountId: scope.accountId ?? DEFAULT_ACCOUNT_ID,
      owner,
      binding: scope.binding,
      inputs: [input],
    }),
    principal: input.verifiedPrincipal,
    requesterProfile: preparedRequester,
    operatorAuthority,
    assertOwnerCurrent,
    assertCurrent,
    assertInputCurrent,
    prepareContext: createConversationInputContextFactory({
      facts,
      scope,
      owner,
      participant: input,
      accepted,
      assertCurrent,
    }),
  });
}
