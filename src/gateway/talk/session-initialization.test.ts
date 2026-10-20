import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ensureClientVoiceAgentSessionEntry } from "../../talk/client-voice-session.js";
import type { resolveSandboxedSessionCreation } from "../operator-session-run.js";
import { createSessionMutationTestClient } from "../server-methods/sessions-mutations.owner.test-support.js";
import type { TalkOperatorRunSource } from "./client-agent-runtime.js";
import type { createTalkOperatorRunSource } from "./operator-run-source.js";
import { ensureGatewayTalkSessionEntry } from "./session-initialization.js";

const mocks = vi.hoisted(() => ({
  ensure: vi.fn<typeof ensureClientVoiceAgentSessionEntry>(),
  source: vi.fn<typeof createTalkOperatorRunSource>(),
  sandbox: vi.fn<typeof resolveSandboxedSessionCreation>(),
}));

// mock-isolation: Native storage has its own creation tests; hold this caller at its commit boundary.
vi.mock("../../talk/client-voice-session.js", () => ({
  ensureClientVoiceAgentSessionEntry: mocks.ensure,
}));
// mock-isolation: Inject a real issued authority without opening profile stores or Gateway admission.
vi.mock("./operator-run-source.js", () => ({
  createTalkOperatorRunSource: mocks.source,
}));
// mock-isolation: Role/sandbox policy is independent of original Talk recipient lifetime.
vi.mock("../operator-session-run.js", () => ({
  resolveSandboxedSessionCreation: mocks.sandbox,
}));

type InitializationInput = Parameters<typeof ensureGatewayTalkSessionEntry>[0];
type VoiceCreationInput = Parameters<typeof ensureClientVoiceAgentSessionEntry>[0];

function fixture(mode: "native" | "branches") {
  const cfg: OpenClawConfig = {
    agents: { entries: { researcher: { conversationMode: mode } } },
  };
  let released = false;
  const release = vi.fn(() => {
    released = true;
  });
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "profile-alpha",
    scopes: ["operator.write"],
    gatewayAccessGrant: null,
    assertCurrent() {
      if (released) {
        throw new Error("Original Talk source released");
      }
    },
  });
  const acquire = vi.fn<TalkOperatorRunSource>().mockResolvedValue({ authority, release });
  mocks.source.mockReturnValue(acquire);
  const params: InitializationInput = {
    cfg,
    client: createSessionMutationTestClient("profile-alpha"),
    context: { getRuntimeConfig: () => cfg },
    target: {
      agentId: "researcher",
      sessionKey: "agent:researcher:talk:original",
      canonicalKey: "agent:researcher:talk:original",
      storePath: "/synthetic/agent.sqlite",
    },
    assertCurrent: vi.fn(),
    onCreatedSessionCommitted: vi.fn(),
  };
  return { params, acquire, release };
}

beforeEach(() => {
  mocks.ensure.mockReset().mockResolvedValue("created-session");
  mocks.source.mockReset();
  mocks.sandbox.mockReset().mockReturnValue(undefined);
});

describe.each(["native", "branches"] as const)("Talk creation in %s mode", (mode) => {
  it.each(["success", "failure"] as const)(
    "holds the original profile authority through native creation %s, then releases exactly once",
    async (outcome) => {
      const f = fixture(mode);
      const entered = Promise.withResolvers<VoiceCreationInput>();
      const completion = Promise.withResolvers<string>();
      mocks.ensure.mockImplementation((input) => {
        entered.resolve(input);
        return completion.promise;
      });
      const operation = ensureGatewayTalkSessionEntry(f.params);
      const input = await entered.promise;
      expect(mocks.source).toHaveBeenCalledExactlyOnceWith({
        client: f.params.client,
        context: f.params.context,
      });
      expect(f.acquire).toHaveBeenCalledExactlyOnceWith({
        assertCurrent: f.params.assertCurrent,
      });
      expect(input).toMatchObject({
        agentId: f.params.target.agentId,
        sessionKey: f.params.target.canonicalKey,
        storePath: f.params.target.storePath,
        chatType: "direct",
        creation: {
          via: "operator",
          actor: { type: "human", source: "profile", id: "profile-alpha" },
        },
        privateAudience: {
          agentId: f.params.target.agentId,
          sessionKey: f.params.target.canonicalKey,
          channelId: "webchat",
          participant: { type: "profile", id: "profile-alpha" },
        },
      });
      expect(input.cfg).toBe(f.params.cfg);
      expect(input.assertCommitAllowed).toBe(f.params.assertCurrent);
      expect(input.onCreatedSessionCommitted).toBe(f.params.onCreatedSessionCommitted);
      expect(f.release).not.toHaveBeenCalled();
      expect(input.privateAudience).toBeDefined();
      input.privateAudience?.assertCurrent();
      if (outcome === "success") {
        completion.resolve("created-session");
        await expect(operation).resolves.toBe("created-session");
      } else {
        const failure = new Error("Native creation refused");
        const rejected = expect(operation).rejects.toBe(failure);
        completion.reject(failure);
        await rejected;
      }
      expect(f.release).toHaveBeenCalledOnce();
      expect(() => input.privateAudience?.assertCurrent()).toThrow("Original Talk source released");
    },
  );

  it.each(["absent", "unidentified-device", "synthetic-profile"] as const)(
    "does not acquire profile authority for an %s caller",
    async (caller) => {
      const f = fixture(mode);
      if (caller === "absent") {
        f.params.client = null;
      } else if (caller === "unidentified-device") {
        const client = createSessionMutationTestClient();
        client.connect.client = {
          id: GATEWAY_CLIENT_IDS.TEST,
          version: "1",
          platform: "test",
          mode: GATEWAY_CLIENT_MODES.TEST,
        };
        f.params.client = client;
      } else {
        f.params.client = {
          ...createSessionMutationTestClient("profile-alpha"),
          internal: { syntheticClient: true },
        };
      }
      await expect(ensureGatewayTalkSessionEntry(f.params)).resolves.toBe("created-session");
      expect(mocks.source).not.toHaveBeenCalled();
      expect(f.acquire).not.toHaveBeenCalled();
      expect(f.release).not.toHaveBeenCalled();
      expect(mocks.ensure).toHaveBeenCalledOnce();
      expect(mocks.ensure.mock.calls[0]?.[0].privateAudience).toBeUndefined();
    },
  );

  it("propagates original source refusal without starting native creation", async () => {
    const f = fixture(mode);
    const failure = new Error("Original operator revoked");
    f.acquire.mockRejectedValue(failure);
    await expect(ensureGatewayTalkSessionEntry(f.params)).rejects.toBe(failure);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });
});
