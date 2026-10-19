import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createConversationKnowledgeScenario } from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { recordConversationKnowledgeTurn } from "../../config/sessions/conversation-knowledge-store.js";
import { recordSessionParticipantInWorker } from "../../config/sessions/session-sharing-store.async.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

type NativeRunParams = Parameters<
  typeof import("../../agents/embedded-agent.js").runEmbeddedAgent
>[0];
const mocks = vi.hoisted(() => ({
  runEmbeddedAgent: vi.fn<(params: NativeRunParams) => Promise<{ payloads: [] }>>(),
}));
// mock-isolation: The plugin catalog and production model execution are outside this native read test.
vi.mock("../../plugins/runtime/index.js", () => ({ createPluginRuntime: () => ({ agent: {} }) }));
// mock-isolation: Native admission and Knowledge/storage remain real; only model execution is controlled.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.runEmbeddedAgent }));
// mock-isolation: Generated consult-input persistence is not part of this exact native context-read contract.
vi.mock("../../sessions/user-turn-transcript.js", () => ({
  buildRunUserTurnIdempotencyKey: (runId: string) => runId,
  createUserTurnTranscriptRecorder: () => undefined,
}));
import { createTalkClientAgentRuntime } from "./client-agent-runtime.js";

beforeEach(() => {
  mocks.runEmbeddedAgent.mockReset().mockResolvedValue({ payloads: [] });
});

describe("Talk personal conversation context through native SQLite", () => {
  it("reads fresh native sibling differences on each personal consult despite internal agent actors", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "talk-consult-private-actors" },
      async (state) => {
        const f = await createConversationKnowledgeScenario(state);
        try {
          const participant = { type: "profile" as const, id: "operator-alpha" };
          const call = await f.branch("personal-provider", participant);
          expect(
            await recordSessionParticipantInWorker(call, {
              identity: { type: "agent", id: "courier" },
              promptedAt: Date.now(),
              sessionAgentId: call.agentId,
              expectedSession: call,
            }),
          ).toBe("inserted");
          const sibling = await f.branch("other-input", participant);
          const siblingOwner = await f.claim(sibling);
          const authority = createAdmittedRunOperatorAuthority({
            profileId: participant.id,
            scopes: ["operator.write"],
            gatewayAccessGrant: null,
            assertCurrent: siblingOwner.assertCurrent,
          });
          const release = vi.fn();
          const runtime = createTalkClientAgentRuntime({
            config: f.cfg,
            getRuntimeConfig: () => f.cfg,
            participant,
            captureOperatorAuthority: async () => ({ authority, release }),
          });
          for (const [index, text] of ["first-live-fact", "second-live-fact"].entries()) {
            await recordConversationKnowledgeTurn({
              ...siblingOwner,
              ...(await f.append(sibling, text)),
            });
            mocks.runEmbeddedAgent.mockImplementationOnce(async (params) => {
              const fragments = params.runtimeContextFragments?.map((part) => part.text).join("\n");
              expect(fragments).toContain(`${text} answer`);
              if (index === 0) {
                expect(fragments).not.toContain("second-live-fact");
              }
              return { payloads: [] };
            });
            await runtime.runEmbeddedAgent({
              config: f.cfg,
              prompt: "Check the requested facts.",
              workspaceDir: state.statePath("workspace"),
              timeoutMs: 60_000,
              runId: `personal-consult-${index}`,
              sessionId: call.sessionId,
              sessionTarget: call,
            });
          }
          expect(mocks.runEmbeddedAgent).toHaveBeenCalledTimes(2);
          expect(release).toHaveBeenCalledTimes(2);
        } finally {
          await f.close();
        }
      },
    );
  });
});
