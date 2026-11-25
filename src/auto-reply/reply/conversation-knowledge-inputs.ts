import { isDeepStrictEqual } from "node:util";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import type { PreparedConversationKnowledgeCheckpointCoverage } from "../../config/sessions/conversation-knowledge-checkpoint.js";
import {
  CONVERSATION_KNOWLEDGE_CHECKPOINT_CONTEXT,
  CONVERSATION_KNOWLEDGE_CONTEXT,
} from "../../config/sessions/conversation-knowledge-context-kinds.js";
import {
  type ConversationKnowledgeImportProgress,
  readConversationKnowledgePacketProgress,
} from "../../config/sessions/conversation-knowledge-packets.js";
import {
  selectConversationKnowledgeObserved,
  selectConversationKnowledgeReceipts,
} from "../../config/sessions/conversation-knowledge-selection.js";
import {
  issuePreparedKnowledgeRootCandidates,
  readConversationKnowledgeRoot,
  readPreparedConversationKnowledgeRoot,
  type PreparedKnowledgeRootCandidates,
  type ConversationKnowledgeBranch,
} from "../../config/sessions/conversation-knowledge-store.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";

const log = createSubsystemLogger("conversation-knowledge");

/** Only background/legacy readers enumerate history; live boundaries rebind bounded provenance. */
export async function readConversationKnowledgeInputs(params: {
  branch: ConversationKnowledgeBranch;
  reader: SessionEntryCohortReader;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
  readyOnly?: boolean;
  preparationOnly?: boolean;
  retainInHistory: boolean;
  manifest?: PreparedKnowledgeRootCandidates;
  sourceCache?: ConversationKnowledgeSourceCache;
}) {
  if (params.readyOnly && !params.manifest) {
    return undefined;
  }
  const check = () => {
    params.assertCurrent();
    params.signal?.throwIfAborted();
  };
  const cache = params.preparationOnly ? params.sourceCache : undefined;
  const epoch = cache?.consumptionRevision ?? -1;
  const logInputRoot = (outcome: string, manifestBytes?: number) => {
    if (log.isEnabled("debug")) {
      log.debug("Related-history preparation input root", {
        recipientHash: redactIdentifier(params.branch.sessionId),
        rootHash: redactIdentifier(params.branch.root.sessionId),
        outcome,
        manifestBytes,
        ...cache?.diagnosticCapacity(),
      });
    }
  };
  const prepareTranscriptReader = async (target: ConversationKnowledgeBranch) => {
    check();
    const { prepareSessionTranscriptHydration } =
      await import("../../config/sessions/session-transcript-hydration.js");
    check();
    return prepareSessionTranscriptHydration(
      { ...target, env: params.reader.database.env },
      undefined,
      params.signal,
    );
  };
  const readVersionFacts = async (target: ConversationKnowledgeBranch, activeLeaf = false) => {
    const reader = await prepareTranscriptReader(target);
    const facts = await reader.readMaintenance({
      operation: "version",
      contextOnly: true,
      ...(activeLeaf ? { activeLeaf } : {}),
    });
    check();
    if (!facts.version) {
      throw new Error("Conversation preparation input version is unavailable");
    }
    return { version: facts.version, activeLeafEntryId: facts.activeLeafEntryId };
  };
  const readVersion = async (target: ConversationKnowledgeBranch) =>
    (await readVersionFacts(target)).version;
  const rebind = async (manifest: PreparedKnowledgeRootCandidates) => {
    try {
      return await readPreparedConversationKnowledgeRoot({ ...params, manifest });
    } catch (error) {
      params.signal?.throwIfAborted();
      cache?.clearPreparationInputs();
      params.sourceCache?.clearPreparedRoot(manifest);
      throw error;
    }
  };
  const readRoot = async () => {
    if (params.manifest) {
      return rebind(params.manifest);
    }
    if (!cache) {
      return readConversationKnowledgeRoot(params);
    }
    const target = { ...params.branch, ...params.branch.root };
    let version = await readVersion(target);
    const cached = cache.preparationRoot(version);
    if (cached) {
      const events = await rebind(cached);
      const current = await readVersion(target);
      if (isDeepStrictEqual(version, current)) {
        logInputRoot("hit");
        return events;
      }
      logInputRoot("version-changed");
      cache.preparationRoot(current);
      version = current;
    } else {
      logInputRoot("miss");
    }
    const events = await readConversationKnowledgeRoot(params);
    const current = await readVersion(target);
    if (isDeepStrictEqual(version, current)) {
      try {
        const manifest = issuePreparedKnowledgeRootCandidates(
          events.evidence,
          selectConversationKnowledgeReceipts(events, ""),
          { maxBytes: cache.maxPreparedRootBytes },
        );
        cache.retainPreparationRoot(current, manifest, epoch);
        if (log.isEnabled("debug")) {
          logInputRoot(
            epoch !== cache.consumptionRevision
              ? "consumption-changed"
              : cache.diagnosticCapacity().inputRootBytes > 0
                ? "retained"
                : "capacity-refused",
            manifest.byteLength,
          );
        }
      } catch (error) {
        if (!(error instanceof RangeError)) {
          throw error;
        }
        // An oversized snapshot still serves this read; it is never retained.
        logInputRoot("manifest-budget-refused");
      }
    } else {
      logInputRoot("changed-during-read");
    }
    return events;
  };
  const events = await readRoot();
  check();
  const readDurableProgress = (
    hints?: Pick<
      Parameters<typeof readConversationKnowledgePacketProgress>[0],
      "initial" | "extension" | "onImports"
    >,
  ) =>
    readConversationKnowledgePacketProgress({
      ...params,
      ...hints,
      async prepareCheckpointCoverage(checkpoints) {
        // An already admitted summary is recipient history. Resolve its immutable
        // coverage off-turn, without granting access to any original donor.
        const {
          readConversationKnowledgeCheckpointById,
          readConversationKnowledgeCheckpointCoverage,
        } = await import("../../config/sessions/conversation-knowledge-checkpoint-store.js");
        check();
        const prepared = new Map<string, PreparedConversationKnowledgeCheckpointCoverage>();
        for (const receipt of checkpoints) {
          check();
          let coverage = cache?.checkpointCoverage(receipt.checkpointId);
          if (!coverage) {
            const checkpoint = await readConversationKnowledgeCheckpointById({
              branch: params.branch,
              checkpointId: receipt.checkpointId,
              source: params.assertCurrent,
              signal: params.signal,
            });
            coverage = await readConversationKnowledgeCheckpointCoverage({
              reader: params.reader,
              branch: params.branch,
              checkpoint,
              source: params.assertCurrent,
              signal: params.signal,
            });
            check();
            cache?.retainCheckpointCoverage(receipt.checkpointId, coverage);
          }
          prepared.set(receipt.checkpointId, coverage);
        }
        return prepared;
      },
    });
  const readProgress = async () => {
    if (!cache) {
      return readDurableProgress();
    }
    let version = await readVersion(params.branch);
    const cached = cache.preparationProgress(version);
    if (cached) {
      // Even equal native versions cannot authorize a replacement physical store.
      await rebind(cached.manifest);
      const current = await readVersion(params.branch);
      if (isDeepStrictEqual(version, current)) {
        return cached.progress;
      }
      version = current;
    }
    const base = cache.preparationProgressBase();
    let extension: Parameters<typeof readConversationKnowledgePacketProgress>[0]["extension"];
    if (
      base &&
      base.point.generation === version.generation &&
      version.rawSeq !== null &&
      version.rawSeq > base.point.rawSeq
    ) {
      await rebind(base.manifest);
      const reader = await prepareTranscriptReader(params.branch);
      const suffix = await reader.readMaintenance({
        operation: "active-report-suffix",
        after: base.point,
        expectedVersion: version,
        customTypes: [CONVERSATION_KNOWLEDGE_CONTEXT, CONVERSATION_KNOWLEDGE_CHECKPOINT_CONTEXT],
      });
      check();
      if (suffix.events && isDeepStrictEqual(suffix.version, version)) {
        extension = { base: base.imports, reports: suffix.events };
      }
    }
    const unchanged = extension?.reports.length === 0 ? base : undefined;
    let usedInitial = false;
    let imports: ConversationKnowledgeImportProgress | undefined = unchanged?.imports;
    const progress =
      unchanged?.progress ??
      (await readDurableProgress({
        ...(extension
          ? { extension }
          : {
              initial: {
                rootEvidence: events.evidence,
                version,
                onUsed: () => {
                  usedInitial = true;
                },
              },
            }),
        onImports: (value) => {
          imports = value;
        },
      }));
    const { version: current, activeLeafEntryId } = await readVersionFacts(params.branch, true);
    const stable = isDeepStrictEqual(version, current);
    if (!stable && (usedInitial || extension)) {
      return readDurableProgress();
    }
    if (stable) {
      try {
        cache.retainPreparationProgress(
          current,
          issuePreparedKnowledgeRootCandidates(events.evidence, [], {
            maxBytes: cache.maxPreparedRootBytes,
          }),
          progress,
          epoch,
          imports && current.generation !== null && activeLeafEntryId !== undefined
            ? {
                imports,
                point: {
                  generation: current.generation,
                  rawSeq: current.rawSeq ?? -1,
                  leafEntryId: activeLeafEntryId,
                },
              }
            : undefined,
        );
      } catch (error) {
        if (!(error instanceof RangeError)) {
          throw error;
        }
      }
    }
    return progress;
  };
  const retained =
    (params.retainInHistory && !params.readyOnly) || params.preparationOnly
      ? await readProgress()
      : undefined;
  check();
  return { events, retained, previous: selectConversationKnowledgeObserved(events, params.branch) };
}
