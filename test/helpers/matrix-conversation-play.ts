import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import {
  BRANCH_GATEWAY_SCOPES,
  connectConversationOperator,
  startConversationModel,
  waitForConversationTransfer,
} from "./conversation-branches-gateway.js";
import type { OpenClawTestInstance } from "./openclaw-test-instance.js";
import { withinTest } from "./promise.js";

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(strings);
  }
  return value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
}

/** Exercise native packet admission between two real provider calls in one Matrix turn. */
export async function playMatrixConversation(params: {
  gateway: OpenClawTestInstance;
  model: Awaited<ReturnType<typeof startConversationModel>>;
  sibling: Awaited<ReturnType<typeof connectConversationOperator>>;
  matrix: { push(text: string, index: number): unknown; nextSend(): Promise<string> };
  matrixKey: string;
  personEmail: string;
  signal: AbortSignal;
}) {
  const { gateway, model, sibling, matrix, signal } = params;
  const sourceKey = "agent:main:matrix-linked-sibling";
  const intent = "CURRENT_MATRIX_PLAY_INTENT_KEEP_THIS_REQUEST";
  const fact = "SYNTHETIC_MATRIX_LIVE_SIBLING_ORCHID_83";
  const first = model.holdNext((request) => strings(request.input).join("\n").includes(intent));
  const continuation = model.holdNext(
    (request) =>
      Array.isArray(request.input) &&
      request.input.some((item) => asOptionalRecord(item)?.type === "function_call_output"),
  );
  const phases: Array<{ phase: string; elapsedMs: number }> = [];
  const started = performance.now();
  const mark = (phase: string) =>
    phases.push({ phase, elapsedMs: Math.round(performance.now() - started) });
  try {
    const reply = matrix.nextSend();
    void reply.catch(() => {});
    matrix.push(intent, 5);
    const input = await withinTest(first.entered, signal);
    mark("matrix-provider-held");
    expect(input.tools).toContainEqual(
      expect.objectContaining({ type: "function", name: "sessions_list" }),
    );
    const run = await sibling.call<{ runId: string }>("chat.send", {
      sessionKey: sourceKey,
      message: `Remember this new fact: ${fact}.`,
      deliver: false,
      idempotencyKey: "matrix-linked-live-sibling",
    });
    expect(await sibling.call("agent.wait", { runId: run.runId, timeoutMs: 30_000 })).toMatchObject(
      { status: "ok" },
    );
    mark("sibling-fact-published");
    const observer = await connectConversationOperator(gateway, params.personEmail, signal, {
      scopes: [...BRANCH_GATEWAY_SCOPES, "operator.admin"],
    });
    const recipient = await observer
      .call<{ session: { sessionId: string } | null }>("sessions.describe", {
        key: params.matrixKey,
      })
      .finally(() => observer.close());
    if (!recipient.session) {
      throw new Error("Native Matrix recipient row is unavailable");
    }
    const source = await sibling.call<{ session: { sessionId: string } }>("sessions.describe", {
      key: sourceKey,
    });
    const history = await sibling.call<{ messages: unknown[] }>("chat.history", {
      sessionKey: sourceKey,
      limit: 100,
    });
    const user = history.messages
      .map(asOptionalRecord)
      .find(
        (message) => message?.role === "user" && strings(message.content).join("\n").includes(fact),
      );
    const position = asOptionalRecord(asOptionalRecord(user?.["__openclaw"])?.transcriptPosition);
    if (typeof position?.rawSeq !== "number") {
      throw new Error("Native source sequence is unavailable");
    }
    await waitForConversationTransfer(gateway, signal, {
      recipientId: recipient.session.sessionId,
      sourceId: source.session.sessionId,
      sequence: position.rawSeq,
      phase: "prepared",
    });
    mark("active-recipient-packet-prepared");
    model.respondWithTool(input, "sessions_list", { limit: 2 });
    first.release();
    const continued = await withinTest(continuation.entered, signal);
    mark("matrix-tool-continuation-held");
    const text = strings(continued.input).join("\n");
    expect(text.split(fact)).toHaveLength(2);
    expect(text.split(intent)).toHaveLength(2);
    const reset = await sibling.call<{ entry: { sessionId: string } }>("sessions.reset", {
      key: sourceKey,
      expectedSessionId: source.session.sessionId,
    });
    expect(reset.entry.sessionId).not.toBe(source.session.sessionId);
    mark("donor-reset-after-copy");
    continuation.release();
    expect(await withinTest(reply, signal)).toMatch(/^FIXTURE_REPLY_\d+$/u);
    mark("original-matrix-reply-complete");
    console.info(JSON.stringify({ fixture: "matrix-active-native-play", phases }));
  } catch (error) {
    console.error(JSON.stringify({ fixture: "matrix-active-native-play", phases }));
    throw error;
  } finally {
    first.release();
    continuation.release();
  }
}
