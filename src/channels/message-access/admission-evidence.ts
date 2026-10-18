import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import {
  createChannelAdmissionDecisionReceipt,
  type ChannelAdmissionDecisionReceiptInput,
} from "./admission-decision-receipt.js";
import {
  finalizedContextScopeKey,
  ownDataValue,
  scopedParticipantRef,
  snapshotIngressAdmissionScope,
  contextAdmissionScope,
  type ChannelIngressAdmissionScope,
} from "./admission-evidence-scope-key.js";
import { consumeHostIngressHandoffs, takeChannelParticipantInput } from "./admission-handoff.js";
import type { ChannelIngressHostOwner, ChannelParticipantInput } from "./ingress-host-owner.js";
import type { ResolvedChannelMessageIngress } from "./runtime-types.js";

export {
  recordChannelIngressResolution,
  takeChannelParticipantInput,
} from "./admission-handoff.js";

export type ChannelAdmissionEvidence = Readonly<{
  kind: "channel-admission-evidence";
}>;

type ChannelAdmissionContribution = Readonly<{
  participant:
    | { state: "present"; rawPrincipalRef: string }
    | { state: "unknown" }
    | { state: "unsupported" };
  decision?: Readonly<{
    participantAware: boolean;
    outcomeAffecting: boolean;
    identifierAuthentication: "affected" | "evaluated" | "not-evaluated";
  }>;
}>;

type ChannelAdmissionEvidencePayload =
  | Readonly<{
      kind: "leaf";
      createdAt: number;
      contribution: ChannelAdmissionContribution;
    }>
  | Readonly<{
      kind: "aggregate";
      createdAt: number;
      sources: readonly (ChannelAdmissionEvidence | undefined)[];
    }>;

type ConsumedChannelAdmissionEvidence = Readonly<{
  ingressState: "present" | "unknown" | "unsupported";
  invoker: { state: "present"; kind: "person"; rawPrincipalRef: string } | { state: "unknown" };
  assuranceRef?: string;
  decisionCoverage?: "enforced" | "attribution-only" | "unknown" | "unsupported";
  identifierAuthentication?: "affected" | "evaluated" | "not-evaluated" | "unknown";
}>;

const CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS = 16;
const CHANNEL_ADMISSION_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const CONTEXT_ADMISSION = Symbol("openclaw.channelContextAdmission");

export class ChannelAdmissionAudit {
  #enabled: boolean;
  #closed = false;
  #revision = {};
  #sink: ((receipt: DecisionReceiptV1) => boolean) | undefined;
  constructor(params: {
    enabled: boolean;
    decisionSink?: (receipt: DecisionReceiptV1) => boolean;
  }) {
    this.#enabled = params.enabled;
    this.#sink = params.decisionSink;
  }
  get enabled(): boolean {
    return this.#enabled;
  }
  configure(enabled: boolean): void {
    if (this.#closed || enabled === this.#enabled) {
      return;
    }
    this.#enabled = enabled;
    this.#revision = {};
  }
  captureCurrent(): () => boolean {
    const revision = this.#revision;
    return () => this.#enabled && this.#revision === revision;
  }
  recordDecision(receipt: DecisionReceiptV1): boolean {
    return this.#enabled ? (this.#sink?.(receipt) ?? false) : false;
  }
  close(): void {
    this.#closed = true;
    this.#enabled = false;
    this.#revision = {};
    this.#sink = undefined;
  }
}

export function createChannelAdmissionAudit(params: {
  enabled: boolean;
  decisionSink?: (receipt: DecisionReceiptV1) => boolean;
}): ChannelAdmissionAudit {
  return new ChannelAdmissionAudit(params);
}

class AdmissionEvidence implements ChannelAdmissionEvidence {
  readonly kind = "channel-admission-evidence";
  #payload: ChannelAdmissionEvidencePayload;
  #audit: ChannelAdmissionAudit | undefined;
  #isCurrent: (() => boolean) | undefined;
  #consumed = false;
  constructor(payload: ChannelAdmissionEvidencePayload, audit: ChannelAdmissionAudit | undefined) {
    this.#payload = payload;
    this.#audit = audit;
    this.#isCurrent = audit?.captureCurrent();
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }
  static read(value: ChannelAdmissionEvidence | undefined) {
    return value !== undefined &&
      value !== null &&
      typeof value === "object" &&
      #payload in value &&
      (value.#isCurrent?.() ?? true)
      ? { payload: value.#payload, audit: value.#audit, consumed: value.#consumed }
      : undefined;
  }
  static consume(value: ChannelAdmissionEvidence): void {
    if (value !== null && typeof value === "object" && #payload in value) {
      value.#consumed = true;
    }
  }
}

class PreparedChannelAdmissionEvidence {
  #consumed = false;
  #evidence: ChannelAdmissionEvidence | undefined;
  #resolver: GatewayContextResolver | undefined;
  #owner: ChannelIngressHostOwner | undefined;
  #gatewayContext: ReturnType<GatewayContextResolver>;
  constructor(
    evidence: ChannelAdmissionEvidence | undefined,
    resolver?: GatewayContextResolver,
    owner?: ChannelIngressHostOwner,
  ) {
    this.#evidence = evidence;
    this.#resolver = resolver;
    this.#owner = owner;
    this.#gatewayContext = owner?.resolveGatewayContext?.();
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }
  static take(value: PreparedChannelAdmissionEvidence) {
    if (!value || typeof value !== "object" || !(#consumed in value) || value.#consumed) {
      return undefined;
    }
    value.#consumed = true;
    const current =
      !value.#owner ||
      (value.#owner.isLive() && value.#owner.resolveGatewayContext?.() === value.#gatewayContext);
    return {
      evidence: current
        ? value.#evidence
        : unknownChannelAdmissionEvidence(AdmissionEvidence.read(value.#evidence)?.audit),
      resolver: current ? value.#resolver : undefined,
    };
  }
}

type ContextAdmissionValue = {
  scope: string | undefined;
  evidence: ChannelAdmissionEvidence | undefined;
  resolver?: GatewayContextResolver;
  resolverConflict?: boolean;
};
class ContextAdmission {
  #context: object;
  #value: Readonly<ContextAdmissionValue>;
  constructor(context: object, value: ContextAdmissionValue) {
    this.#context = context;
    this.#value = Object.freeze(value);
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }
  static read(value: unknown, context: object): Readonly<ContextAdmissionValue> | undefined {
    return value !== null &&
      typeof value === "object" &&
      #context in value &&
      value.#context === context
      ? value.#value
      : undefined;
  }
}
function readContextAdmission(context: object): Readonly<ContextAdmissionValue> | undefined {
  return ContextAdmission.read(ownDataValue(context, CONTEXT_ADMISSION), context);
}
function writeContextAdmission(context: object, value: ContextAdmissionValue): void {
  Object.defineProperty(context, CONTEXT_ADMISSION, {
    value: new ContextAdmission(context, value),
    configurable: true,
  });
}

function mintChannelAdmissionEvidence(
  audit: ChannelAdmissionAudit | undefined,
  payload:
    | Omit<Extract<ChannelAdmissionEvidencePayload, { kind: "leaf" }>, "createdAt">
    | Omit<Extract<ChannelAdmissionEvidencePayload, { kind: "aggregate" }>, "createdAt">,
): ChannelAdmissionEvidence | undefined {
  if (!audit?.enabled) {
    return undefined;
  }
  return new AdmissionEvidence(Object.freeze({ ...payload, createdAt: Date.now() }), audit);
}
function unsupportedChannelAdmissionEvidence(
  audit: ChannelAdmissionAudit | undefined,
): ChannelAdmissionEvidence | undefined {
  const payload = {
    kind: "leaf" as const,
    contribution: Object.freeze({ participant: { state: "unsupported" as const } }),
  };
  // A capability-absence marker carries no participant facts and needs no ambient collector.
  return audit
    ? mintChannelAdmissionEvidence(audit, payload)
    : new AdmissionEvidence(Object.freeze({ ...payload, createdAt: Date.now() }), undefined);
}

function participantContribution(params: {
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
}): ChannelAdmissionContribution {
  const rawPrincipalRef = scopedParticipantRef(params);
  return Object.freeze(
    rawPrincipalRef
      ? { participant: Object.freeze({ state: "present" as const, rawPrincipalRef }) }
      : { participant: Object.freeze({ state: "unknown" as const }) },
  );
}

function unknownChannelAdmissionEvidence(
  audit: ChannelAdmissionAudit | undefined,
): ChannelAdmissionEvidence | undefined {
  return mintChannelAdmissionEvidence(audit, {
    kind: "leaf",
    contribution: Object.freeze({ participant: { state: "unknown" as const } }),
  });
}

function handoffEvidence(
  audit: ChannelAdmissionAudit | undefined,
  handoff: ReturnType<typeof consumeHostIngressHandoffs>,
): ChannelAdmissionEvidence | undefined {
  if (!handoff.accepted) {
    return unknownChannelAdmissionEvidence(audit);
  }
  return combineChannelAdmissionEvidence(
    handoff.bindings.map((binding) => {
      const contribution = participantContribution(binding);
      return mintChannelAdmissionEvidence(audit, {
        kind: "leaf",
        contribution: Object.freeze({
          ...contribution,
          decision: Object.freeze({
            participantAware: contribution.participant.state === "present",
            outcomeAffecting: binding.participantOutcomeAffecting,
            identifierAuthentication: binding.identifierAuthentication,
          }),
        }),
      });
    }),
  );
}

/** Consume one exact host resolver handoff without manufacturing a text context. */
export function consumeHostChannelIngressAdmission(params: {
  owner: ChannelIngressHostOwner;
  ingress: ResolvedChannelMessageIngress;
  scope: ChannelIngressAdmissionScope;
}): {
  accepted: boolean;
  evidence?: ChannelAdmissionEvidence;
  resolver?: GatewayContextResolver;
  participantInput?: ChannelParticipantInput;
} {
  const audit = params.owner.resolveGatewayContext?.()?.channelAdmissionAudit;
  const scope = snapshotIngressAdmissionScope(params.scope);
  const handoff = consumeHostIngressHandoffs({
    owner: params.owner,
    results: [params.ingress],
    maxContributions: 1,
    scopeForBinding: () => scope,
  });
  return {
    accepted: handoff.accepted,
    evidence: handoffEvidence(audit, handoff),
    resolver: handoff.accepted ? params.owner.resolveGatewayContext : undefined,
    participantInput: handoff.accepted ? takeChannelParticipantInput(params.ingress) : undefined,
  };
}

/** Consume and validate the exact resolver-to-context handoff before context construction. */
export function prepareHostChannelContextAdmissionEvidence(params: {
  owner?: ChannelIngressHostOwner;
  channelId: string;
  accountId?: string;
  ingress?:
    | ResolvedChannelMessageIngress
    | readonly ResolvedChannelMessageIngress[]
    | "unsupported";
  rawPrincipalRef: string | number | null | undefined;
  contextParams: object;
}): PreparedChannelAdmissionEvidence {
  const audit = params.owner?.resolveGatewayContext?.()?.channelAdmissionAudit;
  if (params.ingress === "unsupported") {
    return new PreparedChannelAdmissionEvidence(
      unsupportedChannelAdmissionEvidence(audit),
      undefined,
      params.owner,
    );
  }
  const results =
    params.ingress === undefined
      ? []
      : Array.isArray(params.ingress)
        ? params.ingress
        : [params.ingress as ResolvedChannelMessageIngress];
  const handoff = consumeHostIngressHandoffs({
    owner: params.owner,
    results,
    maxContributions: CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS,
    contextCompatibility: true,
    scopeForBinding: (binding, index) => {
      const scope = contextAdmissionScope({
        ...params,
        // A batch exposes the final sender; earlier sources retain their own exact identities.
        rawPrincipalRef:
          index === results.length - 1 ? params.rawPrincipalRef : binding.rawPrincipalRef,
      });
      if (scope && index !== results.length - 1) {
        return {
          ...scope,
          binding: { ...scope.binding, messageId: binding.contextBinding?.messageId },
        };
      }
      return scope;
    },
  });
  return new PreparedChannelAdmissionEvidence(
    handoffEvidence(audit, handoff),
    handoff.accepted ? params.owner?.resolveGatewayContext : undefined,
    params.owner,
  );
}

/** Attach one prepared private carrier to the exact finalized context scope. */
export function bindHostChannelContextAdmissionEvidence(params: {
  context: object;
  preparation: PreparedChannelAdmissionEvidence;
}): void {
  const prepared = PreparedChannelAdmissionEvidence.take(params.preparation);
  const scope = finalizedContextScopeKey(params.context);
  const audit = AdmissionEvidence.read(prepared?.evidence)?.audit;
  writeContextAdmission(params.context, {
    scope,
    evidence: scope !== undefined ? prepared?.evidence : unknownChannelAdmissionEvidence(audit),
    resolver: scope !== undefined ? prepared?.resolver : undefined,
  });
}

/** Bind already consumed host ingress; never resolve or consume it again for STT projection. */
export function bindConsumedHostChannelContextAdmissionEvidence(params: {
  context: import("../../auto-reply/templating.js").MsgContext;
  owner: ChannelIngressHostOwner;
  scope: ChannelIngressAdmissionScope;
  evidence: ChannelAdmissionEvidence | undefined;
  resolver: GatewayContextResolver | undefined;
}): void {
  const { context, scope } = params;
  const current = params.owner.isLive() && params.owner.resolveGatewayContext === params.resolver;
  const key = finalizedContextScopeKey(context);
  if (
    !current ||
    key === undefined ||
    context.OriginatingChannel !== scope.channelId ||
    (context.AccountId || "default") !== (scope.accountId || "default") ||
    context.SenderId !==
      (scope.rawPrincipalRef == null ? undefined : String(scope.rawPrincipalRef)) ||
    context.ChatType !== scope.conversation.kind ||
    context.ChatId !== scope.conversation.id ||
    context.AgentId !== scope.binding.agentId ||
    context.SessionKey !== scope.binding.sessionKey ||
    context.MessageSid !== scope.binding.messageId ||
    context.NativeChannelId !== scope.binding.nativeChannelId ||
    context.InboundEventKind !== scope.binding.inboundEventKind
  ) {
    throw new Error("Consumed channel input does not match its finalized context");
  }
  writeContextAdmission(context, {
    scope: key,
    evidence: params.evidence,
    resolver: params.resolver,
  });
}
export function readChannelContextAdmissionEvidence(
  context: object,
): ChannelAdmissionEvidence | undefined {
  return readContextAdmission(context)?.evidence;
}
export function readChannelContextGatewayContextResolver(
  context: object,
): GatewayContextResolver | undefined {
  return readContextAdmission(context)?.resolver;
}

/** Core-only non-channel host routing; this neither upgrades evidence nor grants person access. */
export function bindHostConversationContextGatewayResolver(params: {
  context: object;
  resolveGatewayContext: GatewayContextResolver;
  assertCurrent(): void;
}): void {
  const { context, resolveGatewayContext, assertCurrent } = params;
  assertCurrent();
  const original = readContextAdmission(context);
  const scope = finalizedContextScopeKey(context);
  if (!original || scope === undefined || original.scope !== scope || original.resolver) {
    throw new Error(
      "Conversation host context is unavailable, changed or already has a routing owner",
    );
  }
  const gateway = resolveGatewayContext();
  if (!gateway) throw new Error("Conversation host Gateway is unavailable");
  const resolveOriginal = () => {
    assertCurrent();
    if (finalizedContextScopeKey(context) !== scope || resolveGatewayContext() !== gateway) {
      throw new Error("Conversation host source or Gateway changed");
    }
    assertCurrent();
    return gateway;
  };
  resolveOriginal();
  writeContextAdmission(context, { ...original, resolver: resolveOriginal });
}

/** Preserve private evidence only when its owner explicitly replaces an unchanged context. */
export function copyChannelParticipantAdmissionEvidence(source: object, target: object): void {
  const original = readContextAdmission(source);
  if (!original) {
    return;
  }
  const targetScope = finalizedContextScopeKey(target);
  const sameScope = original.scope !== undefined && targetScope === original.scope;
  const safeEvidence =
    sameScope && activePayload(original.evidence, Date.now()) !== undefined
      ? original.evidence
      : unknownChannelAdmissionEvidence(AdmissionEvidence.read(original.evidence)?.audit);
  const current = readContextAdmission(target);
  const resolverConflict =
    current?.resolverConflict === true ||
    Boolean(current?.resolver && original.resolver && current.resolver !== original.resolver);
  writeContextAdmission(target, {
    scope: targetScope,
    evidence: safeEvidence,
    resolver: sameScope && !resolverConflict ? original.resolver : undefined,
    resolverConflict,
  });
}

function activePayload(
  evidence: ChannelAdmissionEvidence | undefined,
  now: number,
): ChannelAdmissionEvidencePayload | undefined {
  const stored = AdmissionEvidence.read(evidence);
  if (!stored || stored.consumed) {
    return undefined;
  }
  const { payload, audit } = stored;
  return (!audit || audit.enabled) &&
    now - payload.createdAt <= CHANNEL_ADMISSION_EVIDENCE_MAX_AGE_MS
    ? payload
    : undefined;
}

/** Preserve one source exactly; collected sources get one new bounded opaque aggregate. */
export function combineChannelAdmissionEvidence(
  evidence: readonly (ChannelAdmissionEvidence | undefined)[],
): ChannelAdmissionEvidence | undefined {
  if (evidence.length === 1) {
    return evidence[0];
  }
  const audit = evidence
    .map((entry) => AdmissionEvidence.read(entry)?.audit)
    .find((entry) => entry !== undefined);
  if (!audit?.enabled) {
    return undefined;
  }
  if (
    evidence.length > CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS ||
    evidence.some((entry) => AdmissionEvidence.read(entry)?.audit !== audit)
  ) {
    return unknownChannelAdmissionEvidence(audit);
  }
  return mintChannelAdmissionEvidence(audit, {
    kind: "aggregate",
    sources: Object.freeze([...evidence]),
  });
}

function readContributions(params: {
  evidence: ChannelAdmissionEvidence | undefined;
  now: number;
  seen: Set<object>;
  consume: boolean;
}): ChannelAdmissionContribution[] {
  const payload = activePayload(params.evidence, params.now);
  if (!payload || !params.evidence || params.seen.has(params.evidence)) {
    return [{ participant: { state: "unknown" } }];
  }
  params.seen.add(params.evidence);
  if (params.consume) {
    AdmissionEvidence.consume(params.evidence);
  }
  if (payload.kind === "leaf") {
    return [payload.contribution];
  }
  const contributions = payload.sources.flatMap((source) =>
    readContributions({ ...params, evidence: source }),
  );
  return !params.consume || contributions.length <= CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS
    ? contributions
    : [{ participant: { state: "unknown" } }];
}

function sharedParticipantRef(contributions: readonly ChannelAdmissionContribution[]) {
  const first = contributions[0]?.participant;
  return first?.state === "present" &&
    contributions.every(
      ({ participant }) =>
        participant.state === "present" && participant.rawPrincipalRef === first.rawPrincipalRef,
    )
    ? first.rawPrincipalRef
    : undefined;
}

/** Compare opaque participants without exposing or consuming their raw references. */
export function compareChannelAdmissionParticipants(
  evidence: readonly (ChannelAdmissionEvidence | undefined)[],
): "same" | "mixed-or-unknown" {
  const contributions = evidence.flatMap((candidate) =>
    readContributions({ evidence: candidate, now: Date.now(), seen: new Set(), consume: false }),
  );
  if (
    contributions.length === 0 ||
    contributions.length > CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS
  ) {
    return "mixed-or-unknown";
  }
  return sharedParticipantRef(contributions) !== undefined ? "same" : "mixed-or-unknown";
}

function freezeConsumed(value: ConsumedChannelAdmissionEvidence): ConsumedChannelAdmissionEvidence {
  return Object.freeze({
    ...value,
    invoker: Object.freeze(value.invoker),
  });
}

/** Consume one aggregate at run admission. Missing, forged, stale, or reused carriers are unknown. */
export function consumeChannelAdmissionEvidence(
  evidence: ChannelAdmissionEvidence | undefined,
): ConsumedChannelAdmissionEvidence {
  const contributions = readContributions({
    evidence,
    now: Date.now(),
    seen: new Set(),
    consume: true,
  });
  const allUnsupported =
    contributions.length > 0 &&
    contributions.every(({ participant }) => participant.state === "unsupported");
  const rawPrincipalRef = allUnsupported ? undefined : sharedParticipantRef(contributions);
  if (rawPrincipalRef === undefined) {
    const ingressState = allUnsupported ? "unsupported" : "unknown";
    return freezeConsumed({
      ingressState,
      invoker: { state: "unknown" },
      decisionCoverage: ingressState,
      identifierAuthentication: "unknown",
    });
  }

  const everyDecisionEnforced = contributions.every(
    (item) => item.decision?.participantAware && item.decision.outcomeAffecting,
  );
  const identifierAuthentication = contributions.some(
    (item) => item.decision?.identifierAuthentication === "affected",
  )
    ? "affected"
    : contributions.some((item) => item.decision?.identifierAuthentication === "evaluated")
      ? "evaluated"
      : contributions.every((item) => item.decision?.identifierAuthentication === "not-evaluated")
        ? "not-evaluated"
        : "unknown";
  return freezeConsumed({
    ingressState: "present",
    invoker: {
      state: "present",
      kind: "person",
      rawPrincipalRef,
    },
    assuranceRef: "channel-admission",
    decisionCoverage: everyDecisionEnforced ? "enforced" : "attribution-only",
    identifierAuthentication,
  });
}

/** Queue the channel decision after its exact identity tuple on the shared audit FIFO. */
export function recordChannelAdmissionDecision(
  evidence: ChannelAdmissionEvidence | undefined,
  params: ChannelAdmissionDecisionReceiptInput,
): boolean {
  const stored = AdmissionEvidence.read(evidence);
  return stored?.audit
    ? stored.audit.recordDecision(createChannelAdmissionDecisionReceipt(params))
    : false;
}
