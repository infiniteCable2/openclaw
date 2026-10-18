import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "./runtime-types.js";

// Private accessor-free snapshots for channel admission handoff scope keys.
const MAX_CHANNEL_ADMISSION_SCOPE_BYTES = 32_768;
const MAX_CHANNEL_ADMISSION_SCOPE_NODES = 256;
const INVALID_SCOPE_VALUE = Symbol("invalid-channel-admission-scope-value");

function snapshotOwnedData(value: unknown, budget = { nodes: 0 }, depth = 0): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_CHANNEL_ADMISSION_SCOPE_NODES || depth > 6) {
    return INVALID_SCOPE_VALUE;
  }
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID_SCOPE_VALUE;
  }
  if (typeof value !== "object") {
    return INVALID_SCOPE_VALUE;
  }
  let descriptors: ReturnType<typeof Object.getOwnPropertyDescriptors>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.getOwnPropertySymbols(value).some(
        (key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable,
      )
    ) {
      return INVALID_SCOPE_VALUE;
    }
  } catch {
    return INVALID_SCOPE_VALUE;
  }
  const keys = Object.keys(descriptors)
    .filter((key) => descriptors[key]?.enumerable)
    .toSorted();
  const entries: unknown[] = [];
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      return INVALID_SCOPE_VALUE;
    }
    const captured = snapshotOwnedData(descriptor.value, budget, depth + 1);
    if (captured === INVALID_SCOPE_VALUE) {
      return INVALID_SCOPE_VALUE;
    }
    entries.push([key, captured]);
  }
  return Array.isArray(value) ? ["array", entries] : ["record", entries];
}

function stableOwnedScopeKey(value: unknown): string | undefined {
  const snapshot = snapshotOwnedData(value);
  if (snapshot === INVALID_SCOPE_VALUE) {
    return undefined;
  }
  try {
    const key = JSON.stringify(snapshot);
    return key.length <= MAX_CHANNEL_ADMISSION_SCOPE_BYTES ? key : undefined;
  } catch {
    return undefined;
  }
}

function safeOwnPropertyDescriptor(
  value: object,
  key: PropertyKey,
): PropertyDescriptor | undefined | typeof INVALID_SCOPE_VALUE {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return INVALID_SCOPE_VALUE;
  }
}

export function ownDataValue(value: object, key: PropertyKey): unknown {
  const descriptor = safeOwnPropertyDescriptor(value, key);
  if (descriptor === INVALID_SCOPE_VALUE) {
    return INVALID_SCOPE_VALUE;
  }
  if (!descriptor) {
    return undefined;
  }
  return "value" in descriptor ? descriptor.value : INVALID_SCOPE_VALUE;
}

export function publicResultScopeKey(result: ResolvedChannelMessageIngress): string | undefined {
  const stateValue = ownDataValue(result, "state");
  if (!stateValue || typeof stateValue !== "object") {
    return undefined;
  }
  const routeFacts = ownDataValue(stateValue, "routeFacts");
  if (!Array.isArray(routeFacts)) {
    return undefined;
  }
  const routeCount = ownDataValue(routeFacts, "length");
  if (typeof routeCount !== "number" || routeCount > MAX_CHANNEL_ADMISSION_SCOPE_NODES) {
    return undefined;
  }
  const routes: unknown[] = [];
  for (let index = 0; index < routeCount; index += 1) {
    const route = ownDataValue(routeFacts, String(index));
    if (!route || typeof route !== "object") {
      return undefined;
    }
    routes.push({
      id: ownDataValue(route, "id"),
      kind: ownDataValue(route, "kind"),
      gate: ownDataValue(route, "gate"),
      effect: ownDataValue(route, "effect"),
      precedence: ownDataValue(route, "precedence"),
      senderPolicy: ownDataValue(route, "senderPolicy"),
    });
  }
  return stableOwnedScopeKey({
    accountId: ownDataValue(stateValue, "accountId"),
    channelId: ownDataValue(stateValue, "channelId"),
    conversationKind: ownDataValue(stateValue, "conversationKind"),
    event: ownDataValue(stateValue, "event"),
    routeFacts: routes,
  });
}

const FINALIZED_CONTEXT_SCOPE_FIELDS = [
  "OriginatingChannel",
  "AccountId",
  "SenderId",
  "ChatType",
  "ChatId",
  "SessionKey",
  "AgentId",
  "DmScope",
  "ParentSessionKey",
  "ModelParentSessionKey",
  "MessageSid",
  "MessageSidFull",
  "ReplyToId",
  "ReplyToIdFull",
  "To",
  "From",
  "OriginatingTo",
  "MessageThreadId",
  "NativeChannelId",
  "ThreadParentId",
  "InboundEventKind",
  "Provider",
  "Surface",
  "NativeDirectUserId",
] as const;

export function finalizedContextScopeKey(context: object): string | undefined {
  const entries: unknown[] = [];
  for (const key of FINALIZED_CONTEXT_SCOPE_FIELDS) {
    const descriptor = safeOwnPropertyDescriptor(context, key);
    if (descriptor === INVALID_SCOPE_VALUE) {
      return undefined;
    }
    if (!descriptor) {
      entries.push([key, "absent"]);
      continue;
    }
    if (!("value" in descriptor)) {
      return undefined;
    }
    const value = descriptor.value;
    if (
      value !== undefined &&
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return undefined;
    }
    entries.push([key, "present", value]);
  }
  return stableOwnedScopeKey(entries);
}

export function scopedParticipantRef(params: {
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
}): string | undefined {
  const channelId = params.channelId;
  const accountId = params.accountId || "default";
  const rawPrincipalRef = params.rawPrincipalRef == null ? "" : String(params.rawPrincipalRef);
  if (!channelId || !rawPrincipalRef) {
    return undefined;
  }
  // Preserve tuple boundaries: channel, account, and participant identifiers may
  // themselves contain colons or other separators.
  const scoped = JSON.stringify([channelId, accountId, rawPrincipalRef]);
  return scoped.length <= 4_096 ? scoped : undefined;
}

export type ChannelIngressResolutionScope = {
  conversation: {
    kind: "direct" | "group" | "channel";
    id: string;
    parentId?: string;
    threadId?: string;
  };
  contextBinding?: ChannelIngressContextBinding;
};

export type ChannelIngressAdmissionScope = {
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
  conversation: ChannelIngressResolutionScope["conversation"];
  binding: ChannelIngressContextBinding;
};

export function snapshotIngressAdmissionScope(
  value: unknown,
): ChannelIngressAdmissionScope | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const channelId = ownDataValue(value, "channelId");
  const accountId = ownDataValue(value, "accountId");
  const rawPrincipalRef = ownDataValue(value, "rawPrincipalRef");
  const conversation = ownDataValue(value, "conversation");
  const binding = snapshotContextBinding(ownDataValue(value, "binding"));
  if (
    typeof channelId !== "string" ||
    (accountId !== undefined && typeof accountId !== "string") ||
    (rawPrincipalRef !== undefined &&
      rawPrincipalRef !== null &&
      typeof rawPrincipalRef !== "string" &&
      typeof rawPrincipalRef !== "number") ||
    !conversation ||
    typeof conversation !== "object" ||
    !binding
  ) {
    return undefined;
  }
  const kind = ownDataValue(conversation, "kind");
  const id = ownDataValue(conversation, "id");
  const parentId = ownDataValue(conversation, "parentId");
  const threadId = ownDataValue(conversation, "threadId");
  if (
    (kind !== "direct" && kind !== "group" && kind !== "channel") ||
    typeof id !== "string" ||
    (parentId !== undefined && typeof parentId !== "string") ||
    (threadId !== undefined && typeof threadId !== "string")
  ) {
    return undefined;
  }
  return {
    channelId,
    accountId,
    rawPrincipalRef,
    conversation: { kind, id, parentId, threadId },
    binding,
  };
}

/** Brand an exact resolver object with its non-authoritative input binding. */
export function snapshotContextBinding(
  value: unknown,
): Readonly<ChannelIngressContextBinding> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const agentId = ownDataValue(value, "agentId");
  const sessionKey = ownDataValue(value, "sessionKey");
  const messageId = ownDataValue(value, "messageId");
  const nativeChannelId = ownDataValue(value, "nativeChannelId");
  const inboundEventKind = ownDataValue(value, "inboundEventKind");
  if (
    typeof agentId !== "string" ||
    typeof sessionKey !== "string" ||
    (messageId !== undefined && typeof messageId !== "string") ||
    (nativeChannelId !== undefined && typeof nativeChannelId !== "string") ||
    (inboundEventKind !== "user_request" && inboundEventKind !== "room_event")
  ) {
    return undefined;
  }
  return Object.freeze({ agentId, sessionKey, messageId, nativeChannelId, inboundEventKind });
}

function normalizeScopeId(value: unknown): string | undefined | typeof INVALID_SCOPE_VALUE {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : INVALID_SCOPE_VALUE;
}

export function contextAdmissionScope(params: {
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
  contextParams: object;
}): ChannelIngressAdmissionScope | undefined {
  const conversation = ownDataValue(params.contextParams, "conversation");
  const route = ownDataValue(params.contextParams, "route");
  const reply = ownDataValue(params.contextParams, "reply");
  const message = ownDataValue(params.contextParams, "message");
  if (
    !conversation ||
    typeof conversation !== "object" ||
    !route ||
    typeof route !== "object" ||
    !reply ||
    typeof reply !== "object" ||
    !message ||
    typeof message !== "object"
  ) {
    return undefined;
  }
  const routeAccountId = ownDataValue(route, "accountId");
  const effectiveAccountId =
    routeAccountId === undefined ? params.accountId : normalizeScopeId(routeAccountId);
  if (effectiveAccountId === INVALID_SCOPE_VALUE) {
    return undefined;
  }
  const conversationKind = ownDataValue(conversation, "kind");
  const conversationId = normalizeScopeId(ownDataValue(conversation, "id"));
  const conversationParentId = normalizeScopeId(ownDataValue(conversation, "parentId"));
  const conversationThreadId = normalizeScopeId(ownDataValue(conversation, "threadId"));
  const replyThreadId = normalizeScopeId(ownDataValue(reply, "messageThreadId"));
  const replyParentId = normalizeScopeId(ownDataValue(reply, "threadParentId"));
  const nativeConversationId = normalizeScopeId(ownDataValue(conversation, "nativeChannelId"));
  const nativeReplyId = normalizeScopeId(ownDataValue(reply, "nativeChannelId"));
  const routeAgentId = normalizeScopeId(ownDataValue(route, "agentId"));
  const dispatchSessionKey = normalizeScopeId(ownDataValue(route, "dispatchSessionKey"));
  const routeSessionKey = normalizeScopeId(ownDataValue(route, "routeSessionKey"));
  const inboundEventKindValue = ownDataValue(message, "inboundEventKind");
  const inboundEventKind =
    inboundEventKindValue === undefined || inboundEventKindValue === null
      ? "user_request"
      : normalizeScopeId(inboundEventKindValue);
  const messageId = normalizeScopeId(ownDataValue(params.contextParams, "messageId"));
  const values = [
    conversationId,
    conversationParentId,
    conversationThreadId,
    replyThreadId,
    replyParentId,
    nativeConversationId,
    nativeReplyId,
    routeAgentId,
    dispatchSessionKey,
    routeSessionKey,
    inboundEventKind,
    messageId,
  ];
  if (
    values.includes(INVALID_SCOPE_VALUE) ||
    (conversationKind !== "direct" &&
      conversationKind !== "group" &&
      conversationKind !== "channel") ||
    typeof conversationId !== "string" ||
    typeof routeAgentId !== "string" ||
    (inboundEventKind !== "user_request" && inboundEventKind !== "room_event")
  ) {
    return undefined;
  }
  if (
    (replyThreadId !== undefined &&
      conversationThreadId !== undefined &&
      replyThreadId !== conversationThreadId) ||
    (replyParentId !== undefined &&
      conversationParentId !== undefined &&
      replyParentId !== conversationParentId) ||
    (nativeReplyId !== undefined &&
      nativeConversationId !== undefined &&
      nativeReplyId !== nativeConversationId)
  ) {
    return undefined;
  }
  // Passing through the same descriptor-only snapshot narrows normalized optional IDs.
  return snapshotIngressAdmissionScope({
    channelId: params.channelId,
    accountId: effectiveAccountId,
    rawPrincipalRef: params.rawPrincipalRef,
    conversation: {
      kind: conversationKind,
      id: conversationId,
      parentId: replyParentId ?? conversationParentId,
      threadId: replyThreadId ?? conversationThreadId,
    },
    binding: {
      agentId: routeAgentId,
      sessionKey: dispatchSessionKey ?? routeSessionKey,
      messageId,
      nativeChannelId: nativeReplyId ?? nativeConversationId,
      inboundEventKind,
    },
  });
}

export function ingressHandoffScopeMatches(params: {
  binding: {
    channelId: string;
    accountId?: string;
    rawPrincipalRef: string | number | null | undefined;
    scope?: ChannelIngressResolutionScope;
    contextBinding?: Readonly<ChannelIngressContextBinding>;
  };
  scope: ChannelIngressAdmissionScope;
  contextCompatibility?: boolean;
}): boolean {
  const expected = params.binding.scope?.conversation;
  const expectedContext = params.binding.contextBinding;
  const { scope } = params;
  if (!expected || !expectedContext) {
    return false;
  }
  const nativeId = scope.binding.nativeChannelId;
  const nativeMatches =
    params.contextCompatibility && expectedContext.nativeChannelId === undefined
      ? nativeId === undefined ||
        [expected.id, expected.parentId, expected.threadId].includes(nativeId)
      : nativeId === expectedContext.nativeChannelId;
  const participantMatches = params.contextCompatibility
    ? scopedParticipantRef(params.binding) === scopedParticipantRef(scope)
    : params.binding.channelId === scope.channelId &&
      (params.binding.accountId || "default") === (scope.accountId || "default") &&
      params.binding.rawPrincipalRef === scope.rawPrincipalRef;
  return (
    participantMatches &&
    scope.conversation.kind === expected.kind &&
    scope.conversation.id === expected.id &&
    scope.conversation.parentId === expected.parentId &&
    scope.conversation.threadId === expected.threadId &&
    scope.binding.agentId === expectedContext.agentId &&
    scope.binding.sessionKey === expectedContext.sessionKey &&
    scope.binding.inboundEventKind === expectedContext.inboundEventKind &&
    nativeMatches &&
    ((params.contextCompatibility && expectedContext.messageId === undefined) ||
      scope.binding.messageId === expectedContext.messageId)
  );
}
