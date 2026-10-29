import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { captureConsistentConversationParticipant } from "./session-participant-input.js";

const audienceInput = Symbol.for("openclaw.conversationPrivateAudience");

/** Process-local, host-bound recipient evidence. Never a historical read permission. */
export type ConversationPrivateAudience = Readonly<{
  agentId: string;
  sessionKey: string;
  channelId: string;
  accountId: string;
  nativeChannelId: string;
  participant: SessionParticipantIdentity;
  assertCurrent(): void;
  /** Retain the original host principal for idle read-ahead, independently of its input turn. */
  retain?(this: void): readonly RetainedConversationPrivateAudience[];
}>;

export type RetainedConversationPrivateAudience = Readonly<{
  /** Native endpoint/source identity; channel names never identify a lease. */
  source: object;
  audience: ConversationPrivateAudience;
  signal?: AbortSignal;
  /** Normal endpoint close only; a newer admitted opening may replace this hold. */
  sourceClosed?: AbortSignal;
  /** Idempotent; the retaining owner releases replacement, revocation and retirement. */
  release(this: void): void;
}>;

function releaseRetainedAudiences(
  held: readonly RetainedConversationPrivateAudience[],
  error: unknown,
): never {
  const errors = [error];
  for (const item of held.toReversed()) {
    try {
      item.release();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
  }
  if (errors.length === 1) {
    throw error;
  }
  throw new AggregateError(errors, "Private audience retention cleanup failed");
}

/** A retained principal does not replace native recipient/root/privacy admission. */
export function retainConversationPrivateAudience(
  original: ConversationPrivateAudience,
): readonly RetainedConversationPrivateAudience[] {
  original.assertCurrent();
  let held: readonly RetainedConversationPrivateAudience[] = [];
  try {
    held = original.retain?.() ?? [{ source: original, audience: original, release() {} }];
    if (!held.length) {
      throw new Error("Private audience retention has no original source");
    }
    for (const { audience, source } of held) {
      audience.assertCurrent();
      if (
        !source ||
        typeof source !== "object" ||
        audience.agentId !== original.agentId ||
        audience.sessionKey !== original.sessionKey ||
        audience.channelId !== original.channelId ||
        audience.accountId !== original.accountId ||
        audience.nativeChannelId !== original.nativeChannelId ||
        !captureConsistentConversationParticipant([original.participant, audience.participant])
      ) {
        throw new Error("Retained private audience differs from its original input");
      }
    }
    return held;
  } catch (error) {
    return releaseRetainedAudiences(held, error);
  }
}

/** Only consumed channel ingress calls this; ordinary context fields cannot create evidence. */
export function bindConversationPrivateAudience(
  context: object,
  audience: ConversationPrivateAudience,
): void {
  Object.assign(context, { [audienceInput]: audience });
}

export function readConversationPrivateAudience(context: object) {
  // SAFETY: The symbol is installed by the host ingress binder, not by model-visible metadata.
  return Reflect.get(context, audienceInput) as ConversationPrivateAudience | undefined;
}

/** New conversation privacy follows its audience in every mode; existing histories keep their policy. */
export function capturePrivateConversationCreationAudience(params: {
  agentId: string;
  sessionKey: string;
  entry?: Pick<InternalSessionEntry, "sessionId">;
  audience?: ConversationPrivateAudience;
}): ConversationPrivateAudience | undefined {
  const { audience } = params;
  if (
    params.entry !== undefined ||
    isIncognitoSessionKey(params.sessionKey) ||
    audience?.agentId !== params.agentId ||
    audience.sessionKey !== params.sessionKey
  ) {
    return undefined;
  }
  audience.assertCurrent();
  return audience;
}

/** Collection retains every original lifetime and never upgrades a mixed/unconfirmed batch. */
export function collectConversationPrivateAudiences(
  values: readonly (ConversationPrivateAudience | undefined)[],
): ConversationPrivateAudience | undefined {
  const first = values[0];
  if (!first || values.some((value) => !value)) {
    return undefined;
  }
  const held = [...values];
  const participant = captureConsistentConversationParticipant(
    values.map((value) => value?.participant),
  );
  if (
    !participant ||
    values.some(
      (value) =>
        value?.agentId !== first.agentId ||
        value.sessionKey !== first.sessionKey ||
        value.channelId !== first.channelId ||
        value.accountId !== first.accountId ||
        value.nativeChannelId !== first.nativeChannelId,
    )
  ) {
    return undefined;
  }
  const check = () => {
    for (const value of held) {
      value!.assertCurrent();
    }
  };
  return Object.freeze({
    agentId: first.agentId,
    sessionKey: first.sessionKey,
    channelId: first.channelId,
    accountId: first.accountId,
    nativeChannelId: first.nativeChannelId,
    participant,
    assertCurrent: check,
    retain() {
      check();
      const retained: RetainedConversationPrivateAudience[] = [];
      try {
        for (const value of held) {
          retained.push(...retainConversationPrivateAudience(value!));
        }
        const audience = Object.freeze({
          agentId: first.agentId,
          sessionKey: first.sessionKey,
          channelId: first.channelId,
          accountId: first.accountId,
          nativeChannelId: first.nativeChannelId,
          participant,
          assertCurrent() {
            for (const value of retained) {
              value.audience.assertCurrent();
            }
          },
        });
        const grouped = new Map<object, RetainedConversationPrivateAudience[]>();
        for (const value of retained) {
          const values = grouped.get(value.source) ?? [];
          values.push(value);
          grouped.set(value.source, values);
        }
        const signals = retained.flatMap((value) => (value.signal ? [value.signal] : []));
        const signal = signals.length ? AbortSignal.any(signals) : undefined;
        return [...grouped].map(([source, values]) => {
          const closed = values.flatMap((value) =>
            value.sourceClosed ? [value.sourceClosed] : [],
          );
          return Object.freeze({
            source,
            audience,
            signal,
            sourceClosed: closed.length ? AbortSignal.any(closed) : undefined,
            release() {
              const errors: unknown[] = [];
              for (const value of values.toReversed()) {
                try {
                  value.release();
                } catch (error) {
                  errors.push(error);
                }
              }
              if (errors.length) {
                throw new AggregateError(errors, "Collected private audience cleanup failed");
              }
            },
          });
        });
      } catch (error) {
        return releaseRetainedAudiences(retained, error);
      }
    },
  });
}
