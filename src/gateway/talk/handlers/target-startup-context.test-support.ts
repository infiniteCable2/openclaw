import { assert, expect, it, vi, type Mock } from "vitest";
import { createConversationKnowledgeScenario } from "../../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { recordConversationKnowledgeTurn } from "../../../config/sessions/conversation-knowledge-store.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
} from "../../../config/sessions/session-accessor.js";
import { ensureAgentConversationRoot } from "../../../config/sessions/session-conversation-root.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { OpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { invalidateGatewayDeviceRevocation } from "../../device-revocation.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import type { GatewayWsClient } from "../../server/ws-types.js";
import * as conversationContext from "../conversation-context.js";
import { prepareTalkSessionTarget } from "../session-target.js";

type CreateBrowserSession = NonNullable<RealtimeVoiceProviderPlugin["createBrowserSession"]>;
type TargetStartupContextFixture = {
  state: OpenClawTestState;
  config: OpenClawConfig;
  client: Pick<GatewayWsClient, "connId" | "authenticatedUserProfile">;
  context: GatewayRequestContext;
  createBrowserSession: Mock<CreateBrowserSession>;
  browserSession: Awaited<ReturnType<CreateBrowserSession>>;
  createParams: Record<string, unknown>;
  bootstrap: Mock<() => Promise<string>>;
  createRelay: unknown;
  dispatch(method: string, params: Record<string, unknown>): Promise<unknown>;
};

/** Register startup-context regressions inside the owning target suite's existing native fixture. */
export function defineTalkTargetStartupContextTests(getFixture: () => TargetStartupContextFixture) {
  it("includes an existing private sibling in the very first browser branch before provider startup", async () => {
    const f = getFixture();
    const fixture = await createConversationKnowledgeScenario(f.state);
    f.config = { ...fixture.cfg, talk: { agentId: "main" } };
    const participant = {
      type: "profile" as const,
      id: f.client.authenticatedUserProfile!.profileId,
    };
    try {
      const sibling = await fixture.branch("personal-chat", participant);
      const siblingOwner = await fixture.claim(sibling);
      const terminal = await fixture.append(
        sibling,
        "private-before-browser",
        "stop",
        "The private synthetic appointment is at noon.",
      );
      expect(await recordConversationKnowledgeTurn({ ...siblingOwner, ...terminal })).toBe(true);
      const target = prepareTalkSessionTarget(
        f.config,
        undefined,
        "conversation-input",
        f.client.connId,
      );
      expect(loadSessionEntry({ ...target, sessionKey: target.canonicalKey })).toBeUndefined();
      f.createBrowserSession.mockImplementationOnce(async (request) => {
        expect(loadSessionEntry({ ...target, sessionKey: target.canonicalKey })).toMatchObject({
          conversationTopology: { role: "branch" },
          chatType: "direct",
        });
        expect(request.instructions).toContain("The private synthetic appointment is at noon.");
        expect(request.instructions).toContain("not live synchronization");
        expect(request.instructions).toContain("use openclaw_agent_consult");
        return f.browserSession;
      });
      expect(await f.dispatch("talk.client.create", f.createParams)).toHaveBeenCalledWith(
        true,
        expect.objectContaining(f.browserSession),
        undefined,
      );
      expect(f.createBrowserSession).toHaveBeenCalledOnce();
      // No fake first utterance/participant was written to make a fresh recipient
      // appear historical. The current browser proof owns only this disclosure.
      const created = loadSessionEntry({ ...target, sessionKey: target.canonicalKey });
      expect(created?.participantCount ?? 0).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it.each(["native", "branches"] as const)(
    "keeps native-mode defer and retains a genuinely begun %s attempt on provider failure",
    async (conversationMode) => {
      const f = getFixture();
      f.config.agents!.entries!.voice = { conversationMode };
      if (conversationMode === "branches") {
        await ensureAgentConversationRoot({ cfg: f.config, agentId: "voice" });
      }
      const target = prepareTalkSessionTarget(
        f.config,
        undefined,
        "conversation-input",
        f.client.connId,
      );
      f.createBrowserSession.mockImplementationOnce(async () => {
        const entry = loadSessionEntry({ ...target, sessionKey: target.canonicalKey });
        if (conversationMode === "branches") {
          expect(entry).toMatchObject({ conversationTopology: { role: "branch" } });
        } else {
          expect(entry).toBeUndefined();
        }
        throw new Error("Synthetic provider startup failure");
      });
      expect(await f.dispatch("talk.client.create", f.createParams)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("Synthetic provider startup failure"),
        }),
      );
      expect(f.createBrowserSession).toHaveBeenCalledOnce();
      const entry = loadSessionEntry({ ...target, sessionKey: target.canonicalKey });
      if (conversationMode === "branches") {
        assert(entry, "Expected the admitted branch to survive provider failure");
        expect(entry).toMatchObject({ conversationTopology: { role: "branch" } });
        expect(
          readSessionTranscriptMessageEvents({
            ...target,
            sessionKey: target.canonicalKey,
            sessionId: entry.sessionId,
          }),
        ).toEqual([]);
      } else {
        expect(entry).toBeUndefined();
      }
    },
  );

  it("refuses authority revocation before an initial branch is materialized", async () => {
    const f = getFixture();
    f.config.agents!.entries!.voice = { conversationMode: "branches" };
    await ensureAgentConversationRoot({ cfg: f.config, agentId: "voice" });
    const target = prepareTalkSessionTarget(
      f.config,
      undefined,
      "conversation-input",
      f.client.connId,
    );
    f.bootstrap.mockImplementationOnce(async () => {
      invalidateGatewayDeviceRevocation(f.context, "talk-target-device", "operator");
      return "Agent context fixture.";
    });
    expect(await f.dispatch("talk.client.create", f.createParams)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Gateway requester authority changed"),
      }),
    );
    expect(f.createBrowserSession).not.toHaveBeenCalled();
    expect(loadSessionEntry({ ...target, sessionKey: target.canonicalKey })).toBeUndefined();
  });

  it("retains the original WebSocket device revocation while provider context is awaited", async () => {
    const f = getFixture();
    const gate = createDeferredCore();
    const started = createDeferredCore();
    f.bootstrap.mockImplementationOnce(async () => {
      started.resolve();
      await gate.promise;
      return "Agent context fixture.";
    });
    const pending = f.dispatch("talk.client.create", f.createParams);
    try {
      await started.promise;
      invalidateGatewayDeviceRevocation(f.context, "talk-target-device", "operator");
    } finally {
      gate.resolve();
    }
    expect(await pending).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Gateway requester authority changed"),
      }),
    );
    expect(f.createBrowserSession).not.toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "voice", sessionKey: "agent:voice:main" })).toBeUndefined();
  });

  it("rechecks native routing after empty provider-context preparation yields", async () => {
    const f = getFixture();
    const prepare = conversationContext.prepareTalkProviderConversationContext;
    vi.spyOn(conversationContext, "prepareTalkProviderConversationContext").mockImplementationOnce(
      async (params) => {
        const prepared = await prepare(params);
        expect(prepared.instructions).toBe("");
        f.config = { ...f.config, session: { scope: "global" } };
        return prepared;
      },
    );
    const respond = await f.dispatch("talk.session.create", {
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("session changed before talk.session.create"),
      }),
    );
    expect(f.createRelay).not.toHaveBeenCalled();
  });
}
