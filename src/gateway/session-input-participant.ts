import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/account-id.js";
import type { ConversationPrivateAudience } from "../sessions/conversation-private-audience.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { isOperatorUiClient } from "../utils/message-channel.js";
import type { GatewayClient } from "./server-methods/shared-types.js";

/** Only the live authenticated profile establishes a person; client metadata stays unresolved. */
export function resolveGatewayInputParticipant(
  client:
    | Pick<GatewayClient, "authenticatedUserProfile" | "internal" | "connect">
    | null
    | undefined,
  provenance?: InputProvenance,
): SessionParticipantIdentity | undefined {
  if (
    !client ||
    client.internal?.syntheticClient ||
    (provenance && provenance.kind !== "external_user")
  ) {
    return undefined;
  }
  const profileId = client.authenticatedUserProfile?.profileId;
  if (profileId) {
    return { type: "profile", id: profileId };
  }
  // Direct dispatch can omit transport metadata; absence cannot identify a sender.
  const clientInfo = client.connect?.client;
  return !clientInfo || isOperatorUiClient(clientInfo)
    ? undefined
    : {
        type: "observation",
        pluginId: null,
        accountId: null,
        senderKind: "unknown",
        id: clientInfo.id,
      };
}

/**
 * Current personal Gateway ingress, not a reinterpretation of historical actors.
 * The caller owns the original private browser route and prepared native target.
 * An absent entry is allowed only for that owner's newly selected direct target.
 */
export function captureGatewayPrivateConversationAudience(input: {
  agentId: string;
  sessionKey: string;
  participant?: SessionParticipantIdentity;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** Opaque original endpoint identity, never a channel label or successor connection. */
  retentionSource?: object;
  sourceClosed?: AbortSignal;
  entry?: Pick<InternalSessionEntry, "chatType" | "publicShare">;
  assertCurrent(this: void): void;
}): ConversationPrivateAudience | undefined {
  const { participant, operatorAuthority, assertCurrent } = input;
  if (
    participant?.type !== "profile" ||
    participant.id === GATEWAY_OWNER_PROFILE_ID ||
    !operatorAuthority ||
    participant.id !== operatorAuthority.profileId ||
    (input.entry !== undefined && input.entry.chatType !== "direct") ||
    input.entry?.publicShare !== undefined
  ) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(operatorAuthority);
  const check = () => {
    assertCurrent();
    // This native authority retains the original person and policy after a normal
    // transport close. A closed output has no recipients, not a different person.
    // Revocation and a replaced target still fail; no successor connection is read.
    operatorAuthority.assertCurrent();
  };
  check();
  const metadata = {
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    channelId: "webchat",
    accountId: DEFAULT_ACCOUNT_ID,
    nativeChannelId: input.sessionKey,
    participant: Object.freeze({ ...participant }),
  };
  const retainOperator = operatorAuthority.retain;
  return Object.freeze({
    ...metadata,
    assertCurrent: check,
    ...(retainOperator
      ? {
          retain() {
            check();
            const release = retainOperator();
            let active = true;
            let released = false;
            // Only native person/policy custody outlives this input. Every idle
            // read still prepares exact current branch/root/privacy predicates.
            const audience = Object.freeze({
              ...metadata,
              assertCurrent() {
                if (!active) {
                  throw new Error("Retained private audience has been released");
                }
                operatorAuthority.assertCurrent();
              },
            });
            return [
              Object.freeze({
                source: input.retentionSource ?? operatorAuthority.source ?? operatorAuthority,
                audience,
                signal: operatorAuthority.signal,
                sourceClosed: input.sourceClosed,
                release() {
                  if (released) {
                    return;
                  }
                  active = false;
                  release();
                  released = true;
                },
              }),
            ];
          },
        }
      : {}),
  });
}
