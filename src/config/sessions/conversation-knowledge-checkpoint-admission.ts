import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { createConversationKnowledgeCheckpointContext } from "./conversation-knowledge-checkpoint-context.js";
import {
  selectConversationKnowledgeCheckpointBootstrap,
  type ConversationKnowledgeCheckpoint,
  type PreparedConversationKnowledgeCheckpointCoverage,
} from "./conversation-knowledge-checkpoint.js";
import { readConversationKnowledgeImportProgress } from "./conversation-knowledge-packets.js";
import {
  prepareNativeKnowledgeRootContributionGroup,
  assertNativeKnowledgeRootContributionGroup,
  type NativeKnowledgeRootContributionGroup,
  type NativeKnowledgeRootEvidence,
  type PreparedKnowledgeRootCandidates,
  type ConversationKnowledgeBranch,
} from "./conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "./conversation-knowledge.js";
import { appendSessionTranscriptReportBatch } from "./session-accessor.sqlite-transcript-reports.js";
import type {
  SessionTranscriptRuntimeTarget,
  SessionTranscriptWriteScope,
} from "./session-accessor.types.js";
import { assertSessionEntryCohortScope } from "./session-entry-cohort-scope.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
  type SessionSourcePredicate,
} from "./session-source-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { withSessionTranscriptDeltaReader } from "./session-transcript-delta-read.js";
import { createTranscriptRawDeltaCursor } from "./session-transcript-raw-cursor.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import type { TranscriptTurnAdmission } from "./transcript-entry-anchor.js";

const bootstrapIssuer = Symbol("conversation-checkpoint-bootstrap");
const selectionIssuer = Symbol("conversation-checkpoint-selection");
type CheckpointSelectionBinding = {
  branch: ConversationKnowledgeBranch;
  checkpoint: ConversationKnowledgeCheckpoint;
  coverage: PreparedConversationKnowledgeCheckpointCoverage;
  audienceKey: string;
  manifest: PreparedKnowledgeRootCandidates;
  rootEvidence: NativeKnowledgeRootEvidence;
};

/** Sealed data correspondence, never a substitute for fresh source ACL/prefix custody. */
export class PreparedConversationKnowledgeCheckpointSelection {
  readonly checkpoint: ConversationKnowledgeCheckpoint;
  readonly #branch: ConversationKnowledgeBranch;
  readonly #coverage: PreparedConversationKnowledgeCheckpointCoverage;
  readonly #audienceKey: string;
  readonly #manifest: PreparedKnowledgeRootCandidates;
  readonly #rootProof: NativeKnowledgeRootContributionGroup;
  constructor(
    issuer: typeof selectionIssuer,
    params: CheckpointSelectionBinding,
    proof: NativeKnowledgeRootContributionGroup,
  ) {
    if (issuer !== selectionIssuer) {
      throw new Error("Checkpoint selection requires verified preparation");
    }
    this.checkpoint = freezeJsonSnapshot(structuredClone(params.checkpoint));
    this.#branch = structuredClone(params.branch);
    this.#coverage = params.coverage;
    this.#audienceKey = params.audienceKey;
    this.#manifest = params.manifest;
    this.#rootProof = proof;
    Object.freeze(this);
  }
  validate(params: CheckpointSelectionBinding): ConversationKnowledgeCheckpoint {
    if (
      !isDeepStrictEqual(params.branch, this.#branch) ||
      params.checkpoint !== this.checkpoint ||
      params.coverage !== this.#coverage ||
      params.audienceKey !== this.#audienceKey ||
      params.manifest !== this.#manifest
    ) {
      throw new Error("Prepared checkpoint selection changed");
    }
    assertNativeKnowledgeRootContributionGroup(params.rootEvidence, params.branch, this.#rootProof);
    return this.checkpoint;
  }
  static read(value: unknown, params: CheckpointSelectionBinding): ConversationKnowledgeCheckpoint {
    if (typeof value !== "object" || value === null || !(#branch in value)) {
      throw new Error("Checkpoint selection requires verified preparation");
    }
    return value.validate(params);
  }
}
Object.freeze(PreparedConversationKnowledgeCheckpointSelection);
Object.freeze(PreparedConversationKnowledgeCheckpointSelection.prototype);

/** Off-turn: caller must have validated every covered original range with native source grants. */
export function prepareConversationKnowledgeCheckpointSelection(
  params: CheckpointSelectionBinding & {
    availableReferences: readonly ConversationKnowledgeReference[];
    source: SessionSourceAssertion;
  },
): PreparedConversationKnowledgeCheckpointSelection | undefined {
  params.source();
  const checkpoint = selectConversationKnowledgeCheckpointBootstrap({
    ...params,
    progress: new Map(),
  });
  if (!checkpoint) {
    return undefined;
  }
  const proof = prepareNativeKnowledgeRootContributionGroup(
    params.rootEvidence,
    params.branch,
    params.availableReferences,
  );
  params.source();
  return new PreparedConversationKnowledgeCheckpointSelection(
    selectionIssuer,
    { ...params, checkpoint },
    proof,
  );
}
/** Values from the first actual native provider request, not configuration guesses. */
export type ConversationKnowledgeBootstrapInitialization = {
  provider: string;
  modelId: string;
  thinkingLevel: string;
};
/** Background eligibility is not read authority; the writer must still compare its exact version. */
export class PreparedConversationKnowledgeBootstrap {
  readonly #branch: ConversationKnowledgeBranch;
  readonly #version: SessionTranscriptContextVersion;
  readonly #appendParentId: string | null;
  constructor(
    issuer: typeof bootstrapIssuer,
    branch: ConversationKnowledgeBranch,
    version: SessionTranscriptContextVersion,
    appendParentId: string | null,
  ) {
    if (issuer !== bootstrapIssuer) {
      throw new Error("Checkpoint bootstrap requires native preparation");
    }
    this.#branch = structuredClone(branch);
    this.#version = structuredClone(version);
    this.#appendParentId = appendParentId;
    Object.freeze(this);
  }
  version(branch: ConversationKnowledgeBranch): SessionTranscriptContextVersion {
    if (!isDeepStrictEqual(branch, this.#branch)) {
      throw new Error("Checkpoint bootstrap recipient changed");
    }
    return structuredClone(this.#version);
  }
  appendParentId(branch: ConversationKnowledgeBranch): string | null {
    this.version(branch);
    return this.#appendParentId;
  }
}

/** Off-turn only: do not scan a recipient transcript on its model-request boundary. */
export async function prepareConversationKnowledgeBootstrap(params: {
  branch: ConversationKnowledgeBranch;
  env?: NodeJS.ProcessEnv;
  source: SessionSourceAssertion;
  signal?: AbortSignal;
}): Promise<PreparedConversationKnowledgeBootstrap | undefined> {
  const { prepareSessionTranscriptHydration } = await import("./session-transcript-hydration.js");
  const check = () => {
    params.source();
    params.signal?.throwIfAborted();
  };
  const version = async () => {
    check();
    const result = await prepareSessionTranscriptHydration(
      { ...params.branch, env: params.env },
      undefined,
      params.signal,
    ).readMaintenance({ operation: "version" });
    check();
    return result;
  };
  const before = await version();
  const imports = await readConversationKnowledgeImportProgress({
    branch: params.branch,
    assertCurrent: params.source,
    signal: params.signal,
  });
  const after = await version();
  check();
  if (
    !before.version ||
    !after.version ||
    before.appendParentId === undefined ||
    !isDeepStrictEqual(before, after) ||
    imports.packets.size ||
    imports.checkpoints.length
  ) {
    return undefined;
  }
  return new PreparedConversationKnowledgeBootstrap(
    bootstrapIssuer,
    params.branch,
    before.version,
    before.appendParentId,
  );
}

/** Bounded cold-start proof; existing histories never fall back to an on-turn full scan. */
export async function prepareNewConversationKnowledgeBootstrap(params: {
  branch: ConversationKnowledgeBranch;
  admission?: TranscriptTurnAdmission;
  initialization?: ConversationKnowledgeBootstrapInitialization;
  source: SessionSourceAssertion;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<PreparedConversationKnowledgeBootstrap | undefined> {
  const { prepareSessionTranscriptHydration } = await import("./session-transcript-hydration.js");
  const check = () => {
    params.source();
    params.signal?.throwIfAborted();
  };
  const facts = async () => {
    check();
    const value = await prepareSessionTranscriptHydration(
      { ...params.branch, env: params.env },
      undefined,
      params.signal,
    ).readMaintenance({ operation: "version" });
    check();
    return value;
  };
  const before = await facts();
  if (
    !before.version?.generation ||
    before.appendParentId === undefined ||
    before.lifecycleRevision !== params.branch.lifecycleRevision
  ) {
    return undefined;
  }
  const page = await withSessionTranscriptDeltaReader(
    { ...params.branch, env: params.env },
    (reader) => reader.raw({ maxEvents: 5, maxBytes: 1_000_000 }),
    params.signal,
  );
  check();
  if (
    page.kind !== "page" ||
    page.hasMore ||
    page.requiredBytes !== undefined ||
    page.events.length < 1 ||
    page.events.length > 4
  ) {
    return undefined;
  }
  const header = asOptionalRecord(page.events[0]!.event);
  if (header?.type !== "session" || header.id !== params.branch.sessionId) {
    return undefined;
  }
  const expected = params.admission;
  let parent: string | null = null;
  let previousSeq = page.events[0]!.seq;
  let hasUser = false;
  let hasModel = false;
  let hasThinking = false;
  for (const row of page.events.slice(1)) {
    const event = asOptionalRecord(row.event);
    if (
      !event ||
      typeof event.id !== "string" ||
      event.parentId !== parent ||
      row.seq !== previousSeq + 1
    ) {
      return undefined;
    }
    if (event.type === "message") {
      if (
        hasUser ||
        !expected ||
        expected.agentId !== params.branch.agentId ||
        expected.sessionId !== params.branch.sessionId ||
        expected.sessionKey !== params.branch.sessionKey ||
        expected.storePath !== params.branch.storePath ||
        expected.generation !== before.version.generation ||
        expected.rawSeq !== row.seq ||
        event.id !== expected.entryId ||
        expected.effectiveParentId !== parent ||
        asOptionalRecord(event.message)?.role !== "user"
      ) {
        return undefined;
      }
      hasUser = true;
    } else if (event.type === "model_change") {
      if (
        !params.initialization ||
        hasModel ||
        hasThinking ||
        hasUser ||
        event.provider !== params.initialization.provider ||
        event.modelId !== params.initialization.modelId
      ) {
        return undefined;
      }
      hasModel = true;
    } else if (event.type === "thinking_level_change") {
      if (
        !params.initialization ||
        hasThinking ||
        event.thinkingLevel !== params.initialization.thinkingLevel
      ) {
        return undefined;
      }
      hasThinking = true;
    } else {
      return undefined;
    }
    parent = event.id;
    previousSeq = row.seq;
  }
  if (before.appendParentId !== parent || ((expected || hasModel || hasThinking) && !hasUser)) {
    return undefined;
  }
  const after = await facts();
  if (!isDeepStrictEqual(before, after) || before.version.rawSeq !== page.events.at(-1)!.seq) {
    return undefined;
  }
  return new PreparedConversationKnowledgeBootstrap(
    bootstrapIssuer,
    params.branch,
    before.version,
    before.appendParentId,
  );
}

/** Refresh only across the exact original input appended by this native user turn. */
export async function advanceConversationKnowledgeBootstrapInput(params: {
  branch: ConversationKnowledgeBranch;
  bootstrap: PreparedConversationKnowledgeBootstrap;
  admission: TranscriptTurnAdmission;
  source: SessionSourceAssertion;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<PreparedConversationKnowledgeBootstrap | undefined> {
  const before = params.bootstrap.version(params.branch);
  const { admission, branch } = params;
  const check = () => {
    params.source();
    params.signal?.throwIfAborted();
  };
  check();
  const { prepareSessionTranscriptHydration } = await import("./session-transcript-hydration.js");
  const current = await prepareSessionTranscriptHydration(
    { ...branch, env: params.env },
    undefined,
    params.signal,
  ).readMaintenance({ operation: "version" });
  check();
  if (isDeepStrictEqual(before, current.version)) {
    return params.bootstrap;
  }
  if (
    !before.generation ||
    before.rawSeq === null ||
    admission.agentId !== branch.agentId ||
    admission.sessionKey !== branch.sessionKey ||
    admission.sessionId !== branch.sessionId ||
    admission.storePath !== branch.storePath ||
    admission.generation !== before.generation ||
    admission.rawSeq !== before.rawSeq + 1 ||
    admission.effectiveParentId !== params.bootstrap.appendParentId(branch) ||
    current.version?.generation !== before.generation ||
    current.version.rawSeq !== admission.rawSeq ||
    current.appendParentId !== admission.entryId ||
    current.lifecycleRevision !== branch.lifecycleRevision
  ) {
    return undefined;
  }
  const page = await withSessionTranscriptDeltaReader(
    { ...branch, env: params.env },
    (reader) =>
      reader.raw({
        cursor: createTranscriptRawDeltaCursor({
          agentId: branch.agentId,
          sessionId: branch.sessionId,
          generation: before.generation!,
          lastSeq: before.rawSeq!,
        }),
        maxEvents: 2,
        maxBytes: 1_000_000,
      }),
    params.signal,
  );
  check();
  if (
    page.kind !== "page" ||
    page.requiredBytes !== undefined ||
    page.hasMore ||
    page.events.length !== 1
  ) {
    return undefined;
  }
  const row = page.events[0]!;
  const event = asOptionalRecord(row.event);
  if (
    row.seq !== admission.rawSeq ||
    event?.type !== "message" ||
    event.id !== admission.entryId ||
    event.parentId !== admission.effectiveParentId ||
    asOptionalRecord(event.message)?.role !== "user"
  ) {
    return undefined;
  }
  const after = await prepareSessionTranscriptHydration(
    { ...branch, env: params.env },
    undefined,
    params.signal,
  ).readMaintenance({ operation: "version" });
  check();
  if (!isDeepStrictEqual(current, after)) {
    return undefined;
  }
  return new PreparedConversationKnowledgeBootstrap(
    bootstrapIssuer,
    branch,
    current.version,
    admission.entryId,
  );
}

/** Called after native prospective budgeting; never rebases existing imported history. */
export async function retainConversationKnowledgeCheckpoint(params: {
  branch: ConversationKnowledgeBranch;
  checkpoint: ConversationKnowledgeCheckpoint;
  coverage: PreparedConversationKnowledgeCheckpointCoverage;
  audienceKey: string;
  availableReferences?: readonly ConversationKnowledgeReference[];
  selection?: PreparedConversationKnowledgeCheckpointSelection;
  manifest?: PreparedKnowledgeRootCandidates;
  rootEvidence?: NativeKnowledgeRootEvidence;
  writeTarget: SessionTranscriptRuntimeTarget &
    Pick<SessionTranscriptWriteScope, "expectedWriterRunId" | "expectedLifecycleRevision">;
  reader: SessionEntryCohortReader;
  /** Native background proof; any intervening append or compaction refuses commit. */
  bootstrap: PreparedConversationKnowledgeBootstrap;
  source: SessionSourceAssertion;
  signal?: AbortSignal;
  contextLimits?: { maxBytes: number; maxEvents: number };
}): Promise<{ accepted: boolean; appended: boolean; deferred: boolean; packetId?: string }> {
  const check = () => {
    params.signal?.throwIfAborted();
    params.source();
    params.reader.assertCurrent();
  };
  check();
  assertSessionEntryCohortScope(params.reader, params.writeTarget);
  if (
    params.writeTarget.agentId !== params.branch.agentId ||
    params.writeTarget.sessionKey !== params.branch.sessionKey ||
    params.writeTarget.sessionId !== params.branch.sessionId ||
    (params.writeTarget.expectedLifecycleRevision !== undefined &&
      params.writeTarget.expectedLifecycleRevision !== params.branch.lifecycleRevision)
  ) {
    throw new Error("Conversation checkpoint writer differs from its recipient");
  }
  const recipientVersion = params.bootstrap.version(params.branch);
  const checkpoint = params.selection
    ? PreparedConversationKnowledgeCheckpointSelection.read(params.selection, {
        ...params,
        manifest: params.manifest!,
        rootEvidence: params.rootEvidence!,
      })
    : selectConversationKnowledgeCheckpointBootstrap({
        ...params,
        availableReferences: params.availableReferences ?? [],
        progress: new Map(),
        hasCheckpointReceipt: false,
      });
  if (!checkpoint) {
    return { accepted: false, appended: false, deferred: false };
  }
  const predicate = await params.reader.withRead(
    { sessionKeys: [params.branch.sessionKey] },
    check,
    (facts): SessionSourcePredicate => {
      const recipient = facts.entries.find(
        (row) => row.sessionKey === params.branch.sessionKey,
      )?.entry;
      if (
        recipient?.sessionId !== params.branch.sessionId ||
        recipient.lifecycleRevision !== params.branch.lifecycleRevision
      ) {
        throw new Error("Conversation checkpoint recipient changed");
      }
      return {
        source: facts.source,
        sessionKey: params.branch.sessionKey,
        fields: ["sessionId", "lifecycleRevision", "conversationTopology"],
        expected: recipient,
      };
    },
  );
  const source = composeSessionSourceAssertion([
    params.source,
    Object.assign(check, {
      prepareSessionSource: async () => ({
        assertCurrent: check,
        checks: [
          {
            predicate,
            refuse: (): never => {
              throw new SessionTranscriptReadFenceError(
                "Checkpoint recipient changed before bootstrap commit",
              );
            },
          },
        ],
      }),
    }),
  ]);
  const report = createConversationKnowledgeCheckpointContext({
    checkpoint,
    branch: params.branch,
  });
  const result = await appendSessionTranscriptReportBatch(
    { ...params.writeTarget, expectedLifecycleRevision: params.branch.lifecycleRevision },
    [{ report, receipt: { field: "packetId", value: report.details.packetId } }],
    {
      source,
      // The native transaction compares before writing, not against this batch's own changed version.
      expectedTranscriptVersion: recipientVersion,
      ...(params.contextLimits
        ? { contextAdmission: { limits: params.contextLimits, onDeferred: () => {} } }
        : {}),
    },
  );
  check();
  if (!result.ok) {
    throw new Error("Conversation checkpoint admission was refused", { cause: result.error });
  }
  return {
    accepted: result.value.accepted === 1,
    appended: result.value.appended === 1,
    deferred: result.value.deferred,
    ...(result.value.accepted === 1 ? { packetId: report.details.packetId } : {}),
  };
}
