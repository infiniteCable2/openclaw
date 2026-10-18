import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationActiveConnectionSchema } from "../../packages/gateway-protocol/src/schema/agent.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  forgetUnifiedTalkSession,
  publishTalkConnectionPresentation,
  selectTalkConnectionPresentations,
} from "../talk/session-registry.js";
import { prepareConversationActiveConnections } from "./conversation-active-connections.js";
import type { prepareTranscriptReadAuthority } from "./session-transcript-read-authority.js";

const ids = new Set<string>();
afterEach(() => {
  for (const id of ids) forgetUnifiedTalkSession(id);
  ids.clear();
});
function source(id: string, agentId = "example") {
  ids.add(id);
  const state = { current: true, ready: false };
  const release = publishTalkConnectionPresentation(id, {
    kind: "call",
    channel: "matrix",
    label: "Private call",
    readTarget: { agentId, sessionKey: `agent:${agentId}:voice:${id}`, sessionId: id },
    input: { audio: true },
    output: { audio: true },
    operations: ["current-turn-reply"],
    state: () => (state.ready ? "ready" : "preparing"),
    assertCurrent() {
      if (!state.current) throw new Error("Source revoked");
    },
  });
  return { state, release };
}
function reader() {
  const state = { current: true };
  const authority: AdmittedRunOperatorAuthority = {
    profileId: "original-reader",
    scopes: ["operator.read"],
    assertCurrent() {
      if (!state.current) throw new Error("Reader revoked");
    },
  };
  const reads: { assertCurrent: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }[] =
    [];
  const prepareRead = vi.fn(
    async (params: Parameters<typeof prepareTranscriptReadAuthority>[0]) => {
      if (params.purpose === "conversation-differences") {
        throw new Error("Connection discovery requires its existing operator read authority");
      }
      expect(params.authority).toBe(authority);
      const id = params.sources[0]?.sessionKey.split(":").at(-1)!;
      if (id === "denied") throw new Error("Native sharing policy refused this person");
      const read = { assertCurrent: vi.fn(), release: vi.fn() };
      reads.push(read);
      return { ...read, sources: [{ sessionId: id }] };
    },
  );
  return { state, authority, reads, prepareRead };
}

describe("active connection discovery", () => {
  it("joins real lifecycle facts with the original native read authority, never identity guesses", async () => {
    source("allowed");
    source("denied");
    source("other-agent", "other");
    const caller = reader();
    const result = await prepareConversationActiveConnections(
      { authority: caller.authority, getRuntimeConfig: () => ({}), agentId: "example", limit: 50 },
      { selectTalkConnectionPresentations, prepareTranscriptReadAuthority: caller.prepareRead },
    );
    const rows = result.present();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "Private call", state: "preparing", channel: "matrix" });
    expect(Value.Check(ConversationActiveConnectionSchema, rows[0])).toBe(true);
    expect(rows[0]).not.toHaveProperty("readTarget");
    expect(rows[0]).not.toHaveProperty("sessionKey");
    expect(caller.prepareRead).toHaveBeenCalledTimes(2);
    result.release();
    expect(caller.reads[0]?.release).toHaveBeenCalledOnce();
  });

  it("reveals no connection metadata without an original operator read source", async () => {
    source("unknown-reader");
    const caller = reader();
    const result = await prepareConversationActiveConnections(
      { getRuntimeConfig: () => ({}), agentId: "example", limit: 50 },
      { selectTalkConnectionPresentations, prepareTranscriptReadAuthority: caller.prepareRead },
    );
    expect(result.present()).toEqual([]);
    expect(caller.prepareRead).not.toHaveBeenCalled();
    result.release();
  });

  it("revalidates provider state, original read permission and reader immediately before presentation", async () => {
    const call = source("current");
    const caller = reader();
    const result = await prepareConversationActiveConnections(
      { authority: caller.authority, getRuntimeConfig: () => ({}), agentId: "example", limit: 50 },
      { selectTalkConnectionPresentations, prepareTranscriptReadAuthority: caller.prepareRead },
    );
    call.state.ready = true;
    expect(result.present()[0]?.state).toBe("ready");
    caller.reads[0]!.assertCurrent.mockImplementation(() => {
      throw new Error("Sharing revoked");
    });
    expect(result.present()).toEqual([]);
    caller.state.current = false;
    expect(() => result.present()).toThrow("Reader revoked");
    result.release();
    expect(() => result.present()).toThrow("released");
  });

  it("does not publish a closed incarnation after asynchronous native authorization", async () => {
    const call = source("closing");
    const caller = reader();
    const entered = createDeferred();
    const gate = createDeferred();
    const pending = prepareConversationActiveConnections(
      { authority: caller.authority, getRuntimeConfig: () => ({}), agentId: "example", limit: 50 },
      {
        selectTalkConnectionPresentations,
        prepareTranscriptReadAuthority: async (params) => {
          entered.resolve();
          await gate.promise;
          return caller.prepareRead(params);
        },
      },
    );
    await entered.promise;
    call.release();
    gate.resolve();
    const result = await pending;
    expect(result.present()).toEqual([]);
    result.release();
    expect(caller.reads[0]?.release).toHaveBeenCalledOnce();
  });
});
