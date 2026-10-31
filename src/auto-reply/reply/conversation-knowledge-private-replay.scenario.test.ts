import "../../test-utils/prepare-compiled-subprocesses.js";
import { readFile } from "node:fs/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { createConversationContextCapacity } from "../../agents/embedded-agent-runner/run/prepared-conversation-context.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { CONVERSATION_KNOWLEDGE_CONTEXT } from "../../config/sessions/conversation-knowledge-packets.js";
import {
  readConversationKnowledgeBranch,
  recordConversationKnowledgeTurn,
  recordConversationUtteranceObservation,
} from "../../config/sessions/conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_UTTERANCE_REPORT,
} from "../../config/sessions/conversation-knowledge.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { isReadableSessionMessage } from "../../config/sessions/session-entry-codec.js";
import { recordSessionParticipantInWorker } from "../../config/sessions/session-sharing-store.async.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureClientVoiceAgentSessionEntry } from "../../talk/client-voice-session-initialization.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareConversationKnowledgeBranchFacts } from "./conversation-knowledge-authority.js";
import { createConversationKnowledgeBoundaryProfiler } from "./conversation-knowledge-boundary-profile.test-support.js";
import { registerConversationKnowledgeCheckpointOwner } from "./conversation-knowledge-checkpoint-owner.js";
import { openConversationKnowledgeRecipient } from "./conversation-knowledge-open.js";
import { prepareConversationKnowledgeRecipient } from "./conversation-knowledge-prefetch.js";
import { createReplyConversationKnowledgeTurn } from "./conversation-knowledge-turn.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";
import { lifecycleAdmissionByOperation } from "./reply-run-registry.state.js";
import { createMockFollowupRun, createMockReplyOperation } from "./test-helpers.js";

const planning = vi.hoisted(() => ({ summarize: vi.fn(), compact: vi.fn() }));
// mock-isolation: Only model execution is replaced; all SQLite, sharing facts,
// native grants, publications, root projection and recipient owners remain real.
vi.mock("./conversation-knowledge-checkpoint-model.js", () => ({
  acquireConversationKnowledgeCheckpointModel: async () => ({
    planning: {
      budget: { contextTokenBudget: 1_000_000, prompt: "" },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 16_384 },
    },
    summarize: planning.summarize,
    async [Symbol.asyncDispose]() {},
  }),
}));
// mock-isolation: A private replay must not call a production model for compaction.
vi.mock("../../agents/embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: planning.compact,
}));

type Replay = {
  version: 1;
  references: Array<{
    source: string;
    role: "user" | "assistant";
    text: string;
    at: number;
    ordinal: number;
    runAlias?: string;
  }>;
  sources: Array<{ alias: string; chatType: "direct" | "group" | "channel" }>;
  receipts?: Array<{
    rootOrdinal: number;
    source: string;
    kind: "completed" | "utterance";
    sourceMode: "native" | "branches";
    admissionOrdinal: number;
    throughOrdinal: number;
    messageOrdinals: number[];
    runAlias?: string;
    omittedNonText: number;
  }>;
};

async function readReplay(file: string): Promise<Replay> {
  const bytes = await readFile(file);
  if (bytes.length > 32 * 1024 * 1024) {
    throw new Error("Private replay exceeds approved bound");
  }
  const value = asOptionalRecord(JSON.parse(bytes.toString("utf8")));
  if (value?.version !== 1 || !Array.isArray(value.references) || !Array.isArray(value.sources)) {
    throw new Error("Private replay contract unavailable");
  }
  const sources = value.sources.map((raw): Replay["sources"][number] => {
    const row = asOptionalRecord(raw);
    if (
      typeof row?.alias !== "string" ||
      (row.chatType !== "direct" && row.chatType !== "group" && row.chatType !== "channel")
    ) {
      throw new Error("Private replay source contract invalid");
    }
    return { alias: row.alias, chatType: row.chatType };
  });
  const aliases = new Set(sources.map((source) => source.alias));
  const references = value.references.map((raw): Replay["references"][number] => {
    const row = asOptionalRecord(raw);
    if (
      typeof row?.source !== "string" ||
      !aliases.has(row.source) ||
      (row.role !== "user" && row.role !== "assistant") ||
      typeof row.text !== "string" ||
      typeof row.at !== "number" ||
      typeof row.ordinal !== "number"
    ) {
      throw new Error("Private replay reference contract invalid");
    }
    if (row.runAlias !== undefined && typeof row.runAlias !== "string") {
      throw new Error("Private replay run alias invalid");
    }
    return {
      source: row.source,
      role: row.role,
      text: row.text,
      at: row.at,
      ordinal: row.ordinal,
      runAlias: row.runAlias,
    };
  });
  if (
    aliases.size !== sources.length ||
    !references.length ||
    references.length > 5000 ||
    new Set(references.map((row) => row.ordinal)).size !== references.length
  ) {
    throw new Error("Private replay sequence contract invalid");
  }
  const messages = new Map(references.map((row) => [row.ordinal, row]));
  const receipts =
    value.receipts === undefined
      ? undefined
      : Array.isArray(value.receipts)
        ? value.receipts.map((raw): NonNullable<Replay["receipts"]>[number] => {
            const row = asOptionalRecord(raw);
            if (
              !row ||
              typeof row.source !== "string" ||
              !aliases.has(row.source) ||
              (row.kind !== "completed" && row.kind !== "utterance") ||
              (row.sourceMode !== "native" && row.sourceMode !== "branches") ||
              !Number.isSafeInteger(row.rootOrdinal) ||
              typeof row.rootOrdinal !== "number" ||
              typeof row.admissionOrdinal !== "number" ||
              typeof row.throughOrdinal !== "number" ||
              !Array.isArray(row.messageOrdinals) ||
              typeof row.omittedNonText !== "number" ||
              !Number.isSafeInteger(row.omittedNonText) ||
              row.omittedNonText < 0 ||
              (row.runAlias !== undefined && typeof row.runAlias !== "string")
            ) {
              throw new Error("Private replay receipt contract invalid");
            }
            const messageOrdinals = row.messageOrdinals.map((ordinal) => {
              if (typeof ordinal !== "number" || messages.get(ordinal)?.source !== row.source) {
                throw new Error("Private replay receipt message unavailable");
              }
              return ordinal;
            });
            const admission = messages.get(row.admissionOrdinal);
            const through = messages.get(row.throughOrdinal);
            if (
              admission?.source !== row.source ||
              through?.source !== row.source ||
              !messageOrdinals.includes(row.throughOrdinal) ||
              (row.kind === "completed" &&
                (admission.role !== "user" || through.role !== "assistant"))
            ) {
              throw new Error("Private replay receipt boundary invalid");
            }
            return {
              rootOrdinal: row.rootOrdinal,
              source: row.source,
              kind: row.kind,
              sourceMode: row.sourceMode,
              admissionOrdinal: row.admissionOrdinal,
              throughOrdinal: row.throughOrdinal,
              messageOrdinals,
              omittedNonText: row.omittedNonText,
              runAlias: row.runAlias,
            };
          })
        : (() => {
            throw new Error("Private replay receipts invalid");
          })();
  if (
    receipts &&
    (!receipts.length || new Set(receipts.map((row) => row.rootOrdinal)).size !== receipts.length)
  ) {
    throw new Error("Private replay receipt sequence invalid");
  }
  return { version: 1, sources, references, ...(receipts ? { receipts } : {}) };
}

const replayPath = process.env.OPENCLAW_PRIVATE_BRANCH_REPLAY;
it.skipIf(!replayPath)(
  "replays approved private root history without exposing original payloads",
  async ({ signal }) => {
    const replay = await readReplay(replayPath!);
    const contextWindow = Number(
      process.env.OPENCLAW_PRIVATE_BRANCH_REPLAY_CONTEXT_WINDOW ?? 1_000_000,
    );
    const recipientSource = process.env.OPENCLAW_PRIVATE_BRANCH_REPLAY_RECIPIENT_SOURCE;
    const nativeCreation = process.env.OPENCLAW_PRIVATE_BRANCH_REPLAY_NATIVE_CREATION === "1";
    const recipientMode = recipientSource
      ? "reused-source"
      : nativeCreation
        ? "native-creation"
        : "fresh";
    if (nativeCreation && recipientSource) {
      throw new Error("Native creation cannot replace an existing replay source");
    }
    const metadataChanges = process.env.OPENCLAW_PRIVATE_BRANCH_REPLAY_METADATA_CHANGES !== "off";
    const boundaryProfile = createConversationKnowledgeBoundaryProfiler();
    const initialIdleProfile = createConversationKnowledgeBoundaryProfiler();
    expect(Number.isSafeInteger(contextWindow) && contextWindow > 20_000).toBe(true);
    const started = performance.now();
    const cpu = process.cpuUsage();
    const stages: Array<Record<string, string | number | boolean>> = [];
    const mark = (phase: string, facts: Record<string, string | number | boolean> = {}) =>
      stages.push({ phase, elapsedMs: Math.round(performance.now() - started), ...facts });
    const classify = (fn: () => void) => {
      try {
        fn();
        return "current";
      } catch (error) {
        return error instanceof Error && error.name === "SessionMutationFactsUnavailableError"
          ? "facts-unavailable"
          : "refused";
      }
    };
    try {
      await withOpenClawTestState(
        { scenario: "minimal", label: "private-root-replay" },
        async (state) => {
          const fixture = await createConversationKnowledgeScenario(state);
          fixture.cfg.agents!.defaults = { model: { primary: "synthetic/replay-model" } };
          fixture.cfg.models = {
            providers: {
              synthetic: {
                baseUrl: "https://model.example.invalid",
                api: "openai-completions",
                models: [
                  {
                    id: "replay-model",
                    name: "Private replay planning only",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow,
                    maxTokens: 16_384,
                  },
                ],
              },
            },
          };
          await state.writeConfig(fixture.cfg);
          const cleanup: Array<() => void | Promise<void>> = [() => fixture.close()];
          const failures: unknown[] = [];
          try {
            const donors = new Map<
              string,
              {
                target: Awaited<ReturnType<typeof fixture.branch>>;
                owner: Awaited<ReturnType<typeof fixture.claim>>;
              }
            >();
            for (const [index, source] of replay.sources.entries()) {
              const target = await fixture.branch(`replay-donor-${index}`, person, source.chatType);
              donors.set(source.alias, { target, owner: await fixture.claim(target) });
            }
            const runs = new Map<number, string>();
            for (const receipt of replay.receipts ?? []) {
              if (receipt.kind !== "completed") {
                continue;
              }
              const alias = receipt.runAlias ?? `replay-completed-${receipt.rootOrdinal}`;
              for (const ordinal of receipt.messageOrdinals) {
                const message = replay.references.find((row) => row.ordinal === ordinal);
                if (message?.role !== "assistant") {
                  continue;
                }
                const run = message.runAlias ?? alias;
                if (runs.has(ordinal) && runs.get(ordinal) !== run) {
                  throw new Error("Private replay run grouping conflicts");
                }
                runs.set(ordinal, run);
              }
              if (runs.get(receipt.throughOrdinal) !== alias) {
                throw new Error("Private replay terminal run mismatch");
              }
            }
            const anchors = new Map<number, TranscriptEntryAnchor>();
            for (const reference of replay.references) {
              signal.throwIfAborted();
              const donor = donors.get(reference.source)!;
              const saved = await appendTranscriptMessage(donor.target, {
                message:
                  reference.role === "user"
                    ? { role: "user", content: reference.text, timestamp: reference.at }
                    : {
                        role: "assistant",
                        content: [{ type: "text", text: reference.text }],
                        timestamp: reference.at,
                        stopReason: "stop",
                        ...((reference.runAlias ??
                        runs.get(reference.ordinal) ??
                        (!replay.receipts ? `replay-${reference.ordinal}` : undefined))
                          ? {
                              __openclaw: {
                                runId:
                                  reference.runAlias ??
                                  runs.get(reference.ordinal) ??
                                  `replay-${reference.ordinal}`,
                              },
                            }
                          : {}),
                      },
              });
              if (!saved.anchor) {
                throw new Error("Private replay native source anchor unavailable");
              }
              anchors.set(reference.ordinal, saved.anchor);
              if (replay.receipts) {
                continue;
              }
              expect(
                await recordConversationUtteranceObservation({
                  ...donor.owner,
                  anchor: saved.anchor,
                  role: reference.role,
                  privateAudience: { participant: person, admission: saved.anchor },
                }),
              ).toBe(true);
            }
            for (const receipt of (replay.receipts ?? []).toSorted(
              (a, b) => a.rootOrdinal - b.rootOrdinal,
            )) {
              signal.throwIfAborted();
              const donor = donors.get(receipt.source)!;
              const admission = anchors.get(receipt.admissionOrdinal);
              const through = anchors.get(receipt.throughOrdinal);
              if (!admission || !through) {
                throw new Error("Private replay receipt anchors unavailable");
              }
              const shared = {
                ...donor.owner,
                sourceMode: receipt.sourceMode,
                privateAudience: { participant: person, admission },
              };
              const accepted =
                receipt.kind === "completed"
                  ? await recordConversationKnowledgeTurn({
                      ...shared,
                      runId: receipt.runAlias ?? `replay-completed-${receipt.rootOrdinal}`,
                      assistantTranscriptEntryId: through.entryId,
                    })
                  : await recordConversationUtteranceObservation({
                      ...shared,
                      anchor: through,
                      role: replay.references.find((row) => row.ordinal === receipt.throughOrdinal)!
                        .role,
                    });
              expect(accepted).toBe(true);
            }
            const rootReceipts = (await loadTranscriptEvents(fixture.root)).filter((raw) => {
              const type = asOptionalRecord(raw)?.customType;
              return (
                type === CONVERSATION_KNOWLEDGE_REPORT || type === CONVERSATION_UTTERANCE_REPORT
              );
            }).length;
            mark("real-originals-published", {
              sources: donors.size,
              originals: replay.references.length,
              rootReceipts,
              requestedReceipts: replay.receipts?.length ?? replay.references.length,
              groupedReceipts: Boolean(replay.receipts),
              omittedStructuralEvents:
                replay.receipts?.reduce((total, row) => total + row.omittedNonText, 0) ?? 0,
            });
            const keeper = await fixture.branch("private-replay-root-broker");
            const keeperOwner = await fixture.claim(keeper);
            const keeperBranch = await readConversationKnowledgeBranch(keeperOwner);
            if (!keeperBranch) {
              throw new Error("Private replay native broker enrollment unavailable");
            }
            const ready = createDeferredCore();
            const idleRootReady = createDeferredCore();
            const idleUpdate: { entryId?: string } = {};
            const checkpoint = registerConversationKnowledgeCheckpointOwner({
              branch: keeperBranch,
              participant: person,
              audience: {
                agentId: keeper.agentId,
                sessionKey: keeper.sessionKey,
                channelId: "test",
                accountId: "default",
                nativeChannelId: "private-replay-root-broker",
                participant: person,
                assertCurrent: keeperOwner.assertCurrent,
              },
              env: state.env,
              getRuntimeConfig: () => fixture.cfg,
              onReady() {
                if (checkpoint.projection().tail.length === rootReceipts) {
                  ready.resolve();
                }
                if (
                  idleUpdate.entryId &&
                  checkpoint
                    .projection()
                    .tail.some(({ reference }) => reference.through.entryId === idleUpdate.entryId)
                ) {
                  idleRootReady.resolve();
                }
              },
            });
            cleanup.push(() => checkpoint.close());
            await withinTest(ready.promise, signal);
            mark("shared-root-prepared", { prepared: checkpoint.projection().tail.length });
            const reused = recipientSource ? donors.get(recipientSource) : undefined;
            if (recipientSource && !reused) {
              throw new Error("Private replay recipient source unavailable");
            }
            const target =
              reused?.target ??
              (nativeCreation
                ? await (async () => {
                    const absent = {
                      ...fixture.root,
                      sessionKey: "agent:main:private-replay-created",
                    };
                    const createAt = performance.now();
                    const sessionId = await ensureClientVoiceAgentSessionEntry({
                      ...absent,
                      cfg: fixture.cfg,
                      getRuntimeConfig: () => fixture.cfg,
                      chatType: "direct",
                      privateAudience: {
                        agentId: absent.agentId,
                        sessionKey: absent.sessionKey,
                        channelId: "test",
                        accountId: "default",
                        nativeChannelId: "private-replay-created",
                        participant: person,
                        assertCurrent: () => signal.throwIfAborted(),
                      },
                      assertCommitAllowed: () => signal.throwIfAborted(),
                    });
                    const entry = loadSessionEntry(absent);
                    if (!entry?.lifecycleRevision || entry.sessionId !== sessionId) {
                      throw new Error("Native replay creation was not published");
                    }
                    const selected = {
                      ...absent,
                      sessionId,
                      lifecycleRevision: entry.lifecycleRevision,
                    };
                    const installed = (await loadTranscriptEvents(selected)).filter(
                      (raw) => asOptionalRecord(raw)?.customType === CONVERSATION_KNOWLEDGE_CONTEXT,
                    ).length;
                    mark("native-creation-before-first-input", {
                      creationMs: Math.round(performance.now() - createAt),
                      installedPackets: installed,
                      requestedPackets: rootReceipts,
                    });
                    expect(installed).toBe(rootReceipts);
                    expect(entry.forkSource).toBeUndefined();
                    return selected;
                  })()
                : await fixture.branch("private-replay-recipient"));
            const owner = reused?.owner ?? (await fixture.claim(target));
            const native = await prepareSessionMutationFacts({
              cfg: fixture.cfg,
              agentId: target.agentId,
              sessionKey: target.sessionKey,
            });
            cleanup.push(() => native.release());
            const audience: ConversationPrivateAudience = {
              agentId: target.agentId,
              sessionKey: target.sessionKey,
              channelId: "test",
              accountId: "default",
              nativeChannelId: "private-replay-recipient",
              participant: person,
              assertCurrent() {
                owner.assertCurrent();
                const current = native.readCurrent(fixture.cfg).target;
                if (
                  current.entry.sessionId !== target.sessionId ||
                  current.entry.lifecycleRevision !== target.lifecycleRevision
                ) {
                  throw new Error("Private replay native recipient changed");
                }
              },
            };
            await openConversationKnowledgeRecipient({
              target,
              participant: person,
              audience,
              getRuntimeConfig: () => fixture.cfg,
              env: state.env,
              signal,
            });
            const branch = await readConversationKnowledgeBranch(owner);
            if (!branch) {
              throw new Error("Private replay native recipient enrollment unavailable");
            }
            const recipient = prepareConversationKnowledgeRecipient({
              branch,
              participant: person,
              audience,
              env: state.env,
              getRuntimeConfig: () => fixture.cfg,
            });
            if (!recipient) {
              throw new Error("Private replay recipient owner unavailable");
            }
            cleanup.push(() => recipient.owner.close());
            const packets = async () =>
              (await loadTranscriptEvents(target)).flatMap((raw) => {
                const row = asOptionalRecord(raw);
                const details = asOptionalRecord(row?.details);
                return row?.customType === CONVERSATION_KNOWLEDGE_CONTEXT &&
                  typeof details?.contributionId === "string"
                  ? [details.contributionId]
                  : [];
              });
            await withinTest(recipient.owner.wait(), signal);
            mark("connection-open-before-first-input", {
              prepared: recipient.cache.diagnosticCapacity().preparedPackets,
              admitted: (await packets()).length,
            });

            const facts = await prepareConversationKnowledgeBranchFacts({
              branch,
              getRuntimeConfig: () => fixture.cfg,
              destinationAudience: audience,
            });
            cleanup.push(() => facts.release());
            await upsertSessionEntryCore(target, {
              ...loadSessionEntry(target)!,
              activeWriterRunId: "private-replay-writer",
            });
            mark("native-runtime-row-change", {
              nativeSharing: classify(() => native.readCurrent(fixture.cfg)),
              branchAuthority: classify(facts.assertCurrent),
            });
            if (metadataChanges) {
              await recordSessionParticipantInWorker(target, {
                identity: { type: "agent", id: "synthetic-helper" },
                promptedAt: Date.now(),
                sessionAgentId: target.agentId,
                expectedSession: target,
              });
              mark("native-agent-actor-change", {
                nativeSharing: classify(() => native.readCurrent(fixture.cfg)),
                branchAuthority: classify(facts.assertCurrent),
              });
              await upsertSessionEntryCore(target, {
                ...loadSessionEntry(target)!,
                delivery: { kind: "internal" },
              });
              mark("native-delivery-row-change", {
                nativeSharing: classify(() => native.readCurrent(fixture.cfg)),
                branchAuthority: classify(facts.assertCurrent),
              });
            }
            facts.release();

            const nativeTarget = await resolveAgentRunSessionTarget({
              ...target,
              sessionTarget: target,
              config: fixture.cfg,
              missingSessionKey: "resolve-existing",
            });
            const runId = "private-replay-writer";
            const writer = {
              ...nativeTarget,
              expectedLifecycleRevision: target.lifecycleRevision,
              expectedWriterRunId: runId,
            };
            const { replyOperation } = createMockReplyOperation({
              key: target.sessionKey,
              sessionId: target.sessionId,
            });
            lifecycleAdmissionByOperation.set(replyOperation, { reader: owner.reader });
            cleanup.push(() => {
              lifecycleAdmissionByOperation.delete(replyOperation);
            });
            const followupRun = createMockFollowupRun({
              conversationParticipant: person,
              conversationAudience: audience,
              run: {
                ...nativeTarget,
                config: fixture.cfg,
                provider: "synthetic",
                model: "replay-model",
              },
            });
            const admission = prepareAgentRunAdmission({
              cfg: fixture.cfg,
              operationalRunInstance: createOperationalRunInstanceRef(runId),
              assertSourceCurrent: owner.assertCurrent,
              facts: {
                runId,
                agentId: target.agentId,
                ingress: { kind: "channel", boundary: "private-replay", state: "present" },
              },
            });
            cleanup.push(() => admission.close());
            const knowledge = createReplyConversationKnowledgeTurn({
              turn: { isHeartbeat: false, followupRun, replyOperation },
              originalSource: owner.assertCurrent,
              getRuntimeConfig: () => fixture.cfg,
            });
            if (!knowledge) {
              throw new Error("Private replay native turn unavailable");
            }
            cleanup.push(() => knowledge.release());
            await knowledge.prepare(admission, signal);
            await withSessionTranscriptWriteAssertion(writer, owner.assertCurrent, () =>
              knowledge.prepareHistory({
                ...followupRun.run,
                runId,
                prompt: "Recall the approved conversation history.",
                sessionTarget: writer,
                contextTokenBudget: contextWindow,
              }),
            );
            let unreadableNativeMessages = 0;
            const nativeMessages = (await loadTranscriptEvents(target)).flatMap((raw) => {
              const row = asOptionalRecord(raw);
              const message = asOptionalRecord(row?.message);
              if (
                row?.type !== "message" ||
                !message ||
                (message.role !== "user" && message.role !== "assistant")
              ) {
                return [];
              }
              if (!isReadableSessionMessage(message)) {
                unreadableNativeMessages++;
                return [];
              }
              return [message];
            });
            mark("native-recipient-footprint", {
              recipientMode,
              nativeMessages: nativeMessages.length,
              unreadableNativeMessages,
              systemAndToolsFootprintCaptured: false,
            });
            if (unreadableNativeMessages) {
              throw new Error("Private replay native context footprint unavailable");
            }
            mark("before-first-native-model-boundary", {
              ...recipient.cache.diagnosticCapacity(),
              sharedProjectionPackets: checkpoint.projection().tail.length,
              recipientProjectionPackets: recipient.checkpoint.projection().tail.length,
            });
            const boundaryAt = performance.now();
            const boundary = await boundaryProfile.measure(target.sessionId, () =>
              withSessionTranscriptWriteAssertion(writer, owner.assertCurrent, () =>
                knowledge.refreshPrepared({
                  signal,
                  canAdmit: createConversationContextCapacity({
                    messages: nativeMessages,
                    contextWindow,
                    reserveTokens: 16_384,
                    modelIdentity: { provider: "synthetic", model: "replay-model" },
                  }),
                }),
              ),
            );
            mark("first-native-model-boundary", {
              boundaryMs: Math.round(performance.now() - boundaryAt),
              returnedPackets: boundary.length,
              retainedPackets: (await packets()).length,
            });
            if (nativeCreation) {
              expect(boundary).toHaveLength(0);
              expect(await packets()).toHaveLength(rootReceipts);
            }
            knowledge.release();
            admission.close();
            lifecycleAdmissionByOperation.delete(replyOperation);
            // This diagnostic has an admitted native boundary, not an actual
            // embedded execution owner. Closing admission settles its fixture work;
            // the persisted writer ID remains the native CAS fence.
            const initialIdleAt = performance.now();
            await initialIdleProfile.measure(target.sessionId, () =>
              withinTest(recipient.owner.wait(), signal),
            );
            mark("initial-idle-backlog-settled", {
              idleWaitMs: Math.round(performance.now() - initialIdleAt),
              retainedPackets: (await packets()).length,
              ...recipient.cache.diagnosticCapacity(),
              sharedProjectionPackets: checkpoint.projection().tail.length,
              recipientProjectionPackets: recipient.checkpoint.projection().tail.length,
            });
            const before = new Set(await packets());
            const donor = [...donors.values()].find(
              (candidate) => candidate.target.sessionId !== target.sessionId,
            );
            if (!donor) {
              throw new Error("Private replay donor unavailable");
            }
            const idleAt = performance.now();
            const added = await appendTranscriptMessage(donor.target, {
              message: {
                role: "user",
                content: "Synthetic source-only idle update.",
                timestamp: Date.now(),
              },
            });
            if (!added.anchor) {
              throw new Error("Private replay idle source anchor unavailable");
            }
            idleUpdate.entryId = added.anchor.entryId;
            expect(
              await recordConversationUtteranceObservation({
                ...donor.owner,
                anchor: added.anchor,
                role: "user",
                privateAudience: { participant: person, admission: added.anchor },
              }),
            ).toBe(true);
            // The donor COMMIT can precede the shared root callback. A settled
            // recipient owner alone does not prove that this publication arrived.
            await withinTest(idleRootReady.promise, signal);
            await withinTest(recipient.owner.wait(), signal);
            const after = await packets();
            mark("source-only-idle-update", {
              elapsedSincePublicationMs: Math.round(performance.now() - idleAt),
              admittedDelta: after.filter((id) => !before.has(id)).length,
              retainedUnique: new Set(after).size,
              duplicatePackets: after.length - new Set(after).size,
              nativeSharing: classify(() => native.readCurrent(fixture.cfg)),
            });
            expect(after.length - new Set(after).size).toBe(0);
          } catch (error) {
            failures.push(error);
          } finally {
            for (const release of cleanup.toReversed()) {
              try {
                await release();
              } catch (error) {
                failures.push(error);
              }
            }
          }
          if (failures.length === 1) {
            throw failures[0];
          }
          if (failures.length > 1) {
            throw new AggregateError(failures, "Private replay or native cleanup failed", {
              cause: failures[0],
            });
          }
        },
      );
    } finally {
      console.info(
        JSON.stringify({
          scenario: "private-root-replay",
          originals: replay.references.length,
          sources: replay.sources.length,
          groupedReceipts: Boolean(replay.receipts),
          requestedRootReceipts: replay.receipts?.length ?? replay.references.length,
          recipientMode,
          metadataChanges,
          embeddedExecutionOwnerUsed: false,
          contextWindow,
          stages,
          elapsedMs: Math.round(performance.now() - started),
          cpuMicroseconds: process.cpuUsage(cpu),
          processLifetimePeakRssKiB: process.resourceUsage().maxRSS,
          firstBoundaryTimings: boundaryProfile.snapshot(),
          initialIdleTimings: initialIdleProfile.snapshot(),
          timingMeaning:
            "Pass-through asynchronous phase windows include nested/background work; durations overlap, are not additive and are not CPU time.",
          substituted:
            "host ingress fixture and model planning only; no private payloads, providers, tools or channels invoked",
          summarizes: planning.summarize.mock.calls.length,
          compactions: planning.compact.mock.calls.length,
        }),
      );
    }
  },
);
