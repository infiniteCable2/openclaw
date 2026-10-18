import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import {
  ingressHandoffScopeMatches,
  ownDataValue,
  publicResultScopeKey,
  snapshotContextBinding,
  type ChannelIngressAdmissionScope,
  type ChannelIngressResolutionScope,
} from "./admission-evidence-scope-key.js";
import type { ChannelIngressHostOwner, ChannelParticipantInput } from "./ingress-host-owner.js";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "./runtime-types.js";

type ChannelIngressResolutionBinding = Readonly<{
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
  participantOutcomeAffecting: boolean;
  identifierAuthentication: "affected" | "evaluated" | "not-evaluated";
  owner?: ChannelIngressHostOwner;
  gatewayContext?: ReturnType<GatewayContextResolver>;
  scope?: ChannelIngressResolutionScope;
  contextBinding?: Readonly<ChannelIngressContextBinding>;
  publicScopeKey?: string;
  handoff: { consumed: boolean; accepted?: boolean };
}>;

class HostIngressResolution {
  #binding: ChannelIngressResolutionBinding;
  #participant: ChannelParticipantInput | undefined;
  constructor(binding: ChannelIngressResolutionBinding, participant?: ChannelParticipantInput) {
    this.#binding = binding;
    this.#participant = participant;
    Object.setPrototypeOf(this, null);
  }
  static read(value: object): ChannelIngressResolutionBinding | undefined {
    return value !== null && typeof value === "object" && #binding in value
      ? value.#binding
      : undefined;
  }
  static takeParticipant(value: object): ChannelParticipantInput | undefined {
    if (value === null || typeof value !== "object" || !(#binding in value)) {
      return undefined;
    }
    const participant = value.#binding.handoff.accepted ? value.#participant : undefined;
    value.#participant = undefined;
    return participant;
  }
}

export function takeChannelParticipantInput(
  result: ResolvedChannelMessageIngress,
): ChannelParticipantInput | undefined {
  return HostIngressResolution.takeParticipant(result);
}

export function recordChannelIngressResolution(params: {
  result: ResolvedChannelMessageIngress;
  owner?: ChannelIngressHostOwner;
  participantInput?: ChannelParticipantInput;
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
  participantOutcomeAffecting: boolean;
  identifierAuthentication: "affected" | "evaluated" | "not-evaluated";
  scope: ChannelIngressResolutionScope;
}): ResolvedChannelMessageIngress {
  const owner = params.owner;
  if (!owner || owner.channelId !== params.channelId || !owner.isLive()) {
    return params.result;
  }
  const binding = Object.freeze({
    channelId: params.channelId,
    accountId: params.accountId,
    rawPrincipalRef: params.rawPrincipalRef,
    participantOutcomeAffecting: params.participantOutcomeAffecting,
    identifierAuthentication: params.identifierAuthentication,
    owner,
    gatewayContext: owner.resolveGatewayContext?.(),
    scope: Object.freeze({ conversation: Object.freeze({ ...params.scope.conversation }) }),
    contextBinding: snapshotContextBinding(params.scope.contextBinding),
    publicScopeKey: publicResultScopeKey(params.result),
    handoff: { consumed: false },
  });
  return Object.assign(new HostIngressResolution(binding, params.participantInput), params.result);
}

/** The sole consuming validator for both context and text-free host ingress. */
export function consumeHostIngressHandoffs(params: {
  owner?: ChannelIngressHostOwner;
  results: readonly ResolvedChannelMessageIngress[];
  maxContributions: number;
  scopeForBinding: (
    binding: ChannelIngressResolutionBinding,
    index: number,
  ) => ChannelIngressAdmissionScope | undefined;
  contextCompatibility?: boolean;
}) {
  const seen = new Set<object>();
  const bindings: ChannelIngressResolutionBinding[] = [];
  let accepted = params.results.length > 0 && params.results.length <= params.maxContributions;
  for (const [index, result] of params.results.entries()) {
    const binding = HostIngressResolution.read(result);
    const firstUse = binding !== undefined && !binding.handoff.consumed && !seen.has(result);
    if (binding && !binding.handoff.consumed) {
      // Invalid attempts also spend the exact resolver handoff, before ordinary construction.
      binding.handoff.consumed = true;
    }
    seen.add(result);
    const ownerMatches =
      params.owner !== undefined &&
      binding?.owner === params.owner &&
      binding.gatewayContext === params.owner.resolveGatewayContext?.() &&
      params.owner.isLive();
    const resultIngress = ownDataValue(result, "ingress");
    const resultMatches =
      binding?.publicScopeKey !== undefined &&
      publicResultScopeKey(result) === binding.publicScopeKey &&
      resultIngress !== null &&
      typeof resultIngress === "object" &&
      ownDataValue(resultIngress, "admission") === "dispatch";
    const scope = binding ? params.scopeForBinding(binding, index) : undefined;
    if (
      !binding ||
      !firstUse ||
      !ownerMatches ||
      !resultMatches ||
      !scope ||
      !ingressHandoffScopeMatches({
        binding,
        scope,
        contextCompatibility: params.contextCompatibility,
      })
    ) {
      accepted = false;
    } else {
      bindings.push(binding);
    }
  }
  if (
    accepted &&
    (!params.owner ||
      !params.owner.isLive() ||
      bindings.some(
        (binding) => binding.gatewayContext !== params.owner?.resolveGatewayContext?.(),
      ))
  ) {
    accepted = false;
  }
  if (accepted) {
    for (const binding of bindings) {
      binding.handoff.accepted = true;
    }
  }
  return { accepted, bindings: accepted ? bindings : [] };
}
