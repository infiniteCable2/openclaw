import { prepareCommandOwnerAssertion } from "../../auto-reply/command-owner-authority.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { captureChannelOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
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
  selectBoundChannelParticipantInputs,
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
  const authority = input.commandOwnerAuthority;
  const assertOwnerCurrent = authority?.source
    ? prepareCommandOwnerAssertion({
        recoveryReference: authority.recoveryReference,
        isCurrent: () => {
          assertCurrent();
          return authority.isCurrent(gateway.getRuntimeConfig());
        },
      })
    : undefined;
  const operatorAuthority =
    authority?.operatorProfile && assertOwnerCurrent
      ? captureChannelOperatorRunAuthority({
          ...authority.operatorProfile,
          getRuntimeConfig: () => gateway.getRuntimeConfig(),
          assertCurrent: assertOwnerCurrent,
          signal: authority.signal,
        })
      : undefined;
  return createConversationInputAdmission({
    scope: params.input,
    source: {
      channelId: scope.channelId,
      accountId: scope.accountId,
      sessionKey: input.binding.sessionKey,
      nativeChannelId: input.binding.nativeChannelId,
    },
    participant: { identity: input.identity, promptedAt: input.promptedAt },
    privateAudience: prepareBoundChannelPrivateAudience({
      channelId: scope.channelId,
      accountId: scope.accountId,
      owner,
      binding: scope.binding,
      inputs: [input],
    }),
    principal: input.verifiedPrincipal,
    requesterProfile: requester,
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
