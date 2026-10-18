/** One host-admitted input, not a serializable permission or a task-spawn grant. */
export type ConversationInputAdmissionV1 = Readonly<{
  version: 1;
  kind: "conversation-input-admission";
}>;

export type ConversationInputScopeV1 = Readonly<{
  agentId: string;
  conversationId: string;
  inputId: string;
  purpose: "user" | "steering" | "greeting";
}>;

/** The transport retains its original admission owner; each input is admitted separately. */
export type ConversationInputSourceV1 = Readonly<{
  version: 1;
  admitInput: (
    input: ConversationInputScopeV1 & { signal?: AbortSignal },
  ) => Promise<ConversationInputAdmissionV1>;
}>;
