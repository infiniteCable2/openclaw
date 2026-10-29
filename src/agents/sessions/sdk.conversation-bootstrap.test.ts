import { describe, expect, it } from "vitest";
import { prepareNewConversationKnowledgeBootstrap } from "../../config/sessions/conversation-knowledge-checkpoint-admission.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import type { Model } from "../../llm/types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const model: Model = {
  id: "synthetic-model",
  name: "Synthetic model",
  provider: "synthetic-provider",
  api: "openai-responses",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 4_096,
};

describe("native SDK cold checkpoint eligibility", () => {
  it("admits exact initial metadata before or after the first user, but no later history", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "sdk-checkpoint-bootstrap" },
      async (state) => {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        for (const userFirst of [false, true]) {
          const branch: ConversationKnowledgeBranch = {
            agentId: "main",
            storePath: database.path,
            sessionKey: `agent:main:initial-${userFirst}`,
            sessionId: `initial-${userFirst}`,
            lifecycleRevision: `life-${userFirst}`,
            root: {
              sessionKey: "agent:main:root",
              sessionId: "root",
              lifecycleRevision: "root-life",
            },
          };
          await upsertSessionEntryCore(
            { ...branch, env: state.env },
            {
              sessionId: branch.sessionId,
              lifecycleRevision: branch.lifecycleRevision,
              updatedAt: 1,
            },
          );
          const manager = await SessionManager.openAsync(branch, state.workspaceDir);
          const user = {
            role: "user" as const,
            content: "The first synthetic request",
            timestamp: 1,
          };
          let userId = userFirst ? await manager.appendMessageAsync(user) : undefined;
          const { session } = await createAgentSession({
            systemPrompt: "Synthetic initialization only; no model invocation.",
            cwd: state.workspaceDir,
            model,
            thinkingLevel: "medium",
            tools: [],
            modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
            sessionManager: manager,
            settingsManager: SettingsManager.inMemory(),
            resourceLoader: createResourceLoader(),
          });
          try {
            userId ??= await manager.appendMessageAsync(user);
            if (!userId) {
              throw new Error("Native SDK user entry missing");
            }
            const facts = await readSessionTranscriptAnchorsAsync(
              { ...branch, env: state.env },
              { entryIds: [userId] },
            );
            const anchor = facts.anchors[0];
            if (!anchor) {
              throw new Error("Native SDK user anchor missing");
            }
            const input = {
              branch,
              env: state.env,
              source: () => {},
              admission: { ...anchor, logicalTurnId: "synthetic-turn", role: "user" as const },
            };
            const initialization = {
              provider: model.provider,
              modelId: model.id,
              thinkingLevel: session.thinkingLevel,
            };
            expect(await prepareNewConversationKnowledgeBootstrap(input)).toBeUndefined();
            expect(
              await prepareNewConversationKnowledgeBootstrap({ ...input, initialization }),
            ).toBeDefined();
            expect(
              await prepareNewConversationKnowledgeBootstrap({
                ...input,
                initialization: { ...initialization, thinkingLevel: "high" },
              }),
            ).toBeUndefined();
            if (!userFirst) {
              expect(
                await prepareNewConversationKnowledgeBootstrap({
                  ...input,
                  initialization: { ...initialization, modelId: "different-model" },
                }),
              ).toBeUndefined();
            }
            // Even identical selected metadata repeated later is not initialization.
            await manager.appendThinkingLevelChange(session.thinkingLevel);
            expect(
              await prepareNewConversationKnowledgeBootstrap({ ...input, initialization }),
            ).toBeUndefined();
          } finally {
            session.dispose();
          }
        }
      },
    );
  });
});
