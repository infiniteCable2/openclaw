import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TalkOperatorRunSource } from "./client-agent-runtime.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

const mocks = vi.hoisted(() => ({ sessionId: vi.fn(), prepare: vi.fn() }));
// mock-isolation: Existing transcript selection and worker reads are tested by their native owners.
vi.mock("../../talk/client-voice-session.js", () => ({
  resolveClientVoiceAgentSessionId: mocks.sessionId,
}));
vi.mock("../../talk/voice-conversation-knowledge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../talk/voice-conversation-knowledge.js")>()),
  prepareVoiceConversationKnowledge: mocks.prepare,
}));
import { prepareTalkProviderConversationContext } from "./conversation-context.js";

const config: OpenClawConfig = {
  agents: { entries: { example: { conversationMode: "branches" } } },
};
const participant = { type: "profile" as const, id: "example-person" };
const target: PreparedTalkSessionTarget = {
  agentId: "example",
  sessionKey: "main",
  canonicalKey: "agent:example:speech:branch",
  storePath: "/example/store.sqlite",
};
function setup() {
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("Original source revoked");
    }
  };
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "example-person",
    scopes: ["operator.write"],
    gatewayAccessGrant: null,
    rolePolicy: { sessionAccessCap: "none", sandboxRequired: false, agents: ["example"] },
    assertCurrent,
    retain: () => () => {},
  });
  const sourceRelease = vi.fn();
  const captureOperatorAuthority = vi.fn<TalkOperatorRunSource>(async () => ({
    authority,
    release: sourceRelease,
  }));
  const knowledgeRelease = vi.fn(async () => {});
  mocks.sessionId.mockReturnValue("native-session");
  mocks.prepare.mockResolvedValue({
    fragments: [{ kind: "conversation-data", text: "quoted related facts" }],
    observed: [],
    assertCurrent,
    release: knowledgeRelease,
  });
  return {
    assertCurrent,
    sourceRelease,
    captureOperatorAuthority,
    knowledgeRelease,
    revoke: () => {
      current = false;
    },
  };
}
beforeEach(() => vi.resetAllMocks());

describe("provider startup native context snapshot", () => {
  it("does nothing to native source-compatible mode", async () => {
    const owner = setup();
    mocks.prepare.mockResolvedValue(undefined);
    const context = await prepareTalkProviderConversationContext({
      target,
      assertCurrent: owner.assertCurrent,
      getRuntimeConfig: () => ({}),
      captureOperatorAuthority: owner.captureOperatorAuthority,
    });
    expect(context.instructions).toBe("");
    expect(owner.captureOperatorAuthority).toHaveBeenCalledOnce();
    expect(mocks.prepare).toHaveBeenCalledOnce();
    await context.release();
    expect(owner.sourceRelease).toHaveBeenCalledOnce();
  });

  it("does not retain absent-row authority when native mode captured no context", async () => {
    const owner = setup();
    mocks.sessionId.mockReturnValue(undefined);
    let materialized = false;
    const assertAbsentTarget = vi.fn(() => {
      if (materialized) {
        throw new Error("Original target was absent");
      }
    });
    const context = await prepareTalkProviderConversationContext({
      target,
      assertCurrent: assertAbsentTarget,
      getRuntimeConfig: () => ({}),
      captureOperatorAuthority: owner.captureOperatorAuthority,
    });
    expect(assertAbsentTarget).toHaveBeenCalled();
    // The guarded native creation owner now checks the exact ensured session.
    // This empty snapshot must not reapply the superseded absence assertion.
    materialized = true;
    expect(() => assertAbsentTarget()).toThrow("Original target was absent");
    expect(() => context.assertCurrent()).not.toThrow();
    expect(owner.captureOperatorAuthority).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
    await context.release();
    expect(() => context.assertCurrent()).toThrow("released");
  });

  it("still requires a current original source before native-mode preparation", async () => {
    const owner = setup();
    owner.revoke();
    await expect(
      prepareTalkProviderConversationContext({
        target,
        assertCurrent: owner.assertCurrent,
        getRuntimeConfig: () => ({}),
        captureOperatorAuthority: owner.captureOperatorAuthority,
      }),
    ).rejects.toThrow("revoked");
    expect(owner.captureOperatorAuthority).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("passes original authority and canonical target into data-only provider instructions", async () => {
    const owner = setup();
    const context = await prepareTalkProviderConversationContext({
      target,
      assertCurrent: owner.assertCurrent,
      getRuntimeConfig: () => config,
      captureOperatorAuthority: owner.captureOperatorAuthority,
      participant,
    });
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
          storePath: target.storePath,
          sessionId: "native-session",
        },
        participant,
      }),
    );
    expect(context.instructions).toContain("quoted related facts");
    expect(context.instructions).toContain("not live synchronization");
    expect(context.instructions).not.toContain("<user>");
    await Promise.all([context.release(), context.release()]);
    expect(owner.sourceRelease).toHaveBeenCalledOnce();
    expect(owner.knowledgeRelease).toHaveBeenCalledOnce();
    expect(() => context.assertCurrent()).toThrow("released");
  });

  it("describes absent native admission without creating or copying a user turn", async () => {
    const owner = setup();
    mocks.sessionId.mockReturnValue(undefined);
    const context = await prepareTalkProviderConversationContext({
      target,
      assertCurrent: owner.assertCurrent,
      getRuntimeConfig: () => config,
      captureOperatorAuthority: owner.captureOperatorAuthority,
    });
    expect(context.instructions).toBe("");
    expect(mocks.prepare).not.toHaveBeenCalled();
    await context.release();
  });

  it("keeps the original person across asynchronous startup authority preparation", async () => {
    const owner = setup();
    const original = { ...participant };
    const context = await prepareTalkProviderConversationContext({
      target,
      assertCurrent: owner.assertCurrent,
      getRuntimeConfig: () => config,
      captureOperatorAuthority: async (invocation) => {
        original.id = "different-person";
        return owner.captureOperatorAuthority(invocation);
      },
      participant: original,
    });
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ participant }));
    await context.release();
  });

  it("fences a captured snapshot when the original live source changes", async () => {
    const owner = setup();
    const context = await prepareTalkProviderConversationContext({
      target,
      assertCurrent: owner.assertCurrent,
      getRuntimeConfig: () => config,
      captureOperatorAuthority: owner.captureOperatorAuthority,
    });
    owner.revoke();
    expect(() => context.assertCurrent()).toThrow("revoked");
    await context.release();
  });
});
