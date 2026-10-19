import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { TalkOperatorRunSource } from "./client-agent-runtime.js";

const mocks = vi.hoisted(() => ({ entry: vi.fn(), facts: vi.fn() }));
// mock-isolation: Test the held ingress/recipient boundary, not native row publication I/O.
vi.mock("../../config/sessions/session-accessor.js", () => ({ loadSessionEntry: mocks.entry }));
vi.mock("../session-sharing-preparation.js", () => ({ prepareSessionMutationFacts: mocks.facts }));

import { createGatewayVoiceTranscriptAudience } from "./voice-transcript-audience.js";

function fixture(profileId = "example-person") {
  let current = true;
  let audioOpen = true;
  const entry: SessionEntry = {
    sessionId: "original-session",
    lifecycleRevision: "original-life",
    updatedAt: 1,
    chatType: "direct",
  };
  const target = {
    agentId: "example",
    sessionKey: "agent:example:speech",
    canonicalKey: "agent:example:speech",
    storePath: "/example/store.sqlite",
  };
  const releaseSource = vi.fn();
  const releaseFacts = vi.fn();
  const authority = createAdmittedRunOperatorAuthority({
    profileId,
    scopes: ["operator.write"],
    gatewayAccessGrant: null,
    assertCurrent() {
      if (!current) {
        throw new Error("Original person policy revoked");
      }
    },
  });
  const captureOperatorAuthority = vi.fn<TalkOperatorRunSource>(async (invocation) => {
    invocation.assertCurrent();
    return { authority, release: releaseSource };
  });
  mocks.entry.mockReturnValue(entry);
  mocks.facts.mockResolvedValue({
    readCurrent: () => ({ target: { ...target, entry } }),
    release: releaseFacts,
  });
  const input = {
    target,
    participant: { type: "profile" as const, id: profileId },
    getRuntimeConfig: () => ({}),
    captureOperatorAuthority,
    assertInputCurrent() {
      if (!audioOpen) {
        throw new Error("Input closed");
      }
    },
  };
  return {
    input,
    entry,
    releaseSource,
    releaseFacts,
    captureOperatorAuthority,
    close: () => {
      audioOpen = false;
    },
    revoke: () => {
      current = false;
    },
  };
}

beforeEach(() => vi.resetAllMocks());

describe("native voice transcript recipient custody", () => {
  it("keeps one accepted utterance bound to its original person and target after normal close", async () => {
    const f = fixture();
    const prepare = createGatewayVoiceTranscriptAudience(f.input);
    f.input.participant.id = "mutated-caller-metadata";
    const held = await prepare();
    expect(held?.audience.participant).toEqual({ type: "profile", id: "example-person" });
    f.close();
    expect(() => held?.audience.assertCurrent()).not.toThrow();
    f.revoke();
    expect(() => held?.audience.assertCurrent()).toThrow("Original person policy revoked");
    held?.release();
    held?.release();
    expect(f.releaseSource).toHaveBeenCalledOnce();
    expect(f.releaseFacts).toHaveBeenCalledOnce();
  });

  it("refuses fresh admission after close without acquiring a new owner", async () => {
    const f = fixture();
    const prepare = createGatewayVoiceTranscriptAudience(f.input);
    f.close();
    await expect(prepare()).rejects.toThrow("Input closed");
    expect(mocks.facts).not.toHaveBeenCalled();
    expect(f.captureOperatorAuthority).not.toHaveBeenCalled();
  });

  it.each(["owner", "group", "unknown", "public", "missing"] as const)(
    "never derives a personal recipient from %s",
    async (kind) => {
      const f = fixture(kind === "owner" ? GATEWAY_OWNER_PROFILE_ID : undefined);
      if (kind === "group") {
        f.entry.chatType = "group";
      }
      if (kind === "unknown") {
        delete f.entry.chatType;
      }
      if (kind === "public") {
        f.entry.publicShare = { id: "public", sessionId: f.entry.sessionId, createdAt: 1 };
      }
      if (kind === "missing") {
        mocks.entry.mockReturnValue(undefined);
      }
      expect(await createGatewayVoiceTranscriptAudience(f.input)()).toBeUndefined();
      expect(f.captureOperatorAuthority).not.toHaveBeenCalled();
    },
  );

  it("refuses a successor incarnation instead of rebinding an existing voice record", async () => {
    const f = fixture();
    const prepare = createGatewayVoiceTranscriptAudience(f.input);
    f.entry.sessionId = "successor";
    await expect(prepare()).rejects.toThrow("original native target");
    expect(f.releaseFacts).toHaveBeenCalledOnce();
    expect(f.captureOperatorAuthority).not.toHaveBeenCalled();
  });

  it("refuses a row that differs from the creating owner's ensured session", async () => {
    const f = fixture();
    const prepare = createGatewayVoiceTranscriptAudience({
      ...f.input,
      expectedSessionId: "different-ensured-session",
    });
    expect(await prepare()).toBeUndefined();
    expect(mocks.facts).not.toHaveBeenCalled();
    expect(f.captureOperatorAuthority).not.toHaveBeenCalled();
  });

  it("revokes an admitted private recipient when sharing changes", async () => {
    const f = fixture();
    const held = await createGatewayVoiceTranscriptAudience(f.input)();
    expect(held).toBeDefined();
    f.entry.publicShare = { id: "new-public", sessionId: f.entry.sessionId, createdAt: 1 };
    expect(() => held?.audience.assertCurrent()).toThrow("audience or incarnation changed");
    held?.release();
  });
});
