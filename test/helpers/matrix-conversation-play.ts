import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
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
  const requestOffset = model.requests.length;
  let expectedCallId: string | undefined;
  let transfer: { sequence: number; recipientHash: string; sourceHash: string } | undefined;
  const first = model.holdNext((request) => strings(request.input).join("\n").includes(intent));
  const continuation = model.holdNext(
    (request) =>
      expectedCallId !== undefined &&
      Array.isArray(request.input) &&
      request.input.some((item) => {
        const output = asOptionalRecord(item);
        return output?.type === "function_call_output" && output.call_id === expectedCallId;
      }) &&
      strings(request.input).join("\n").includes(intent),
  );
  const phases: Array<{ phase: string; elapsedMs: number }> = [];
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const mark = (phase: string) =>
    phases.push({ phase, elapsedMs: Math.round(performance.now() - started) });
  try {
    const beforeSeed = model.requests.length;
    const seed = await sibling.call<{ runId: string }>("chat.send", {
      sessionKey: "agent:main:matrix-linked-fresh-after-restart",
      message: "Verify the shared context in this fresh conversation.",
      deliver: false,
      idempotencyKey: "matrix-linked-fresh-seed",
    });
    expect(
      await sibling.call("agent.wait", { runId: seed.runId, timeoutMs: 30_000 }),
    ).toMatchObject({ status: "ok" });
    expect(model.requests).toHaveLength(beforeSeed + 1);
    const seedText = strings(model.requests[beforeSeed]!.input).join("\n");
    expect(seedText.split("CURRENT_MATRIX_FULL_PAYLOAD_1")).toHaveLength(2);
    expect(seedText.split("SYNTHETIC_MATRIX_SIBLING_COBALT_47")).toHaveLength(2);
    mark("fresh-branch-seeded-from-restored-root");
    const reply = matrix.nextSend();
    void reply.catch(() => {});
    matrix.push(intent, 5);
    const input = await withinTest(first.entered, signal);
    expectedCallId = `call_branch_${model.requests.indexOf(input) + 1}`;
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
    let recipient: { session: { sessionId: string } | null };
    try {
      recipient = await observer.call("sessions.describe", {
        key: params.matrixKey,
      });
    } finally {
      await observer.close();
    }
    if (!recipient.session) {
      throw new Error("Native Matrix recipient row is unavailable");
    }
    const source = await sibling.call<{
      session: { sessionId: string; lifecycleRevision: string };
    }>("sessions.describe", { key: sourceKey });
    expect(source.session.lifecycleRevision).toEqual(expect.any(String));
    expect(source.session.lifecycleRevision.length).toBeGreaterThan(0);
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
    transfer = {
      sequence: position.rawSeq,
      recipientHash: redactIdentifier(recipient.session.sessionId),
      sourceHash: redactIdentifier(source.session.sessionId),
    };
    // Observe this exact complete user packet, not a later source maximum.
    await waitForConversationTransfer(gateway, signal, {
      recipientId: recipient.session.sessionId,
      sourceId: source.session.sessionId,
      sequence: position.rawSeq,
      phase: "prepared",
      exactSequence: true,
    });
    mark("active-recipient-packet-prepared");
    model.respondWithTool(input, "sessions_list", { limit: 2 });
    first.release();
    const continued = await withinTest(continuation.entered, signal);
    mark("matrix-tool-continuation-held");
    const text = strings(continued.input).join("\n");
    expect(text.split(fact)).toHaveLength(2);
    expect(text.split(intent)).toHaveLength(2);
    const administrator = await connectConversationOperator(gateway, params.personEmail, signal, {
      scopes: [...BRANCH_GATEWAY_SCOPES, "operator.admin"],
    });
    let reset: { entry: { sessionId: string; lifecycleRevision: string } };
    try {
      reset = await administrator.call("sessions.reset", {
        key: sourceKey,
        expectedSessionId: source.session.sessionId,
      });
    } finally {
      await administrator.close();
    }
    expect(reset.entry.sessionId).toBe(source.session.sessionId);
    expect(reset.entry.lifecycleRevision).toEqual(expect.any(String));
    expect(reset.entry.lifecycleRevision.length).toBeGreaterThan(0);
    expect(reset.entry.lifecycleRevision).not.toBe(source.session.lifecycleRevision);
    mark("donor-reset-after-copy");
    continuation.release();
    expect(await withinTest(reply, signal)).toMatch(/^FIXTURE_REPLY_\d+$/u);
    mark("original-matrix-reply-complete");
    console.info(JSON.stringify({ fixture: "matrix-active-native-play", phases }));
  } catch (error) {
    const transfers = gateway
      .logs()
      .split("\n")
      .map((line) => line.replaceAll('\\"', '"'))
      .filter(
        (line) =>
          transfer &&
          line.includes(transfer.recipientHash) &&
          line.includes(transfer.sourceHash) &&
          (line.includes("Conversation knowledge transfer") ||
            line.includes("Related-history source preparation settled")),
      )
      .slice(-12)
      .map((line) => ({
        time: /"time"\s*:\s*(?:"([^"]+)"|(\d+))/u.exec(line)?.slice(1).find(Boolean),
        event: line.includes("Conversation knowledge transfer") ? "transfer" : "preparation",
        phase: /"phase"\s*:\s*"([^"]+)"/u.exec(line)?.[1],
        complete: /"complete"\s*:\s*(true|false)/u.exec(line)?.[1],
        sourceSequences: line.includes("Conversation knowledge transfer")
          ? [Number(/"throughSeq"\s*:\s*(\d+)/u.exec(line)?.[1] ?? -1)]
          : Array.from(
              line.matchAll(/"sourceHash"\s*:\s*"([^"]+)"\s*,\s*"throughSeq"\s*:\s*(\d+)/gu),
            )
              .filter((match) => match[1] === transfer?.sourceHash)
              .map((match) => Number(match[2])),
      }));
    const requests = model.requests
      .slice(requestOffset, requestOffset + 8)
      .map((request, index) => {
        const text = strings(request.input).join("\n");
        return {
          index: requestOffset + index + 1,
          elapsedMs: Math.round(model.requestTimes[requestOffset + index]! - started),
          callIds: Array.isArray(request.input)
            ? request.input.flatMap((item) => {
                const output = asOptionalRecord(item);
                return output?.type === "function_call_output" && typeof output.call_id === "string"
                  ? [output.call_id]
                  : [];
              })
            : [],
          factCopies: text.split(fact).length - 1,
          intentCopies: text.split(intent).length - 1,
        };
      });
    console.error(
      JSON.stringify({
        fixture: "matrix-active-native-play",
        startedAt,
        expectedCallId,
        transfer,
        transfers,
        requests,
        phases,
      }),
    );
    throw error;
  } finally {
    first.release();
    continuation.release();
  }
}
