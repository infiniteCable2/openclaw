import { readMatrixConversationRunOrigin } from "../../talk/matrix-conversation-run-origin.js";
import type { AgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";

export type MatrixNodeCarrierBinding = Readonly<{
  agentId: string;
  roomId: string;
  accountId: string;
  expectedNodeId?: string;
  assertInvokeSession?: (sessionKey: string) => void;

  privateRequesterProfileId?: string;
  isCurrent: () => boolean;
}>;

const dispatchBindings = new WeakMap<
  () => boolean,
  { binding: MatrixNodeCarrierBinding; command: string }
>();

export function captureMatrixNodeCarrierRunScope(params: {
  binding: MatrixNodeCarrierBinding;
  identity?: Pick<AgentRuntimeIdentity, "agentId" | "sessionKey" | "operationalRunInstance">;
  nodeId: string;
  sessionKey?: string;
  isPrivateRequesterProfile?: (profileId: string) => boolean;
}): (() => boolean) | undefined {
  const { binding, identity } = params;
  if (
    !binding.expectedNodeId ||
    binding.expectedNodeId !== params.nodeId ||
    !identity ||
    identity.agentId !== binding.agentId ||
    (params.sessionKey !== undefined && params.sessionKey !== identity.sessionKey)
  ) {
    return undefined;
  }
  const { assertInvokeSession, privateRequesterProfileId } = binding;
  const origin = readMatrixConversationRunOrigin(identity.operationalRunInstance);
  const sessionKey = identity.sessionKey;
  if (
    assertInvokeSession &&
    origin?.agentId === binding.agentId &&
    origin.accountId === binding.accountId &&
    origin.roomId === binding.roomId &&
    origin.sessionKey === sessionKey
  ) {
    return () => {
      try {
        if (!binding.isCurrent()) {
          return false;
        }
        origin.assertCurrent();
        const outcome: unknown = assertInvokeSession(sessionKey);
        if (outcome instanceof Promise) {
          void outcome.catch(() => {});
        }
        return outcome === undefined;
      } catch {
        return false;
      }
    };
  }
  const { isPrivateRequesterProfile } = params;
  if (privateRequesterProfileId && isPrivateRequesterProfile) {
    return () => {
      try {
        return binding.isCurrent() && isPrivateRequesterProfile(privateRequesterProfileId);
      } catch {
        return false;
      }
    };
  }
  return undefined;
}

export function captureMatrixNodeCarrierDispatch(params: {
  binding: MatrixNodeCarrierBinding;
  identity?: AgentRuntimeIdentity;
  validate?: AgentRuntimeApprovalAuthorityValidator;
  nodeId: string;
  command: string;
  sessionKey?: string;
  isPrivateRequesterProfile?: (profileId: string) => boolean;
  isRequestCurrent: () => boolean;
}): (() => boolean) | undefined {
  const { binding, identity, validate, command } = params;
  const scope = captureMatrixNodeCarrierRunScope(params);
  if (!identity || !scope) {
    return undefined;
  }
  const isCurrent = () => {
    try {
      return params.isRequestCurrent() && validate?.(identity) === true && scope();
    } catch {
      return false;
    }
  };
  if (!isCurrent()) {
    return undefined;
  }
  dispatchBindings.set(isCurrent, { binding, command });
  return isCurrent;
}

export function assertMatrixNodeCarrierDispatch(
  binding: MatrixNodeCarrierBinding,
  nodeId: unknown,
  command: unknown,
  guard?: () => boolean,
): void {
  const scope = guard && dispatchBindings.get(guard);
  if (
    !scope ||
    scope.binding !== binding ||
    scope.command !== command ||
    !binding.expectedNodeId ||
    binding.expectedNodeId !== nodeId ||
    !guard?.()
  ) {
    throw new Error("Matrix node invoke authority closed");
  }
}

/** Keep the original carrier binding when another host policy narrows dispatch. */
export function restrictMatrixNodeCarrierDispatch(
  original: () => boolean,
  gate: () => boolean,
): () => boolean {
  const binding = dispatchBindings.get(original);
  const restricted = () => original() && gate();
  if (binding) {
    dispatchBindings.set(restricted, binding);
  }
  return restricted;
}
