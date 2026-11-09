import { resolveUserMessages } from "../../shared/user-messages.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
/** Active-run queue admission for prepared reply turns. */
import type { ReplyPayload } from "../types.js";
import type { QueueSettings } from "./queue/types.js";

export const REPLY_RUN_STILL_SHUTTING_DOWN_TEXT = resolveUserMessages().replyShuttingDown;

/** One native busy outcome carries its retry fact independently of translated copy. */
export function buildReplyRunShuttingDownPayload(language?: string): ReplyPayload {
  return setReplyPayloadMetadata(
    { text: resolveUserMessages(language).replyShuttingDown },
    {
      previousRunStillShuttingDown: true,
    },
  );
}

/** Waits for admitted active work and returns guidance if it still has not settled. */
export async function waitForPreparedReplyQueue(params: {
  language?: string;
  activeSessionId: string;
  queueMode: QueueSettings["mode"];
  interruptActiveRun: () => Promise<boolean>;
  waitForActiveRunEnd: (sessionId: string) => Promise<unknown>;
  refreshPreparedState: () => Promise<void>;
  resolveBusyState: () => { isActive: boolean; terminalProducerBlocked?: boolean };
}): Promise<ReplyPayload | undefined> {
  if (params.queueMode === "interrupt") {
    // An idle run slot is not evidence that its former writer settled. In
    // particular a watchdog can release the slot while delivery still owns I/O.
    if (!(await params.interruptActiveRun())) {
      return buildReplyRunShuttingDownPayload(params.language);
    }
  } else {
    await params.waitForActiveRunEnd(params.activeSessionId);
  }
  await params.refreshPreparedState();
  const busy = params.resolveBusyState();
  return busy.isActive
    ? busy.terminalProducerBlocked
      ? { text: resolveUserMessages(params.language).replyWriterFenceBlocked }
      : buildReplyRunShuttingDownPayload(params.language)
    : undefined;
}
