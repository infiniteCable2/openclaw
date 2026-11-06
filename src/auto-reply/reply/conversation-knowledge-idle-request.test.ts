import { describe, expect, it } from "vitest";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  hasIdleConversationKnowledgeMaintenanceModelAuthority,
  resolveIdleConversationKnowledgeMaintenanceRequest,
} from "./conversation-knowledge-idle-request.js";

const branch: ConversationKnowledgeBranch = {
  agentId: "example",
  sessionKey: "agent:example:branch:idle",
  sessionId: "idle-session",
  storePath: "/virtual/example.sqlite",
  lifecycleRevision: "idle-life",
  root: {
    sessionKey: "agent:example:root",
    sessionId: "root-session",
    lifecycleRevision: "root-life",
  },
};

function fixture() {
  const config: OpenClawConfig = {
    agents: {
      entries: { example: { workspace: "/virtual/workspace", model: "example/current" } },
    },
    models: {
      providers: {
        example: {
          baseUrl: "https://model.example.invalid/v1",
          models: [
            {
              id: "current",
              name: "Current",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
  };
  const entry: InternalSessionEntry = {
    sessionId: branch.sessionId,
    lifecycleRevision: branch.lifecycleRevision,
    updatedAt: 1,
    // These are previous-run observations, not the selected maintenance model.
    modelProvider: "old",
    model: "old",
    contextTokens: 1,
  };
  return { config, entry, branch };
}

function withRole() {
  const input = fixture();
  input.config.gateway = {
    roles: {
      default: "member",
      definitions: {
        member: { sessions: { others: "none" }, agents: ["example"], scopes: ["operator.read"] },
      },
    },
  };
  input.entry.conversationRecipientEnrollment = {
    version: 1,
    lifetime: "reusable",
    branch,
    source: {
      kind: "operator",
      snapshot: {
        profileId: "synthetic-profile",
        scopes: ["operator.read"],
        assignedRole: "member",
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "",
          grantGeneration: "synthetic-generation",
          role: "operator",
          authMethod: "trusted-proxy",
        },
        controlUiAdmin: false,
        localOperator: false,
        sourceIngress: "internal",
      },
    },
  };
  return input;
}

describe("idle maintenance request placement", () => {
  it("uses current configured model and a separate tool-free conversation-scoped request", () => {
    const input = fixture();
    const request = resolveIdleConversationKnowledgeMaintenanceRequest(input);
    expect(request).toMatchObject({
      config: input.config,
      provider: "example",
      model: "current",
      sessionTarget: branch,
      disableTools: true,
      modelFallbacksOverride: [],
    });
    expect(request?.contextTokenBudget).toBeUndefined();
    expect(request?.budgetPreflight).toBeUndefined();
    expect(request?.resolvedApiKey).toBeUndefined();
    expect(request?.runtimeAuthPlan).toBeUndefined();
    expect(request?.memoryAudience).toBeUndefined();
    expect(request?.extraSystemPrompt).toBeUndefined();
  });

  it("does not exclude a role that only limits source/session scopes", () => {
    const input = withRole();
    expect(hasIdleConversationKnowledgeMaintenanceModelAuthority(input)).toBe(true);
    expect(resolveIdleConversationKnowledgeMaintenanceRequest(input)).toBeDefined();
  });

  it("defers a current model ceiling rather than restoring a previous unrestricted model", () => {
    const input = withRole();
    input.config.gateway!.roles!.definitions.member.modelPolicy = { allow: ["example/current"] };
    expect(hasIdleConversationKnowledgeMaintenanceModelAuthority(input)).toBe(false);
    expect(resolveIdleConversationKnowledgeMaintenanceRequest(input)).toBeUndefined();
  });

  it("shares the required-sandbox refusal with warm maintenance", () => {
    const input = withRole();
    input.config.gateway!.roles!.definitions.member.sandbox = "required";
    expect(hasIdleConversationKnowledgeMaintenanceModelAuthority(input)).toBe(false);
    expect(resolveIdleConversationKnowledgeMaintenanceRequest(input)).toBeUndefined();
  });

  it("does not use another incarnation's role provenance", () => {
    const input = withRole();
    input.entry.conversationRecipientEnrollment = {
      ...input.entry.conversationRecipientEnrollment!,
      branch: { ...branch, lifecycleRevision: "other-life" },
    };
    expect(hasIdleConversationKnowledgeMaintenanceModelAuthority(input)).toBe(false);
    expect(resolveIdleConversationKnowledgeMaintenanceRequest(input)).toBeUndefined();
  });

  it.each<Partial<InternalSessionEntry>>([
    { lifecycleRevision: "other-life" },
    { archivedAt: 0 },
    { incognito: true },
    { authProfileOverride: "personal-auth", authProfileOverrideSource: "user-link" },
    { repositoryWorkspaceId: "repository" },
    { sessionRoot: "/virtual/other-root" },
    { spawnedCwd: "/virtual/task" },
    { sandbox: "required" },
    { execNode: "remote-node" },
    { pluginOwnerId: "runtime-plugin" },
  ])("defers unsupported or stale placement %j", (patch) => {
    const input = fixture();
    Object.assign(input.entry, patch);
    expect(resolveIdleConversationKnowledgeMaintenanceRequest(input)).toBeUndefined();
  });

  it("does not guess a model omitted from current provider declarations", () => {
    const input = fixture();
    input.config.models = undefined;
    expect(resolveIdleConversationKnowledgeMaintenanceRequest(input)).toBeUndefined();
  });

  it("does not fall back to Gateway placement when a worker is required", () => {
    const input = fixture();
    input.config.cloudWorkers = { requiredProfile: "required-worker" };
    expect(resolveIdleConversationKnowledgeMaintenanceRequest(input)).toBeUndefined();
  });
});
