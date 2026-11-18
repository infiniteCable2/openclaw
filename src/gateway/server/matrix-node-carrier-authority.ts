import { readMatrixConversationRunOrigin } from "../../talk/matrix-conversation-run-origin.js";
import type { AgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";

export type MatrixNodeCarrierBinding = Readonly<{
  agentId: string;
  roomId: string;
  accountId: string;
  expectedNodeId?: string;
  assertInvokeSession?: (sessionKey: string) => void;
  isCurrent: () => boolean;
}>;

const dispatchBindings = new WeakMap<
  () => boolean,
  { binding: MatrixNodeCarrierBinding; command: string }
>();

export function captureMatrixNodeCarrierDispatch(params: {
  binding: MatrixNodeCarrierBinding;
  identity?: AgentRuntimeIdentity;
  validate?: AgentRuntimeApprovalAuthorityValidator;
  nodeId: string;
  command: string;
  sessionKey?: string;
  isRequestCurrent: () => boolean;
}): (() => boolean) | undefined {
  const { binding, identity, validate, command } = params;
  const { assertInvokeSession } = binding;
  const origin = identity && readMatrixConversationRunOrigin(identity.operationalRunInstance);
  if (
    !binding.expectedNodeId ||
    binding.expectedNodeId !== params.nodeId ||
    !assertInvokeSession ||
    !identity ||
    !origin ||
    origin.agentId !== binding.agentId ||
    origin.accountId !== binding.accountId ||
    origin.roomId !== binding.roomId ||
    origin.sessionKey !== identity.sessionKey ||
    identity.agentId !== binding.agentId ||
    (params.sessionKey !== undefined && params.sessionKey !== identity.sessionKey)
  ) {
    return undefined;
  }
  const sessionKey = identity.sessionKey;
  const isCurrent = () => {
    try {
      if (!binding.isCurrent() || !params.isRequestCurrent() || validate?.(identity) !== true) {
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
