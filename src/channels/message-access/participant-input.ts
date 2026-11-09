import {
  bindCommandOwnerAuthority,
  CommandOwnerRevokedError,
} from "../../auto-reply/command-owner-authority.js";
import { bindRequesterProfile, getRequesterProfile } from "../../auto-reply/requester-profile.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
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

/** A current administrator-linked person unifies private channels without changing transport provenance. */
export function selectChannelConversationParticipant(
  input: ChannelParticipantInput,
): SessionParticipantIdentity {
  const requester = input.requesterProfile;
  if (
    input.identity.type !== "remote" ||
    !input.privateAudience ||
    !input.verifiedPrincipal ||
    input.verifiedPrincipal.channelId !== input.identity.pluginId ||
    !requester
  ) {
    return input.identity;
  }
  if (!requester.isCurrent()) {
    throw new Error("Channel conversation profile binding is no longer current");
  }
  return Object.freeze({ type: "profile", id: requester.id });
}

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
  const { context: built, owner, binding } = params;
  for (const input of batch) {
    prepareSessionParticipantInput(built, input.identity, input.promptedAt);
  }
  // Public intent is stricter than ordinary attribution: no mixed/batched context.
  const publication = batch.length === 1 ? batch[0]?.childSessionPublication : undefined;
  if (publication?.audience === "public" && binding.inboundEventKind === "user_request") {
    const gateway = owner.resolveGatewayContext?.();
    const ownerIsCurrent = () =>
      owner.isLive() && Boolean(gateway) && owner.resolveGatewayContext?.() === gateway;
    const assertOwnerCurrent = () => {
      if (!ownerIsCurrent()) {
        throw new Error("Public ingress owner is no longer current.");
      }
    };
    const prepare = publication.prepare;
    bindChildSessionPublication(
      built,
      binding.sessionKey,
      () => {
        assertOwnerCurrent();
        publication.assertCurrent();
      },
      prepare
        ? async () => {
            if (!ownerIsCurrent()) {
              return null;
            }
            const assertCurrent = await prepare();
            if (!ownerIsCurrent() || !assertCurrent) {
              return null;
            }
            return () => {
              assertOwnerCurrent();
              assertCurrent();
            };
          }
        : undefined,
    );
  }

  bindParticipantPrincipal(params, batch);
  const privateAudience = prepareBoundChannelPrivateAudience({
    ...params,
    accountId: built.AccountId ?? DEFAULT_ACCOUNT_ID,
  });
  // A profile audience must match the native live identity bound to this exact sender.
  if (
    privateAudience &&
    (privateAudience.participant.type !== "profile" ||
      getRequesterProfile(built)?.id === privateAudience.participant.id)
  ) {
    bindConversationPrivateAudience(built, privateAudience);
  }
}

export function prepareBoundChannelPrivateAudience(
  params: ParticipantBinding & {
    accountId: string;
    inputs: readonly (ChannelParticipantInput | undefined)[];
    purpose?: "root-preparation";
  },
) {
  const batch = selectBoundChannelParticipantInputs(params);
  if (
    !batch ||
    params.binding.inboundEventKind !==
      (params.purpose === "root-preparation" ? "room_event" : "user_request")
  ) {
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
      const participant = selectChannelConversationParticipant(input);
      const requester = participant.type === "profile" ? input.requesterProfile : undefined;
      if (
        requester &&
        (input.verifiedPrincipal?.channelId !== params.channelId ||
          input.verifiedPrincipal.accountId !== params.accountId)
      ) {
        return undefined;
      }
      return Object.freeze({
        agentId: input.binding.agentId,
        sessionKey: input.binding.sessionKey,
        channelId: params.channelId,
        accountId: params.accountId,
        nativeChannelId,
        participant: Object.freeze({ ...participant }),
        assertCurrent: () => {
          if (!params.owner.isLive() || params.owner.resolveGatewayContext?.() !== gateway) {
            throw new Error("Private audience ingress owner is no longer current");
          }
          proof.assertCurrent();
          if (requester && (!requester.isCurrent() || requester.id !== participant.id)) {
            throw new Error("Channel conversation profile binding is no longer current");
          }
        },
      });
    }),
  );
}

function bindParticipantPrincipal(
  params: ParticipantBinding & { context: MsgContext },
  batch: ChannelParticipantInput[],
) {
  const { context: built, owner } = params;
  const principal = batch.at(-1)?.verifiedPrincipal;
  const principalKey = principal && JSON.stringify(principal);
  const gateway = owner.resolveGatewayContext?.();
  if (!gateway) {
    return;
  }
  const requester = batch.at(-1)?.requesterProfile;
  let operatorAuthority: ReturnType<typeof captureChannelOperatorRunAuthority> | undefined;
  if (
    principal &&
    requester &&
    built.SenderId === principal.senderId &&
    (built.AccountId ?? DEFAULT_ACCOUNT_ID) === principal.accountId &&
    built.OriginatingChannel === principal.channelId &&
    batch.every(
      (input) =>
        JSON.stringify(input?.verifiedPrincipal) === principalKey &&
        input?.requesterProfile?.id === requester.id &&
        input.requesterProfile.isCurrent(),
    )
  ) {
    // Retain the remote provenance and record the attested human contribution too.
    for (const input of batch) {
      if (input) {
        prepareSessionParticipantInput(
          built,
          { type: "profile", id: requester.id },
          input.promptedAt,
        );
      }
    }
    const prepared = batch.at(-1)?.operatorAuthority;
    const operatorIsCurrent = () =>
      owner.isLive() &&
      owner.resolveGatewayContext?.() === gateway &&
      batch.every((input) => input?.operatorAuthority?.isCurrent(gateway.getRuntimeConfig()));
    if (prepared && operatorIsCurrent()) {
      operatorAuthority = captureChannelOperatorRunAuthority({
        ...prepared.operatorProfile,
        recoveryReference: prepared.recoveryReference,
        getRuntimeConfig: () => gateway.getRuntimeConfig(),
        signal: prepared.signal,
        assertCurrent: () => {
          if (!operatorIsCurrent()) {
            throw new CommandOwnerRevokedError(
              "Channel operator authority changed; send a new request.",
            );
          }
        },
      });
    }
    bindRequesterProfile(built, {
      ...requester,
      operatorAuthority,
      isCurrent: () =>
        owner.isLive() &&
        owner.resolveGatewayContext?.() === gateway &&
        batch.every((input) => input?.requesterProfile?.isCurrent()),
    });
  }
  const authority = batch.at(-1)?.commandOwnerAuthority;
  const ownerPrincipal = batch.at(-1)?.commandOwnerPrincipal;
  if (
    !authority?.source ||
    !ownerPrincipal ||
    built.SenderId !== ownerPrincipal.senderId ||
    (built.AccountId ?? DEFAULT_ACCOUNT_ID) !== ownerPrincipal.accountId ||
    built.OriginatingChannel !== ownerPrincipal.channelId ||
    batch.some(
      (input) => JSON.stringify(input?.commandOwnerPrincipal) !== JSON.stringify(ownerPrincipal),
    ) ||
    !authority.isCurrent(gateway.getRuntimeConfig())
  ) {
    return;
  }
  bindCommandOwnerAuthority(built, {
    recoveryReference: authority.recoveryReference,
    operatorAuthority,
    isCurrent: () =>
      owner.isLive() &&
      owner.resolveGatewayContext?.() === gateway &&
      authority.isCurrent(gateway.getRuntimeConfig()),
  });
}
