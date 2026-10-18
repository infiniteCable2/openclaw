import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetUnifiedTalkSession,
  getUnifiedTalkSession,
  listUnifiedTalkSessions,
  publishTalkConnectionPresentation,
  rememberUnifiedTalkSession,
  selectTalkConnectionPresentations,
  type TalkConnectionPresentation,
} from "./session-registry.js";

const ownedIds = new Set<string>();
afterEach(() => {
  for (const id of ownedIds) forgetUnifiedTalkSession(id);
  ownedIds.clear();
});
function publication(id: string) {
  ownedIds.add(id);
  const lifecycle = { state: "preparing" as "preparing" | "ready" | "closed", current: true };
  const metadata: TalkConnectionPresentation = {
    kind: "assistant",
    channel: "voiceassistant",
    label: "Room assistant",
    readTarget: { agentId: "example", sessionKey: "agent:example:voice:dialog" },
    input: { audio: true },
    output: { audio: true },
    operations: ["current-turn-reply"],
    state: () => lifecycle.state,
    assertCurrent() {
      if (!lifecycle.current) throw new Error("Original owner revoked");
    },
  };
  return { metadata, lifecycle };
}

describe("native unified Talk presentation owner", () => {
  it("uses the actual registry record and follows readiness without a second inventory", () => {
    const id = "presentation-native-record";
    const fixture = publication(id);
    const record = { kind: "managed-room" as const, handoffId: "handoff", roomId: "room" };
    rememberUnifiedTalkSession(id, record);
    const release = publishTalkConnectionPresentation(id, fixture.metadata);
    const selected = selectTalkConnectionPresentations().find(
      (item) => item.presentation === fixture.metadata,
    );
    expect(selected?.connectionRef).toMatch(/^talk_[a-f0-9]{32}$/u);
    expect(getUnifiedTalkSession(id)).toBe(record);
    expect(selected?.presentation.state()).toBe("preparing");
    fixture.lifecycle.state = "ready";
    expect(selected?.presentation.state()).toBe("ready");
    fixture.lifecycle.state = "closed";
    expect(() => selected?.assertCurrent()).toThrow("closed");
    expect(selectTalkConnectionPresentations()).not.toContainEqual(selected);
    // Failed resource cleanup can retain the real record without advertising its output.
    expect(getUnifiedTalkSession(id)).toBe(record);
    release();
    expect(getUnifiedTalkSession(id)).toBe(record);
    expect(record).not.toHaveProperty("presentation");
  });

  it("revokes old snapshots and cannot let delayed release delete a replacement", () => {
    const id = "presentation-replacement";
    const first = publication(id);
    const releaseFirst = publishTalkConnectionPresentation(id, first.metadata);
    const selected = selectTalkConnectionPresentations().find(
      (item) => item.presentation === first.metadata,
    )!;
    const replacement = { kind: "managed-room" as const, handoffId: "next", roomId: "next" };
    rememberUnifiedTalkSession(id, replacement);
    const second = publication(id);
    const releaseSecond = publishTalkConnectionPresentation(id, second.metadata);
    releaseFirst();
    expect(() => selected.assertCurrent()).toThrow("replaced");
    expect(getUnifiedTalkSession(id)).toBe(replacement);
    const current = selectTalkConnectionPresentations().find(
      (item) => item.presentation === second.metadata,
    )!;
    expect(current.connectionRef).not.toBe(selected.connectionRef);
    releaseSecond();
  });

  it("refuses a closed original source and retires external Speech metadata at its fence", () => {
    const id = "presentation-external";
    const fixture = publication(id);
    fixture.lifecycle.current = false;
    expect(() => publishTalkConnectionPresentation(id, fixture.metadata)).toThrow("revoked");
    expect(() => getUnifiedTalkSession(id)).toThrow("Unknown");
    fixture.lifecycle.current = true;
    const release = publishTalkConnectionPresentation(id, fixture.metadata);
    expect(getUnifiedTalkSession(id).kind).toBe("external-speech");
    fixture.lifecycle.current = false;
    expect(
      selectTalkConnectionPresentations().some((item) => item.presentation === fixture.metadata),
    ).toBe(false);
    release();
    release();
    expect(() => getUnifiedTalkSession(id)).toThrow("Unknown");
  });

  it("does not invoke an operation or provider to read already-published state", () => {
    const id = "presentation-passive";
    const fixture = publication(id);
    const state = vi.fn(fixture.metadata.state);
    publishTalkConnectionPresentation(id, { ...fixture.metadata, state });
    const count = listUnifiedTalkSessions().length;
    selectTalkConnectionPresentations();
    selectTalkConnectionPresentations();
    expect(listUnifiedTalkSessions()).toHaveLength(count);
    expect(state).toHaveBeenCalledTimes(2);
  });
});
