import {
  bindCommandOwnerAuthority,
  captureCommandOwnerAssertion,
  getCommandOwnerAuthority,
} from "../../auto-reply/command-owner-authority.js";
import { bindRequesterProfile } from "../../auto-reply/requester-profile.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { captureChannelOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/account-id.js";
import {
  bindConversationPrivateAudience,
  collectConversationPrivateAudiences,
} from "../../sessions/conversation-private-audience.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { takeChannelParticipantInput } from "./admission-evidence.js";
import { bindChildSessionPublication } from "./child-session-publication.js";
import type { ChannelIngressHostOwner, ChannelParticipantInput } from "./ingress-host-owner.js";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "./runtime-types.js";

type ParticipantBinding = {
  channelId: string;
  binding: ChannelIngressContextBinding;
  owner: ChannelIngressHostOwner;
};

/** Both context-backed and text-free inputs consume only their exact native participant facts. */
export function selectBoundChannelParticipantInputs(
  params: ParticipantBinding & {
    inputs: readonly (ChannelParticipantInput | undefined)[];
  },
): ChannelParticipantInput[] | undefined {
  const batch = params.inputs;
  // Batched ingress uses the final transport message id; every source keeps its own accepted time.
  if (
    batch.length === 0 ||
    batch.at(-1)?.binding.messageId !== params.binding.messageId ||
    !params.owner.isLive() ||
    batch.some(
      (input) =>
        !input ||
        input.owner !== params.owner ||
        input.gatewayContext !== params.owner.resolveGatewayContext?.() ||
        input.identity.pluginId !== params.channelId ||
        input.binding.agentId !== params.binding.agentId ||
        input.binding.sessionKey !== params.binding.sessionKey ||
        input.binding.nativeChannelId !== params.binding.nativeChannelId ||
        input.binding.inboundEventKind !== params.binding.inboundEventKind,
    )
  ) {
    return undefined;
  }
  return batch.filter((input) => input !== undefined);
}

export function bindChannelParticipantInput(
  params: ParticipantBinding & {
    context: MsgContext;
    ingress:
      | ResolvedChannelMessageIngress
      | readonly ResolvedChannelMessageIngress[]
      | "unsupported"
      | undefined;
  },
): void {
  if (!params.ingress || params.ingress === "unsupported") {
    return;
  }
  const resolutions = Array.isArray(params.ingress) ? params.ingress : [params.ingress];
  bindPreparedChannelParticipantInputs({
    ...params,
    inputs: resolutions.map(takeChannelParticipantInput),
  });
}

/** Reuse original consumed participant facts when real STT becomes a native message. */
export function bindPreparedChannelParticipantInputs(
  params: ParticipantBinding & {
    context: MsgContext;
    inputs: readonly (ChannelParticipantInput | undefined)[];
  },
): void {
  const batch = selectBoundChannelParticipantInputs({
    ...params,
    inputs: params.inputs,
  });
  if (!batch) {
    return;
  }
  for (const input of batch) {
    if (input) {
      prepareSessionParticipantInput(params.context, input.identity, input.promptedAt);
    }
  }
  const privateAudience = prepareBoundChannelPrivateAudience({
    ...params,
    accountId: params.context.AccountId ?? DEFAULT_ACCOUNT_ID,
  });
  if (privateAudience) {
    bindConversationPrivateAudience(params.context, privateAudience);
  }
  // Public intent is stricter than ordinary attribution: no mixed/batched context.
  const publication = batch.length === 1 ? batch[0]?.childSessionPublication : undefined;
  if (publication?.audience === "public" && params.binding.inboundEventKind === "user_request") {
    const gateway = params.owner.resolveGatewayContext?.();
    bindChildSessionPublication(params.context, params.binding.sessionKey, () => {
      if (
        !params.owner.isLive() ||
        !gateway ||
        params.owner.resolveGatewayContext?.() !== gateway
      ) {
        throw new Error("Public ingress owner is no longer current.");
      }
      publication.assertCurrent();
    });
  }
  bindParticipantPrincipal(params, batch);
}

export function prepareBoundChannelPrivateAudience(
  params: ParticipantBinding & {
    accountId: string;
    inputs: readonly (ChannelParticipantInput | undefined)[];
  },
) {
  const batch = selectBoundChannelParticipantInputs(params);
  if (!batch || params.binding.inboundEventKind !== "user_request") {
    return undefined;
  }
  return collectConversationPrivateAudiences(
    batch.map((input) => {
      const proof = input.privateAudience;
      const nativeChannelId = input.binding.nativeChannelId;
      if (!proof || !nativeChannelId || input.identity.type !== "remote") {
        return undefined;
      }
      const gateway = params.owner.resolveGatewayContext?.();
      if (!gateway) {
        return undefined;
      }
      return Object.freeze({
        agentId: input.binding.agentId,
        sessionKey: input.binding.sessionKey,
        channelId: params.channelId,
        accountId: params.accountId,
        nativeChannelId,
        participant: Object.freeze({ ...input.identity }),
        assertCurrent: () => {
          if (!params.owner.isLive() || params.owner.resolveGatewayContext?.() !== gateway) {
            throw new Error("Private audience ingress owner is no longer current");
          }
          proof.assertCurrent();
        },
      });
    }),
  );
}

function bindParticipantPrincipal(
  params: ParticipantBinding & { context: MsgContext },
  batch: ChannelParticipantInput[],
) {
  const principal = batch.at(-1)?.verifiedPrincipal;
  const principalKey = principal && JSON.stringify(principal);
  const gateway = params.owner.resolveGatewayContext?.();
  if (
    !principal ||
    !gateway ||
    batch.some((input) => JSON.stringify(input?.verifiedPrincipal) !== principalKey)
  ) {
    return;
  }
  const requester = batch.at(-1)?.requesterProfile;
  if (
    requester &&
    params.context.SenderId === principal.senderId &&
    (params.context.AccountId ?? DEFAULT_ACCOUNT_ID) === principal.accountId &&
    params.context.OriginatingChannel === principal.channelId &&
    batch.every(
      (input) => input?.requesterProfile?.id === requester.id && input.requesterProfile.isCurrent(),
    )
  ) {
    bindRequesterProfile(params.context, {
      ...requester,
      isCurrent: () =>
        params.owner.isLive() &&
        params.owner.resolveGatewayContext?.() === gateway &&
        batch.every((input) => input?.requesterProfile?.isCurrent()),
    });
  }
  const authority = batch.at(-1)?.commandOwnerAuthority;
  if (!authority?.source || !authority.isCurrent(gateway.getRuntimeConfig())) {
    return;
  }
  bindCommandOwnerAuthority(params.context, {
    recoveryReference: authority.recoveryReference,
    isCurrent: () =>
      params.owner.isLive() &&
      params.owner.resolveGatewayContext?.() === gateway &&
      authority.isCurrent(gateway.getRuntimeConfig()),
  });
  const assertCurrent = captureCommandOwnerAssertion(params.context);
  const commandOwner = getCommandOwnerAuthority(params.context);
  if (authority.operatorProfile && assertCurrent && commandOwner) {
    bindCommandOwnerAuthority(params.context, {
      ...commandOwner,
      operatorAuthority: captureChannelOperatorRunAuthority({
        ...authority.operatorProfile,
        getRuntimeConfig: () => gateway.getRuntimeConfig(),
        assertCurrent,
        signal: authority.signal,
      }),
    });
  }
}
