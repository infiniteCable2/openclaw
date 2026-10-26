import { expect, it } from "vitest";
import { selectConversationKnowledgeObserved } from "./conversation-knowledge-selection.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_UTTERANCE_REPORT,
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReceipt,
} from "./conversation-knowledge.js";

function receipt(label: string): ConversationKnowledgeReceipt {
  const source = {
    agentId: "researcher",
    sessionKey: `agent:researcher:example:${label}`,
    sessionId: `session-${label}`,
    lifecycleRevision: "original",
  };
  return {
    version: 1,
    sourceMode: "branches",
    source,
    origin: conversationKnowledgeOrigin(source),
    runId: `run-${label}`,
    through: {
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      sessionId: source.sessionId,
      storePath: "/synthetic/agent.sqlite",
      generation: "original",
      entryId: "answer",
      rawSeq: 4,
      activeMessagePosition: 2,
      effectiveParentId: "question",
    },
  };
}

it("selects observed progress only from the current origin's latest completed receipt", () => {
  const current = receipt("current");
  const other = receipt("other");
  const observed = [
    {
      origin: other.origin,
      generation: other.through.generation,
      throughRawSeq: other.through.rawSeq,
      throughEntryId: other.through.entryId,
    },
  ];
  const report = (details: unknown) => ({
    type: "custom_message",
    customType: CONVERSATION_KNOWLEDGE_REPORT,
    details,
  });
  const events = [
    report({ ...current, observed }),
    report({ ...other, observed: [] }),
    { type: "message", details: current },
    { ...report(current), customType: CONVERSATION_UTTERANCE_REPORT },
  ];
  expect(selectConversationKnowledgeObserved(events, current.source)).toEqual(observed);
  expect(selectConversationKnowledgeObserved(events, receipt("missing").source)).toEqual([]);
  // Absence on a later valid completion resets its observed snapshot rather than
  // borrowing stale progress from an older completed turn.
  expect(selectConversationKnowledgeObserved([...events, report(current)], current.source)).toEqual(
    [],
  );
  expect(
    selectConversationKnowledgeObserved(
      [...events, report({ ...current, observed: [] })],
      current.source,
    ),
  ).toEqual([]);
});

it("keeps original assistant observation progress without borrowing a user's or a voice-only report", () => {
  const current = receipt("current");
  const other = receipt("other");
  const observed = [
    {
      origin: other.origin,
      generation: other.through.generation,
      throughRawSeq: other.through.rawSeq,
      throughEntryId: other.through.entryId,
    },
  ];
  const { runId: _runId, ...base } = current;
  const observation = {
    ...base,
    origin: conversationKnowledgeOrigin(base.source, "utterance-observation"),
    kind: "utterance-observation",
    role: "assistant",
    observed,
  };
  const report = (details: unknown) => ({
    type: "custom_message",
    customType: CONVERSATION_UTTERANCE_REPORT,
    details,
  });
  const events = [report(observation), report({ ...observation, role: "user", observed: [] })];
  expect(selectConversationKnowledgeObserved(events, current.source)).toEqual(observed);
  const { observed: _observed, ...voice } = observation;
  expect(selectConversationKnowledgeObserved([...events, report(voice)], current.source)).toEqual(
    observed,
  );
  expect(
    selectConversationKnowledgeObserved(
      [...events, report({ ...observation, observed: [] })],
      current.source,
    ),
  ).toEqual([]);
});
