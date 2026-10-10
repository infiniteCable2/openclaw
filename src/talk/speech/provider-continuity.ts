import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceToolCallEvent,
} from "../provider-types.js";
import type { RealtimeVoiceSessionHarness } from "../realtime-session-harness.js";
import type { RealtimeVoiceBridgeSession } from "../session-runtime.js";
import type { TalkEventInput } from "../talk-events.js";

type SpeechRealtimeToolContinuityCall = {
  session: RealtimeVoiceBridgeSession;
  event: RealtimeVoiceToolCallEvent;
  onTalkEvent: (event: TalkEventInput) => void;
};

const speechRealtimeToolAbortSignals = new WeakMap<RealtimeVoiceBridgeSession, AbortSignal>();

export function readSpeechRealtimeToolAbortSignal(
  session: RealtimeVoiceBridgeSession,
): AbortSignal | undefined {
  return speechRealtimeToolAbortSignals.get(session);
}

export function createSpeechRealtimeToolContinuity<TCall extends SpeechRealtimeToolContinuityCall>(
  handleToolCall: (call: TCall) => Promise<void>,
) {
  let epoch = 0;
  const activeControllers = new Set<AbortController>();

  // Reset invalidates provider submissions and Talk events together so late
  // async completions cannot leak into the replacement provider generation.
  const reset = (reason: string) => {
    epoch += 1;
    for (const controller of activeControllers) {
      controller.abort(reason);
    }
    activeControllers.clear();
  };

  const runConsult = async (
    request: Parameters<RealtimeVoiceAgentConsultRunner>[0],
    consult: RealtimeVoiceAgentConsultRunner,
  ) => {
    const controller = new AbortController();
    activeControllers.add(controller);
    const signal = request.signal
      ? AbortSignal.any([controller.signal, request.signal])
      : controller.signal;
    try {
      signal.throwIfAborted();
      const result = await consult({ ...request, signal });
      signal.throwIfAborted();
      return result;
    } finally {
      activeControllers.delete(controller);
    }
  };

  const run = (params: {
    session: RealtimeVoiceBridgeSession;
    call: Omit<TCall, "session" | "onTalkEvent">;
    harness: Pick<RealtimeVoiceSessionHarness, "emit" | "ensureTurn">;
  }): Promise<void> => {
    const callEpoch = epoch;
    const controller = new AbortController();
    activeControllers.add(controller);
    const isActive = () => !controller.signal.aborted && callEpoch === epoch;
    const turnId = params.harness.ensureTurn();
    params.harness.emit({
      type: "tool.call",
      turnId,
      itemId: params.call.event.itemId,
      callId: params.call.event.callId,
      payload: { name: params.call.event.name, args: params.call.event.args },
    });
    // Only submitToolResult is replaced below with an epoch-guarded delegate.
    // SAFETY: The facade inherits every session member from the supplied session.
    const guardedSession = Object.create(params.session) as RealtimeVoiceBridgeSession;
    speechRealtimeToolAbortSignals.set(guardedSession, controller.signal);
    guardedSession.submitToolResult = (callId, result, options) => {
      if (!isActive()) {
        return;
      }
      return params.session.submitToolResult(callId, result, options);
    };
    // The caller supplies TCall minus the two owned fields; restoring those fields
    // preserves all caller-specific members without changing their values.
    return handleToolCall({
      ...params.call,
      session: guardedSession,
      onTalkEvent: (event) => {
        if (isActive()) {
          params.harness.emit({ ...event, turnId: event.turnId ?? turnId });
        }
      },
    } as TCall) // SAFETY: The spread retains TCall's fields and restores the two owned fields.
      .catch((error: unknown) => {
        if (isActive()) {
          throw error;
        }
      })
      .finally(() => {
        speechRealtimeToolAbortSignals.delete(guardedSession);
        activeControllers.delete(controller);
      });
  };

  return { reset, run, runConsult };
}
