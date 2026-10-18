import { describe, expect, it, vi } from "vitest";
import {
  captureReplyInitialSessionContext,
  resolveReplyInitialSessionContext,
  type ReplyInitialSessionContext,
} from "./session-initial-context.js";

function fixture() {
  const source: ReplyInitialSessionContext = {
    agentId: "example",
    sessionKey: "agent:example:matrix:direct:peer",
    assertCurrent: vi.fn<() => void>(),
    context: {
      source: { agentId: "example", path: "/example/agent.sqlite", databaseIdentity: "synthetic" },
      sourceSessionKey: "agent:example:source",
      sourceEntry: { sessionId: "source", lifecycleRevision: "original" },
      sourceVersion: { generation: "original", rawSeq: 1, updatedAt: 1 },
      targetSessionId: "prospective",
      events: [{ type: "session", id: "prospective", version: 3 }],
    },
  };
  return {
    source,
    params: {
      initialContext: source,
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      retargetedSession: false,
      isSystemEvent: false,
      resetTriggered: false,
    },
  };
}

describe("host-owned reply initial context", () => {
  it("does not change ordinary initialization when no seed is supplied", () => {
    const { params } = fixture();
    expect(captureReplyInitialSessionContext(undefined)).toBeUndefined();
    expect(
      resolveReplyInitialSessionContext({ ...params, initialContext: undefined }),
    ).toBeUndefined();
  });

  it("pins data and the live assertion before asynchronous reply preparation", () => {
    const { source, params } = fixture();
    const retained = captureReplyInitialSessionContext(source)!;
    source.context.events = [];
    source.sessionKey = "agent:example:another-target";
    source.assertCurrent = () => {
      throw new Error("Replaced carrier");
    };
    expect(
      resolveReplyInitialSessionContext({ ...params, initialContext: retained }),
    ).toMatchObject({
      targetSessionId: "prospective",
      events: [{ type: "session", id: "prospective" }],
    });
  });

  it.each([
    { agentId: "another-agent" },
    { sessionKey: "agent:example:another-target" },
    { retargetedSession: true },
    { isSystemEvent: true },
    { resetTriggered: true },
    { entry: { sessionId: "existing", updatedAt: 1 } },
    { parentSessionKey: "agent:example:thread-parent" },
    { modelParentSessionKey: "agent:example:model-parent" },
  ])("refuses a different or existing initialization target %j", (change) => {
    const { params } = fixture();
    expect(() => resolveReplyInitialSessionContext({ ...params, ...change })).toThrow(
      "admitted new conversation",
    );
  });

  it("refuses an empty prospective identity before any lifecycle change", () => {
    const { params, source } = fixture();
    source.context.targetSessionId = " ";
    expect(() => resolveReplyInitialSessionContext(params)).toThrow("prospective target identity");
  });

  it("never turns captured snapshot data into authority after its host source expires", () => {
    const { params, source } = fixture();
    let active = true;
    source.assertCurrent = () => {
      if (!active) {
        throw new Error("Source read authority expired");
      }
    };
    const retained = captureReplyInitialSessionContext(source);
    active = false;
    expect(() =>
      resolveReplyInitialSessionContext({ ...params, initialContext: retained }),
    ).toThrow("Source read authority expired");
  });
});
