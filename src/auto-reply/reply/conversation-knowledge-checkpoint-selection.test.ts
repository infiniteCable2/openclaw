import { expect, it, onTestFinished, vi } from "vitest";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import { conversationKnowledgeOrigin } from "../../config/sessions/conversation-knowledge.js";
import { prepareRecipientConversationProjection } from "./conversation-knowledge-checkpoint-recipient.js";
import { createConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";
import type { ReplyConversationKnowledgeParams } from "./conversation-knowledge.types.js";

const native = vi.hoisted(() => ({
  target: vi.fn(),
  inputs: vi.fn(),
  publish: vi.fn(),
  rebind: vi.fn(),
  group: vi.fn(),
}));
// mock-isolation: Count orchestration checks; existing native scenarios prove source custody.
vi.mock("./conversation-knowledge-source-reader.js", () => ({
  prepareConversationKnowledgeTarget: native.target,
  readConversationKnowledgeInputs: native.inputs,
  publishPreparedConversationKnowledgeRoot: native.publish,
}));
// mock-isolation: Consumed originals need no new donor grant or native root scan.
vi.mock("../../config/sessions/conversation-knowledge-store.js", () => ({
  readPreparedConversationKnowledgeRoot: native.rebind,
}));
vi.mock("../../gateway/session-transcript-personal-read.js", () => ({
  preparePersonalConversationContributionGroup: native.group,
}));

it("does not multiply live authority checks by already consumed receipts", async () => {
  const person = { type: "profile", id: "example-person" } as const;
  const branch = {
    agentId: "example",
    storePath: "/synthetic/agent.sqlite",
    sessionKey: "agent:example:recipient",
    sessionId: "recipient",
    lifecycleRevision: "recipient-life",
    root: { sessionKey: "agent:example:root", sessionId: "root", lifecycleRevision: "root-life" },
  };
  const source = { ...branch, sessionKey: "agent:example:donor", sessionId: "donor" };
  const checks: number[] = [];
  for (const size of [0, 4, 64]) {
    const references = Array.from({ length: size }, (_, index) => {
      const through = {
        agentId: source.agentId,
        sessionKey: source.sessionKey,
        sessionId: source.sessionId,
        storePath: branch.storePath,
        generation: "generation",
        rawSeq: index + 1,
        entryId: `entry-${index}`,
        activeMessagePosition: index + 1,
        effectiveParentId: null,
      };
      return {
        version: 1 as const,
        sourceMode: "branches" as const,
        source,
        through,
        origin: conversationKnowledgeOrigin(source, "utterance-observation"),
        kind: "utterance-observation" as const,
        role: "user" as const,
        privateAudience: { participant: person, admission: through },
      };
    });
    const events = Object.assign(
      references.map((details) => ({
        type: "custom_message",
        customType: "openclaw.conversation-utterance.v1",
        details,
      })),
      { evidence: {} },
    );
    native.target.mockResolvedValue({
      kind: "ready",
      branch,
      targetFacts: { assertCurrent() {}, release() {} },
    });
    native.inputs.mockResolvedValue({
      events,
      retained: new Map(
        references.map((value) => [conversationKnowledgeContributionId(value), { complete: true }]),
      ),
    });
    native.publish.mockReturnValue({});
    native.rebind.mockResolvedValue({ evidence: {} });
    const cache = createConversationKnowledgeSourceCache();
    onTestFinished(() => cache.clear());
    const assertCurrent = vi.fn();
    const params = {
      originalParticipant: person,
      expectedAudienceIdentity: conversationKnowledgeParticipantIdentity(person),
      sourceCache: cache,
      assertCurrent,
    } as unknown as ReplyConversationKnowledgeParams;
    expect(await prepareRecipientConversationProjection(params, [])).toBe(true);
    expect(native.publish.mock.lastCall?.[0].receipts).toHaveLength(size);
    checks.push(assertCurrent.mock.calls.length);
  }
  expect(checks[0]).toBe(2);
  expect(checks[1]).toBeGreaterThan(0);
  expect(checks[2]).toBe(checks[1]);
  expect(native.group).not.toHaveBeenCalled();
});
