import type {
  ConversationInputAdmissionV1,
  ConversationInputScopeV1,
} from "../../talk/conversation-input.types.js";
import type { BuildChannelInboundEventContextParams } from "../inbound-event/context.js";
import type { ChannelIngressAdmissionScope } from "./admission-evidence-scope-key.js";
import type { ResolvedChannelMessageIngress } from "./runtime-types.js";

/** Text-free original ingress facts; arbitrary context overrides and history are not admitted. */
export type ChannelConversationInputContextFacts = Pick<
  BuildChannelInboundEventContextParams,
  | "channel"
  | "accountId"
  | "provider"
  | "surface"
  | "from"
  | "sender"
  | "conversation"
  | "route"
  | "reply"
  | "access"
  | "channelContext"
>;

export type AdmitChannelConversationInputV1 = {
  ingress: ResolvedChannelMessageIngress;
  scope: ChannelIngressAdmissionScope;
  input: ConversationInputScopeV1;
  context: ChannelConversationInputContextFacts;
  /** Exact transport/input owner, independent of any setup RPC. */
  assertCurrent: () => void;
  signal?: AbortSignal;
};

export type ChannelConversationInputRuntimeV1 = Readonly<{
  version: 1;
  admitInput: (params: AdmitChannelConversationInputV1) => ConversationInputAdmissionV1;
  /** Consume fresh endpoint ingress; no message, participant observation or model turn is created. */
  prepareConnection?: (
    params: Omit<AdmitChannelConversationInputV1, "input" | "context"> & {
      /** Existing private endpoint only; prepares shared history without creating a session or input. */
      purpose?: "root-preparation";
      /** Account-owned cleanup joins retained root custody, including shutdown during preparation. */
      retainCleanup?: (close: () => Promise<void>) => void | (() => void);
    },
  ) => Promise<void>;
}>;
