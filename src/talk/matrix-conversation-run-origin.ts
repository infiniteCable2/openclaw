import type { OperationalRunInstanceRef } from "../agents/operational-run-instance.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { ConsumedConversationInput } from "./conversation-input-admission.js";

type MatrixConversationRunOrigin = Readonly<{
  agentId: string;
  accountId: string;
  roomId: string;
  sessionKey: string;
  assertCurrent(): void;
}>;

const origins = resolveGlobalSingleton(Symbol.for("openclaw.matrixConversationRunOrigins"), () => ({
  inputs: new WeakMap<object, MatrixConversationRunOrigin>(),
  runs: new Map<string, { runId: string; origin: MatrixConversationRunOrigin }>(),
}));

/** The native conversation input consumer calls this after claiming original ingress. */
export function bindMatrixConversationInputOrigin(
  presentation: object,
  input: ConsumedConversationInput,
): void {
  const { source, scope } = input;
  if (
    source.channelId !== "matrix" ||
    !source.accountId ||
    !source.nativeChannelId ||
    scope.purpose === "greeting"
  ) {
    return;
  }
  origins.inputs.set(
    presentation,
    Object.freeze({
      agentId: scope.agentId,
      accountId: source.accountId,
      roomId: source.nativeChannelId,
      sessionKey: source.sessionKey,
      assertCurrent: input.assertCurrent,
    }),
  );
}

/** Keep the proved source on the native instance only while its executing turn owns it. */
export function retainMatrixConversationRunOrigin(
  presentation: object,
  instance: OperationalRunInstanceRef,
  binding: { runId: string; abortSignal: AbortSignal; assertCurrent(): void },
): (() => void) | undefined {
  const input = origins.inputs.get(presentation);
  if (!input) {
    return undefined;
  }
  if (binding.runId !== instance.runId || origins.runs.has(instance.instanceId)) {
    throw new Error("Matrix conversation origin does not own this run");
  }
  const origin: MatrixConversationRunOrigin = Object.freeze({
    ...input,
    assertCurrent() {
      if (origins.runs.get(instance.instanceId)?.origin !== origin) {
        throw new Error("Matrix conversation run retired");
      }
      binding.abortSignal.throwIfAborted();
      binding.assertCurrent();
      input.assertCurrent();
    },
  });
  origins.runs.set(instance.instanceId, { runId: instance.runId, origin });
  return () => {
    if (origins.runs.get(instance.instanceId)?.origin === origin) {
      origins.runs.delete(instance.instanceId);
    }
  };
}

export function readMatrixConversationRunOrigin(
  instance: OperationalRunInstanceRef,
): MatrixConversationRunOrigin | undefined {
  const bound = origins.runs.get(instance.instanceId);
  return bound?.runId === instance.runId ? bound.origin : undefined;
}
