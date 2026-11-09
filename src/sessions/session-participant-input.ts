import { getRequesterProfile } from "../auto-reply/requester-profile.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import { isCronSessionKey } from "./session-key-utils.js";

// Core and SDK chunks share one private key; context spreads retain the same consumed fact.
export const sessionParticipantInput = Symbol.for("openclaw.sessionParticipantInput");
export type SessionParticipantInputContext = MsgContext & {
  [sessionParticipantInput]?: Array<{
    identity: SessionParticipantIdentity;
    promptedAt: number;
    recorded: boolean;
  }>;
};

/** Trusted ingress prepares once; context spreads carry the same consumed fact through retargeting. */
export function prepareSessionParticipantInput(
  ctx: SessionParticipantInputContext,
  identity: SessionParticipantIdentity,
  promptedAt = Date.now(),
): void {
  (ctx[sessionParticipantInput] ??= []).push({ identity, promptedAt, recorded: false });
}

export function readSessionInputProfileId(ctx: SessionParticipantInputContext): string | undefined {
  const identity = ctx[sessionParticipantInput]?.find(
    (input) => input.identity.type === "profile",
  )?.identity;
  return identity?.type === "profile" ? identity.id : undefined;
}

/** Copy only an already host-prepared, unambiguous person identity; never a row/display lookup. */
export function captureConsistentConversationParticipant(
  identities: readonly (SessionParticipantIdentity | undefined)[],
): SessionParticipantIdentity | undefined {
  const exact = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value === value.trim();
  const snapshots = identities.map((identity): SessionParticipantIdentity | undefined => {
    if (!identity || !exact(identity.id)) {
      return undefined;
    }
    if (identity.type === "profile") {
      return Object.freeze({ type: "profile", id: identity.id });
    }
    if (
      identity.type === "remote" &&
      exact(identity.pluginId) &&
      exact(identity.domain) &&
      exact(identity.idKind)
    ) {
      return Object.freeze({
        type: "remote",
        pluginId: identity.pluginId,
        domain: identity.domain,
        idKind: identity.idKind,
        id: identity.id,
      });
    }
    return undefined;
  });
  const first = snapshots[0];
  if (!first) {
    return undefined;
  }
  const key = JSON.stringify(first);
  return snapshots.every((identity) => identity && JSON.stringify(identity) === key)
    ? first
    : undefined;
}

/** Capture the original native input person, not the session's assigned or historical owner. */
export function readSessionConversationParticipant(
  ctx: SessionParticipantInputContext,
): SessionParticipantIdentity | undefined {
  if (
    ctx.InternalTurnSource !== undefined ||
    (ctx.InputProvenance && ctx.InputProvenance.kind !== "external_user")
  ) {
    return undefined;
  }
  const identities = ctx[sessionParticipantInput]?.map((input) => input.identity) ?? [];
  const requester = getRequesterProfile(ctx);
  const profiles = identities.filter((identity) => identity.type === "profile");
  // Native channel input records both transport provenance and its attested person.
  // Only that live, context-bound requester may unify these different identity kinds.
  if (
    requester &&
    profiles.length > 0 &&
    profiles.every((identity) => identity.id === requester.id) &&
    identities.every((identity) => identity.type === "profile" || identity.type === "remote")
  ) {
    return captureConsistentConversationParticipant(profiles);
  }
  return captureConsistentConversationParticipant(identities);
}

/** Only external turns may load the session's personal preferences; sender identity does not select them. */
export function isSessionPersonalBootstrapTurn(ctx: SessionParticipantInputContext): boolean {
  if (
    ctx.InternalTurnSource !== undefined ||
    ctx.InputProvenance?.kind === "inter_session" ||
    ctx.InputProvenance?.kind === "internal_system"
  ) {
    // Isolated cron sessions keep shared defaults; wakes in other sessions keep their selection.
    return !isCronSessionKey(ctx.SessionKey);
  }
  // Unqualified external turns must still omit the overlay and restart the prompt series.
  return (
    (!ctx.InputProvenance || ctx.InputProvenance.kind === "external_user") &&
    Boolean(ctx[sessionParticipantInput]?.length)
  );
}

/** An unqualified transport sender remains an observation, never a Gateway profile. */
export function prepareChannelParticipantObservation(ctx: SessionParticipantInputContext): void {
  const channel = ctx.Provider ?? ctx.Surface;
  if (
    ctx[sessionParticipantInput] ||
    !ctx.SenderId ||
    channel === "webchat" ||
    ctx.InternalTurnSource !== undefined ||
    (ctx.InputProvenance && ctx.InputProvenance.kind !== "external_user")
  ) {
    return;
  }
  prepareSessionParticipantInput(ctx, {
    type: "observation",
    pluginId: channel ?? null,
    accountId: ctx.AccountId ?? null,
    senderKind: ctx.SenderIsBot === true ? "bot" : ctx.SenderIsBot === false ? "human" : "unknown",
    id: ctx.SenderId,
  });
}
