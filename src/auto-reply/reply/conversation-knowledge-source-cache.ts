import { isDeepStrictEqual } from "node:util";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { snapshotConversationKnowledgeProgress } from "../../config/sessions/conversation-knowledge-checkpoint-context.js";
import type { PreparedConversationKnowledgeCheckpointCoverage } from "../../config/sessions/conversation-knowledge-checkpoint.js";
import type { ConversationKnowledgePacketProgress } from "../../config/sessions/conversation-knowledge-packets.js";
import type { PreparedKnowledgeRootCandidates } from "../../config/sessions/conversation-knowledge-store.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { SessionTranscriptModelContext } from "../../config/sessions/session-history-read.types.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-transcript-context-version.types.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import type {
  PreparedPersonalConversationAdmission,
  PreparedPersonalConversationContributionGroup,
} from "../../gateway/session-transcript-personal-read.js";
import type { PreparedRecipientConversationCheckpoint } from "./conversation-knowledge-checkpoint-recipient.js";
import type {
  PreparedConversationKnowledgePacket,
  ConversationKnowledgeSourceSelection,
  ConversationKnowledgeCachedAdmission,
} from "./conversation-knowledge-source-cache.types.js";
import { validateConversationKnowledgeCachedContext } from "./conversation-knowledge-source-validation.js";
export type {
  PreparedConversationKnowledgePacket,
  ConversationKnowledgeSourceSelection,
} from "./conversation-knowledge-source-cache.types.js";

/** Disposable bytes and native read preparation; every disclosure still needs a fresh grant. */
export function createConversationKnowledgeSourceCache<
  Admission extends Pick<PreparedPersonalConversationAdmission, "byteLength" | "release"> =
    PreparedPersonalConversationAdmission,
>(maxBytes = 4 * 1024 * 1024) {
  const entries = new Map<
    string,
    { value: SessionTranscriptModelContext; bytes: number; contributionId: string }
  >();
  const staged = new Map<
    string,
    {
      value: PreparedConversationKnowledgePacket;
      bytes: number;
      contributionId: string;
      offset: number;
    }
  >();
  let bytes = 0;
  let admissionBytes = 0;
  type ReleasableAdmission = Admission | PreparedPersonalConversationContributionGroup;
  const admissions = new Map<string, ConversationKnowledgeCachedAdmission<Admission>>();
  const admissionSources = new Map<string, string>();
  const retiringAdmissions = new Set<ReleasableAdmission>();
  const retiringCleanups = new Set<() => void>();
  const retryCleanup = () => {
    const errors: unknown[] = [];
    try {
      releaseAdmissions([]);
    } catch (error) {
      errors.push(error);
    }
    for (const release of retiringCleanups) {
      try {
        release();
        retiringCleanups.delete(release);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Conversation checkpoint cleanup remains pending");
    }
  };
  const releaseAdmissions = (selected: Iterable<ReleasableAdmission>) => {
    for (const admission of selected) {
      retiringAdmissions.add(admission);
    }
    const errors: unknown[] = [];
    for (const admission of retiringAdmissions) {
      try {
        admission.release();
        retiringAdmissions.delete(admission);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Prepared conversation admission cleanup remains pending");
    }
  };
  const admissionKey = (source: SessionTranscriptRuntimeTarget & { lifecycleRevision: string }) =>
    JSON.stringify([
      source.agentId,
      source.storePath,
      source.sessionKey,
      source.sessionId,
      source.lifecycleRevision,
    ]);
  const releaseUnusedAdmissions = () => {
    const selected = new Set(admissionSources.values());
    const retired: ReleasableAdmission[] = [];
    for (const [key, entry] of admissions) {
      if (!selected.has(key)) {
        admissions.delete(key);
        admissionBytes -= entry.bytes;
        retired.push(entry.value);
      }
    }
    releaseAdmissions(retired);
  };
  let stagedBytes = 0;
  let revision = 0;
  let consumptionRevision = 0;
  let invalidationRevision = 0;
  let preparedCheckpoint: PreparedRecipientConversationCheckpoint | undefined;
  const retireCheckpoint = () => {
    const old = preparedCheckpoint;
    preparedCheckpoint = undefined;
    if (old) {
      for (const group of old.groups) {
        retiringCleanups.add(() => group.admission.release());
      }
    }
  };
  const checkpointCoverage = new Map<string, PreparedConversationKnowledgeCheckpointCoverage>();
  let clearEpoch = 0;
  let preparedRoot: PreparedKnowledgeRootCandidates | undefined;
  let preparedRootSelection: string | undefined;
  let preparedSourceScope: string | undefined;
  let preparedSourceSelections = new Map<string, string>();
  const retireGroups = (current?: ReadonlyMap<string, string>) => {
    const retired: ReleasableAdmission[] = [];
    for (const [key, entry] of admissions) {
      if (entry.kind !== "group") {
        continue;
      }
      if (entry.selectionKey !== undefined && entry.selectionKey === current?.get(key)) {
        continue;
      }
      admissions.delete(key);
      admissionBytes -= entry.bytes;
      retired.push(entry.value);
    }
    for (const [id, key] of admissionSources) {
      if (!admissions.has(key)) {
        admissionSources.delete(id);
      }
    }
    releaseAdmissions(retired);
  };
  let inputRoot:
    | {
        version: SessionTranscriptContextVersion;
        manifest: PreparedKnowledgeRootCandidates;
        bytes: number;
      }
    | undefined;
  let inputProgress:
    | {
        version: SessionTranscriptContextVersion;
        manifest: PreparedKnowledgeRootCandidates;
        progress: ReadonlyMap<string, ConversationKnowledgePacketProgress>;
        bytes: number;
      }
    | undefined;
  const inputBytes = () => (inputRoot?.bytes ?? 0) + (inputProgress?.bytes ?? 0);
  const remove = (key: string) => {
    const old = entries.get(key);
    if (old) {
      bytes -= old.bytes;
      entries.delete(key);
      revision++;
      if (
        ![...entries.values(), ...staged.values()].some(
          (entry) => entry.contributionId === old.contributionId,
        )
      ) {
        admissionSources.delete(old.contributionId);
        releaseUnusedAdmissions();
      }
    }
  };
  const stagedKey = (id: string, offset: number) => JSON.stringify([id, offset]);
  const invalidateStaged = (id: string) => {
    for (const [key, entry] of staged) {
      if (entry.contributionId === id) {
        staged.delete(key);
        invalidationRevision++;
        stagedBytes -= entry.bytes;
        revision++;
      }
    }
  };
  const reserveInputBytes = (additional: number) => {
    if (inputBytes() + (preparedRoot?.byteLength ?? 0) + additional > maxBytes) {
      return false;
    }
    for (const key of entries.keys()) {
      if (bytes + inputBytes() + (preparedRoot?.byteLength ?? 0) + additional <= maxBytes) {
        break;
      }
      remove(key);
    }
    return bytes + inputBytes() + (preparedRoot?.byteLength ?? 0) + additional <= maxBytes;
  };
  return {
    retainCleanup(release: () => void) {
      retiringCleanups.add(release);
    },
    forgetCleanup(release: () => void) {
      retiringCleanups.delete(release);
    },
    retryCleanup,
    get preparedCheckpoint() {
      return preparedCheckpoint;
    },
    stageCheckpoint(value: PreparedRecipientConversationCheckpoint) {
      if (
        value.manifest.ownedByteLength +
          Buffer.byteLength(value.checkpoint.summary) +
          value.groups.reduce((sum, group) => sum + group.admission.ownedByteLength, 0) >
        maxBytes
      ) {
        return false;
      }
      if (preparedCheckpoint !== value) {
        retireCheckpoint();
      }
      preparedCheckpoint = value;
      revision++;
      return true;
    },
    clearCheckpoint(expected?: PreparedRecipientConversationCheckpoint) {
      // A paused owner may still finish its already-running preparation quantum.
      // An older foreground failure must not retire that newly prepared candidate.
      if (expected && preparedCheckpoint !== expected) {
        return;
      }
      invalidationRevision += preparedCheckpoint ? 1 : 0;
      retireCheckpoint();
      retryCleanup();
    },
    consumeCheckpoint(value: PreparedRecipientConversationCheckpoint) {
      if (preparedCheckpoint === value) {
        retireCheckpoint();
      }
      checkpointCoverage.set(value.checkpoint.checkpointId, value.coverage);
      // Visit bounded prepared packets once, not the potentially year-long coverage set.
      for (const [key, entry] of staged) {
        if (value.coverage.has(entry.contributionId)) {
          staged.delete(key);
          stagedBytes -= entry.bytes;
          admissionSources.delete(entry.contributionId);
        }
      }
      releaseUnusedAdmissions();
      inputProgress = undefined;
      consumptionRevision++;
      revision++;
      retryCleanup();
    },
    checkpointCoverage(id: string) {
      return checkpointCoverage.get(id);
    },
    retainCheckpointCoverage(
      id: string,
      coverage: PreparedConversationKnowledgeCheckpointCoverage,
    ) {
      // One shared immutable root proof, not recipient-owned text. A payload-cache
      // limit must not turn a large exact coverage ledger into a permanent reread loop.
      checkpointCoverage.set(id, coverage);
    },
    preparedAdmission(source: SessionTranscriptRuntimeTarget & { lifecycleRevision: string }) {
      const entry = admissions.get(admissionKey(source));
      return entry?.kind === "single" ? entry.value : undefined;
    },
    preparedContributionGroup(
      source: SessionTranscriptRuntimeTarget & { lifecycleRevision: string },
      manifest: PreparedKnowledgeRootCandidates,
      contributionId?: string,
    ) {
      const key = admissionKey(source);
      const entry = admissions.get(key);
      return entry?.kind === "group" &&
        preparedRoot === manifest &&
        (contributionId === undefined || admissionSources.get(contributionId) === key)
        ? entry.value
        : undefined;
    },
    preparedContributionGroupManifest(
      source: SessionTranscriptRuntimeTarget & { lifecycleRevision: string },
      manifest: PreparedKnowledgeRootCandidates,
    ) {
      const entry = admissions.get(admissionKey(source));
      return entry?.kind === "group" && preparedRoot === manifest ? entry.manifest : undefined;
    },
    retainContributionGroup(
      contributionIds: readonly string[],
      source: SessionTranscriptRuntimeTarget & { lifecycleRevision: string },
      group: PreparedPersonalConversationContributionGroup,
      manifest: PreparedKnowledgeRootCandidates,
      sourceManifest: PreparedKnowledgeRootCandidates = manifest,
    ): boolean {
      const key = admissionKey(source);
      const existing = admissions.get(key);
      const size = group.byteLength + (sourceManifest === manifest ? 0 : sourceManifest.byteLength);
      if (
        !contributionIds.length ||
        preparedRoot !== manifest ||
        size > maxBytes - admissionBytes + (existing?.bytes ?? 0)
      ) {
        releaseAdmissions([group]);
        return false;
      }
      admissions.set(key, {
        kind: "group",
        value: group,
        bytes: size,
        manifest: sourceManifest,
        selectionKey: preparedSourceSelections.get(key),
      });
      admissionBytes += size - (existing?.bytes ?? 0);
      for (const [id, sourceKey] of admissionSources) {
        if (sourceKey === key) {
          admissionSources.delete(id);
        }
      }
      contributionIds.forEach((id) => admissionSources.set(id, key));
      if (existing && existing.value !== group) {
        releaseAdmissions([existing.value]);
      }
      return true;
    },
    retainAdmission(
      contributionId: string,
      source: SessionTranscriptRuntimeTarget & { lifecycleRevision: string },
      admission: Admission,
    ): boolean {
      const key = admissionKey(source);
      const existing = admissions.get(key);
      if (existing?.kind === "single") {
        if (existing.value !== admission) {
          releaseAdmissions([admission]);
        }
      } else if (admission.byteLength <= maxBytes - admissionBytes + (existing?.bytes ?? 0)) {
        admissions.set(key, { kind: "single", value: admission, bytes: admission.byteLength });
        admissionBytes += admission.byteLength - (existing?.bytes ?? 0);
        if (existing) {
          releaseAdmissions([existing.value]);
        }
      } else {
        releaseAdmissions([admission]);
        return false;
      }
      admissionSources.set(contributionId, key);
      return true;
    },
    invalidateAdmission(source: SessionTranscriptRuntimeTarget & { lifecycleRevision: string }) {
      const key = admissionKey(source);
      const existing = admissions.get(key);
      if (existing) {
        admissions.delete(key);
        admissionBytes -= existing.bytes;
        revision++;
        releaseAdmissions([existing.value]);
      }
    },
    get revision() {
      return revision;
    },
    get consumptionRevision() {
      return consumptionRevision;
    },
    get invalidationRevision() {
      return invalidationRevision;
    },
    diagnosticCapacity() {
      return { preparedPackets: staged.size, stagedBytes, admissionBytes, maxBytes };
    },
    diagnosticPreparedFrontiers() {
      const frontiers = new Map<string, number>();
      for (const slot of staged.values()) {
        if (slot.offset !== 0 || !slot.value.part.complete) {
          continue;
        }
        const { sessionId, rawSeq } = slot.value.through;
        const sourceHash = redactIdentifier(sessionId);
        if (!frontiers.has(sourceHash) && frontiers.size >= 8) {
          continue;
        }
        frontiers.set(sourceHash, Math.max(frontiers.get(sourceHash) ?? 0, rawSeq));
      }
      return [...frontiers].map(([sourceHash, throughSeq]) => ({ sourceHash, throughSeq }));
    },
    get preparedRoot() {
      return preparedRoot;
    },
    get maxPreparedRootBytes() {
      return maxBytes;
    },
    clearPreparationInputs() {
      inputRoot = undefined;
      inputProgress = undefined;
    },
    preparationRoot(version: SessionTranscriptContextVersion) {
      if (inputRoot && !isDeepStrictEqual(inputRoot.version, version)) {
        inputRoot = undefined;
      }
      return inputRoot?.manifest;
    },
    retainPreparationRoot(
      version: SessionTranscriptContextVersion,
      manifest: PreparedKnowledgeRootCandidates,
      expectedConsumptionRevision: number,
    ) {
      if (consumptionRevision !== expectedConsumptionRevision) {
        return;
      }
      inputRoot = undefined;
      const size = manifest.byteLength + Buffer.byteLength(JSON.stringify(version));
      if (reserveInputBytes(size)) {
        inputRoot = { version: structuredClone(version), manifest, bytes: size };
      }
    },
    preparationProgress(version: SessionTranscriptContextVersion) {
      if (inputProgress && !isDeepStrictEqual(inputProgress.version, version)) {
        inputProgress = undefined;
      }
      return (
        inputProgress && {
          manifest: inputProgress.manifest,
          progress: inputProgress.progress,
        }
      );
    },
    retainPreparationProgress(
      version: SessionTranscriptContextVersion,
      manifest: PreparedKnowledgeRootCandidates,
      progress: ReadonlyMap<string, ConversationKnowledgePacketProgress>,
      expectedConsumptionRevision: number,
    ) {
      if (consumptionRevision !== expectedConsumptionRevision) {
        return;
      }
      inputProgress = undefined;
      const snapshot = snapshotConversationKnowledgeProgress(progress);
      const size =
        manifest.byteLength + Buffer.byteLength(JSON.stringify(version)) + snapshot.byteLength;
      if (reserveInputBytes(size)) {
        inputProgress = {
          version: structuredClone(version),
          manifest,
          progress: snapshot.progress,
          bytes: size,
        };
      }
    },
    setPreparedRoot(
      value: PreparedKnowledgeRootCandidates,
      selectionKey?: string,
      sourceSelection?: ConversationKnowledgeSourceSelection,
    ) {
      if (value.byteLength > maxBytes) {
        throw new RangeError("Prepared conversation provenance exceeds its cache budget");
      }
      if (
        selectionKey &&
        selectionKey === preparedRootSelection &&
        preparedRoot &&
        preparedSourceScope === sourceSelection?.scopeKey
      ) {
        return preparedRoot;
      }
      // Provenance shares the disposable raw-byte budget; pending packets retain
      // their independent budget so preparing a manifest cannot evict unsent text.
      if (inputBytes() + value.byteLength > maxBytes) {
        inputRoot = undefined;
        inputProgress = undefined;
      }
      for (const key of entries.keys()) {
        if (bytes + inputBytes() + value.byteLength <= maxBytes) {
          break;
        }
        remove(key);
      }
      preparedRoot = value;
      preparedRootSelection = selectionKey;
      const retain = sourceSelection && sourceSelection.scopeKey === preparedSourceScope;
      preparedSourceScope = sourceSelection?.scopeKey;
      preparedSourceSelections = new Map(
        sourceSelection?.sources.map((selected) => [
          admissionKey(selected.source),
          selected.selectionKey,
        ]),
      );
      // A foreground read can observe staged bytes before this proof publishes.
      // Publishing readiness must wake the next boundary even without new text.
      revision++;
      retireGroups(retain ? preparedSourceSelections : undefined);
      return value;
    },
    clearPreparedRoot(expected?: PreparedKnowledgeRootCandidates) {
      if (expected && expected !== preparedRoot) {
        return;
      }
      preparedRoot = undefined;
      preparedRootSelection = undefined;
      preparedSourceScope = undefined;
      preparedSourceSelections.clear();
      revision++;
      retireGroups();
    },
    preparedPackets(limit: number) {
      const selected: Array<{ contributionId: string; offset: number }> = [];
      for (const { contributionId, offset } of staged.values()) {
        if (selected.length >= limit) {
          break;
        }
        selected.push({ contributionId, offset });
      }
      return selected;
    },
    firstPreparedOffset(id: string) {
      let first: number | undefined;
      for (const entry of staged.values()) {
        if (entry.contributionId === id && (first === undefined || entry.offset < first)) {
          first = entry.offset;
        }
      }
      return first;
    },
    preparedContributionIds(limit: number) {
      const ids = new Set<string>();
      for (const { contributionId } of staged.values()) {
        if (ids.size >= limit) {
          break;
        }
        ids.add(contributionId);
      }
      return [...ids];
    },
    hasContribution(id: string) {
      return (
        [...entries.values()].some((entry) => entry.contributionId === id) ||
        [...staged.values()].some((entry) => entry.contributionId === id)
      );
    },
    /** Pending packets have their own bounded budget and never evict earlier unsent packets. */
    stage(id: string, offset: number, value: PreparedConversationKnowledgePacket): boolean {
      const key = stagedKey(id, offset);
      const existing = staged.get(key);
      const previous =
        existing?.value ?? [...staged.values()].find((entry) => entry.contributionId === id)?.value;
      if (previous) {
        if (
          !isDeepStrictEqual(previous.through, value.through) ||
          !isDeepStrictEqual(previous.from, value.from)
        ) {
          // A proven source rewrite may renew anchors without changing contribution
          // identity. Retire its old offsets together, never mix two physical ranges.
          invalidateStaged(id);
        } else if (existing) {
          return true;
        }
      }
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size > maxBytes - stagedBytes) {
        return false;
      }
      staged.set(key, { value: structuredClone(value), bytes: size, contributionId: id, offset });
      stagedBytes += size;
      revision++;
      return true;
    },
    peek(id: string, offset: number): PreparedConversationKnowledgePacket | undefined {
      const value = staged.get(stagedKey(id, offset))?.value;
      return value && structuredClone(value);
    },
    consume(id: string, offset: number) {
      // A native commit can advance a packet that was never staged here. Any
      // in-flight preparation must reread durable progress before staging more.
      consumptionRevision++;
      inputProgress = undefined;
      const key = stagedKey(id, offset);
      const old = staged.get(key);
      if (old) {
        staged.delete(key);
        stagedBytes -= old.bytes;
        revision++;
        if (old.value.part.complete) {
          admissionSources.delete(id);
          releaseUnusedAdmissions();
        }
      }
    },
    invalidateContribution(id: string) {
      for (const [key, entry] of entries) {
        if (entry.contributionId === id) {
          remove(key);
        }
      }
      invalidateStaged(id);
      admissionSources.delete(id);
      releaseUnusedAdmissions();
    },
    retainContributions(current: ReadonlySet<string>) {
      for (const [key, entry] of entries) {
        if (!current.has(entry.contributionId)) {
          remove(key);
        }
      }
      for (const id of new Set([...staged.values()].map((entry) => entry.contributionId))) {
        if (!current.has(id)) {
          invalidateStaged(id);
        }
      }
      for (const id of admissionSources.keys()) {
        if (!current.has(id)) {
          admissionSources.delete(id);
        }
      }
      releaseUnusedAdmissions();
    },
    clear() {
      retireCheckpoint();
      checkpointCoverage.clear();
      const retired = [...admissions.values()].map((entry) => entry.value);
      admissions.clear();
      admissionSources.clear();
      admissionBytes = 0;
      entries.clear();
      staged.clear();
      bytes = 0;
      stagedBytes = 0;
      preparedRoot = undefined;
      preparedRootSelection = undefined;
      preparedSourceScope = undefined;
      preparedSourceSelections.clear();
      inputRoot = undefined;
      inputProgress = undefined;
      revision++;
      clearEpoch++;
      consumptionRevision++;
      // One cleanup pass attempts every owner once and retains all failures.
      invalidationRevision++;
      for (const admission of retired) {
        retiringAdmissions.add(admission);
      }
      retryCleanup();
    },
    async read(params: {
      contributionId: string;
      target: SessionTranscriptRuntimeTarget;
      through: TranscriptEntryAnchor;
      from?: TranscriptEntryAnchor;
      signal?: AbortSignal;
      assertCurrent(): void;
      load?: () => Promise<SessionTranscriptModelContext>;
    }): Promise<SessionTranscriptModelContext | undefined> {
      params.assertCurrent();
      params.signal?.throwIfAborted();
      const key = JSON.stringify([
        params.contributionId,
        params.target.agentId,
        params.target.storePath,
        params.target.sessionKey,
        params.target.sessionId,
        params.through,
        params.from,
      ]);
      const cached = entries.get(key);
      if (cached?.value.version) {
        const valid = await validateConversationKnowledgeCachedContext(
          params,
          cached.value.version,
        );
        params.assertCurrent();
        params.signal?.throwIfAborted();
        if (valid) {
          if (entries.get(key) === cached) {
            entries.delete(key);
            entries.set(key, cached);
          }
          return cached.value;
        }
        if (entries.get(key) === cached) {
          remove(key);
        }
      }
      if (!params.load) {
        return undefined;
      }
      const epoch = clearEpoch;
      const value = await params.load();
      params.assertCurrent();
      params.signal?.throwIfAborted();
      const size = Buffer.byteLength(JSON.stringify(value));
      // Cache capacity changes only preparation cost, never delivered knowledge coverage.
      const rawLimit = maxBytes - (preparedRoot?.byteLength ?? 0) - inputBytes();
      if (value.version && size <= rawLimit && epoch === clearEpoch) {
        remove(key);
        for (const oldKey of entries.keys()) {
          if (bytes + size <= rawLimit) {
            break;
          }
          remove(oldKey);
        }
        entries.set(key, { value, bytes: size, contributionId: params.contributionId });
        bytes += size;
        revision++;
      }
      return value;
    },
  };
}

export type ConversationKnowledgeSourceCache = ReturnType<
  typeof createConversationKnowledgeSourceCache<PreparedPersonalConversationAdmission>
>;
