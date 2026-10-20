import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { PreparedRequesterProfile } from "../auto-reply/requester-profile.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { ConversationPrivateAudience } from "../sessions/conversation-private-audience.js";
import type { UserChannelIdentity } from "../state/user-profiles.types.js";
import type {
  ConversationInputAdmissionV1,
  ConversationInputScopeV1,
} from "./conversation-input.types.js";

/** Facts are supplied only by a native ingress owner, never by plugin/model fields. */
export type AdmittedConversationInput = Readonly<{
  scope: ConversationInputScopeV1;
  source: Readonly<{
    channelId: string;
    accountId?: string;
    /** Final dispatch binding; neither the source-context read grant nor spawnedBy. */
    sessionKey: string;
    nativeChannelId?: string;
  }>;
  participant?: Readonly<{
    identity: SessionParticipantIdentity;
    /** Original ingress time, not the later model/worker admission time. */
    promptedAt: number;
  }>;
  principal?: UserChannelIdentity;
  privateAudience?: ConversationPrivateAudience;
  requesterProfile?: PreparedRequesterProfile;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** Native command-owner assertion; absence must not become owner access. */
  assertOwnerCurrent?: SessionSourceAssertion;
  /** Input/transport admission only; closing audio must not cancel accepted work. */
  assertInputCurrent: SessionSourceAssertion;
  /** Retained original authorization, independent of the input transport's lifetime. */
  assertCurrent: SessionSourceAssertion;
  /** Original host projection, not a plugin-provided message or a fresh authority issuer. */
  prepareContext?: (text: string) => MsgContext | Promise<MsgContext>;
  /** Original host authority hold; transferred to the one native execution consumer. */
  release?: () => void;
}>;

export type ConsumedConversationInput = Omit<AdmittedConversationInput, "prepareContext">;

export class ConversationInputAdmissionError extends Error {
  constructor() {
    super("Conversation input admission is unavailable or no longer current");
    this.name = "ConversationInputAdmissionError";
  }
}

/** The accepted input owns one execution transfer; no second idempotency registry. */
class AcceptedConversationInput {
  #executionTransferred = false;
  #contextPrepared = false;
  #prepareContext: AdmittedConversationInput["prepareContext"];

  constructor(prepareContext: AdmittedConversationInput["prepareContext"]) {
    this.#prepareContext = prepareContext;
  }

  static capture(input: AdmittedConversationInput): ConsumedConversationInput {
    const { prepareContext, ...facts } = input;
    const accepted = Object.assign(new AcceptedConversationInput(prepareContext), facts);
    Object.setPrototypeOf(accepted, null);
    return Object.freeze(accepted);
  }

  static claim(input: ConsumedConversationInput): void {
    if (!(#executionTransferred in input) || input.#executionTransferred) {
      throw new ConversationInputAdmissionError();
    }
    input.#executionTransferred = true;
    // Accepted audio may have closed; original authorization must still hold.
    input.assertCurrent();
  }

  static async prepareContext(input: ConsumedConversationInput, text: string): Promise<MsgContext> {
    if (
      !(#executionTransferred in input) ||
      !input.#executionTransferred ||
      input.#contextPrepared ||
      !input.#prepareContext
    ) {
      throw new ConversationInputAdmissionError();
    }
    input.#contextPrepared = true;
    input.assertCurrent();
    const prepare = input.#prepareContext;
    input.#prepareContext = undefined;
    const context = await prepare(text);
    input.assertCurrent();
    if (context.AgentId !== input.scope.agentId || context.SessionKey !== input.source.sessionKey) {
      throw new ConversationInputAdmissionError();
    }
    return context;
  }
}

class ConversationInputAdmission implements ConversationInputAdmissionV1 {
  readonly version = 1;
  readonly kind = "conversation-input-admission";
  #input: AdmittedConversationInput | undefined;

  constructor(input: AdmittedConversationInput) {
    this.#input = input;
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static take(value: ConversationInputAdmissionV1, scope: ConversationInputScopeV1) {
    if (!value || typeof value !== "object" || !(#input in value)) {
      throw new ConversationInputAdmissionError();
    }
    const input = value.#input;
    // Refused handoffs are consumed too; a capability cannot probe alternate targets.
    value.#input = undefined;
    if (
      !input ||
      input.scope.agentId !== scope.agentId ||
      input.scope.conversationId !== scope.conversationId ||
      input.scope.inputId !== scope.inputId ||
      input.scope.purpose !== scope.purpose
    ) {
      input?.release?.();
      throw new ConversationInputAdmissionError();
    }
    try {
      input.assertInputCurrent();
    } catch (error) {
      input.release?.();
      throw error;
    }
    return AcceptedConversationInput.capture(input);
  }

  static release(value: ConversationInputAdmissionV1): void {
    if (!value || typeof value !== "object" || !(#input in value)) {
      throw new ConversationInputAdmissionError();
    }
    const input = value.#input;
    value.#input = undefined;
    input?.release?.();
  }
}

/** Host-only issuer. Public SDK contracts expose the opaque type, not this operation. */
export function createConversationInputAdmission(
  input: AdmittedConversationInput,
): ConversationInputAdmissionV1 {
  const scope = Object.freeze({ ...input.scope });
  if (
    [
      scope.agentId,
      scope.conversationId,
      scope.inputId,
      input.source.channelId,
      input.source.sessionKey,
    ].some((value) => !value.trim()) ||
    !["user", "steering", "greeting"].includes(scope.purpose)
  ) {
    throw new ConversationInputAdmissionError();
  }
  const assertCurrent = composeSessionSourceAssertion([
    input.assertCurrent,
    input.assertOwnerCurrent,
    input.operatorAuthority?.assertCurrent,
  ]);
  const assertInputCurrent = composeSessionSourceAssertion([
    assertCurrent,
    input.assertInputCurrent,
  ]);
  assertInputCurrent();
  return new ConversationInputAdmission(
    Object.freeze({
      ...input,
      scope,
      source: Object.freeze({ ...input.source }),
      participant:
        input.participant &&
        Object.freeze({
          ...input.participant,
          identity: Object.freeze({ ...input.participant.identity }),
        }),
      principal: input.principal && Object.freeze({ ...input.principal }),
      requesterProfile: input.requesterProfile && Object.freeze({ ...input.requesterProfile }),
      assertCurrent,
      assertInputCurrent,
    }),
  );
}

/** Native consumers validate their exact input before context or model preparation. */
export function consumeConversationInputAdmission(
  admission: ConversationInputAdmissionV1,
  scope: ConversationInputScopeV1,
): ConsumedConversationInput {
  return ConversationInputAdmission.take(admission, scope);
}

/** A host may abandon its unconsumed input; consumed work retains its own release owner. */
export function releaseConversationInputAdmission(admission: ConversationInputAdmissionV1): void {
  ConversationInputAdmission.release(admission);
}

/** Host-only transfer, separate from later retries of the same native prepared run. */
export function claimConversationInputExecution(input: ConsumedConversationInput): void {
  AcceptedConversationInput.claim(input);
}

/** Real STT text is projected only after the native consumer has claimed its original input. */
export function prepareConversationReplyContext(
  input: ConsumedConversationInput,
  params: { text: string },
): Promise<MsgContext> {
  return AcceptedConversationInput.prepareContext(input, params.text);
}
