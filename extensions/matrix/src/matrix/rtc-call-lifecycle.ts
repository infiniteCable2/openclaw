import type { MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import type {
  MeetingAgentRealtimePreparation,
  MeetingRealtimeAudioEngineHandle,
  MeetingRealtimeAudioTransport,
} from "openclaw/plugin-sdk/meeting-runtime";

const LEAVE_TIMEOUT_MS = 5_000;

export type ActiveCall = {
  abort: AbortController;
  engine?: MeetingRealtimeAudioEngineHandle;
  preparation?: MeetingAgentRealtimePreparation;
  greetingPreparation?: MeetingAgentRealtimePreparation;
  transport?: MeetingRealtimeAudioTransport;
  session: MatrixRTCSession;
  joined: boolean;
  stopping: boolean;
  startup?: Promise<void>;
  connectionPreparation?: { cancel(): void; close(): Promise<void> };
  stopPromise?: Promise<boolean>;
  cleanupError?: unknown;
  disposeListeners: () => void;
};

export async function stopCall(call: ActiveCall): Promise<void> {
  call.abort.abort();
  call.connectionPreparation?.cancel();
  // Startup owns every handle until it settles, even after cancellation. Only
  // then can cleanup dispose a late transport or the engine that adopted it.
  await call.startup;
  call.disposeListeners();
  const errors: unknown[] = [];
  const preparationClosed = Promise.resolve()
    .then(() => call.connectionPreparation?.close())
    .then(
      () => {
        call.connectionPreparation = undefined;
      },
      (error: unknown) => {
        errors.push(error);
      },
    );
  try {
    if (call.engine) {
      await call.engine.stop();
      call.engine = undefined;
    } else if (call.transport) {
      try {
        await call.transport.stop();
      } finally {
        await call.transport.dispose();
      }
      call.transport = undefined;
    }
  } catch (error) {
    errors.push(error);
  }
  await preparationClosed;
  try {
    if (call.joined) {
      if (!(await call.session.leaveRoomSession(LEAVE_TIMEOUT_MS))) {
        // The SDK also returns false after a timed-out leave locally disables
        // participation. Local isJoined=false does not confirm server custody.
        throw new Error("MatrixRTC membership leave was not confirmed");
      }
      call.joined = false;
    }
  } catch (error) {
    errors.push(error);
  }
  // Readiness holds cannot unload a provider while accepted output is still
  // draining or its transport teardown remains unconfirmed.
  try {
    if (!call.engine && !call.transport) {
      await call.greetingPreparation?.release();
      call.greetingPreparation = undefined;
      await call.preparation?.release();
      call.preparation = undefined;
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "MatrixRTC call cleanup failed");
  }
}
