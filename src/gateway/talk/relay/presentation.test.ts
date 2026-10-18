import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetUnifiedTalkSession,
  getUnifiedTalkSession,
  publishTalkConnectionPresentation,
  rememberUnifiedTalkSession,
  selectTalkConnectionPresentations,
} from "../../../talk/session-registry.js";
import { publishTalkRealtimeRelayPresentation } from "./presentation.js";

const id = "native-relay-presentation";
afterEach(() => forgetUnifiedTalkSession(id));
function fixture() {
  const target = {
    agentId: "example",
    sessionKey: "agent:example:voice:one",
    canonicalKey: "agent:example:voice:one",
    storePath: "/example/sessions.sqlite",
  };
  const state = { ready: false, current: true, sourceCurrent: true };
  const native = {
    connId: "original-connection",
    sessionTarget: target,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    presentationState: () => (state.ready ? ("ready" as const) : ("preparing" as const)),
  };
  rememberUnifiedTalkSession(id, {
    kind: "realtime-relay",
    connId: native.connId,
    relaySessionId: id,
    sessionTarget: target,
  });
  const findSession = vi.fn(() => (state.current ? native : undefined));
  const params = {
    sessionId: id,
    connId: native.connId,
    client: { connId: native.connId },
    context: {},
    hasCurrentClientAuthority: () => state.sourceCurrent,
  };
  return { state, native, params, findSession };
}
describe("native realtime relay publication", () => {
  it("publishes the real owner, follows provider readiness and hides it immediately on close", () => {
    const f = fixture();
    publishTalkRealtimeRelayPresentation(f.params, { findSession: f.findSession });
    const selected = selectTalkConnectionPresentations().find(
      (entry) => entry.presentation.label === "Browser Talk",
    )!;
    expect(selected.presentation.readTarget).toEqual({
      agentId: f.native.sessionTarget.agentId,
      sessionKey: f.native.sessionTarget.canonicalKey,
    });
    expect(selected.presentation.state()).toBe("preparing");
    f.state.ready = true;
    expect(selected.presentation.state()).toBe("ready");
    f.state.current = false;
    expect(() => selected.assertCurrent()).toThrow("no longer current");
    expect(selectTalkConnectionPresentations()).not.toContainEqual(selected);
    // Transport cleanup can still own the same native record after output fencing.
    expect(getUnifiedTalkSession(id).kind).toBe("realtime-relay");
  });
  it("refuses a wrong connection and original source revocation without creating grants", () => {
    const f = fixture();
    expect(() =>
      publishTalkRealtimeRelayPresentation(
        {
          ...f.params,
          client: { connId: "different" },
        },
        { findSession: f.findSession },
      ),
    ).toThrow("no longer current");
    expect(getUnifiedTalkSession(id)).not.toHaveProperty("presentation");
    publishTalkRealtimeRelayPresentation(f.params, { findSession: f.findSession });
    f.state.sourceCurrent = false;
    expect(selectTalkConnectionPresentations()).toEqual([]);
    expect(() =>
      publishTalkConnectionPresentation(id, {
        ...getUnifiedTalkSession(id).presentation!,
      }),
    ).toThrow("no longer current");
  });
});
