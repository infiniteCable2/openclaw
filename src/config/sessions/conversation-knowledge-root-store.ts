import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import {
  assertConversationBranchCreationRoot,
  type PreparedConversationBranchCreation,
} from "./conversation-branch-creation.js";
import { readConversationKnowledgeRootReports } from "./conversation-knowledge-history.js";
import {
  readConversationKnowledgeRootSnapshot,
  type ConversationKnowledgeRootContinuation,
} from "./conversation-knowledge-root-cache.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_UTTERANCE_REPORT,
  readConversationKnowledgeReceipt,
  readConversationUtteranceObservation,
  type ConversationKnowledgeReference,
} from "./conversation-knowledge.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import { assertSessionConversationRootEntry } from "./session-conversation-admission.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";

/** A held native root read attests saved provenance, never source-history permission.
 * Root report deletion is not a separate permission store: source/recipient,
 * explicit sharing and native incarnations still decide every disclosure.
 */
const rootEvidenceIssuer = Symbol("native-knowledge-root-read");
type ImmutableRootPayload = {
  readonly events: readonly TranscriptEvent[];
  readonly references: ReadonlyMap<string, ConversationKnowledgeReference>;
  readonly byKey: ReadonlyMap<string, TranscriptEvent>;
  readonly byteLength: number;
};
const sharedRootPayloads = new Map<string, WeakRef<ImmutableRootPayload>>();
const nativeRootPayloads = new WeakMap<object, ImmutableRootPayload>();
const parsedRootReferences = new WeakMap<object, ConversationKnowledgeReference | null>();
function referenceKey(reference: ConversationKnowledgeReference) {
  return JSON.stringify([
    reference.origin,
    reference.through.generation,
    reference.through.rawSeq,
    reference.through.entryId,
  ]);
}
/** Immutable root provenance is shared; native custody/permission remains caller-owned. */
function rootPayload(
  source: CapturedSessionEntryReadSource,
  branch: ConversationKnowledgeBranch,
  events: readonly TranscriptEvent[],
): ImmutableRootPayload {
  const nativeSnapshot = readConversationKnowledgeRootSnapshot(events);
  const nativePrevious = nativeSnapshot && nativeRootPayloads.get(nativeSnapshot);
  if (nativePrevious) {
    return nativePrevious;
  }
  const serialized = nativeSnapshot ? undefined : JSON.stringify(events);
  const key =
    serialized !== undefined && typeof source.databaseIdentity === "string"
      ? JSON.stringify([source, branch.agentId, branch.root, sha256Hex(serialized)])
      : undefined;
  const previous = key && sharedRootPayloads.get(key)?.deref();
  if (previous) {
    return previous;
  }
  const owned = nativeSnapshot?.events ?? freezeJsonSnapshot(structuredClone([...events]));
  const references = new Map<string, ConversationKnowledgeReference>();
  const byKey = new Map<string, TranscriptEvent>();
  for (const event of owned) {
    const row = asOptionalRecord(event);
    let reference = row && parsedRootReferences.get(row);
    if (reference === undefined) {
      reference =
        readConversationKnowledgeReceipt(row?.details) ??
        readConversationUtteranceObservation(row?.details) ??
        null;
      if (row) {
        parsedRootReferences.set(row, reference && freezeJsonSnapshot(reference));
      }
    }
    if (!reference) {
      continue;
    }
    const id = referenceKey(reference);
    references.set(id, freezeJsonSnapshot(reference));
    byKey.set(id, event);
  }
  const payload = Object.freeze({
    events: owned,
    references,
    byKey,
    byteLength: nativeSnapshot?.bytes ?? Buffer.byteLength(serialized!),
  });
  if (nativeSnapshot) {
    nativeRootPayloads.set(nativeSnapshot, payload);
  }
  if (key) {
    for (const [oldKey, value] of sharedRootPayloads) {
      if (!value.deref()) {
        sharedRootPayloads.delete(oldKey);
      }
    }
    sharedRootPayloads.set(key, new WeakRef(payload));
    while (sharedRootPayloads.size > 128) {
      sharedRootPayloads.delete(sharedRootPayloads.keys().next().value!);
    }
  }
  return payload;
}
const contributionGroupProofIssuer = Symbol("native-root-contribution-group");
class NativeKnowledgeRootContributionGroup {
  readonly #payload: ImmutableRootPayload;
  constructor(issuer: typeof contributionGroupProofIssuer, payload: ImmutableRootPayload) {
    if (issuer !== contributionGroupProofIssuer) {
      throw new Error("Contribution group requires native root evidence");
    }
    this.#payload = payload;
    Object.freeze(this);
  }
  static matches(
    proof: NativeKnowledgeRootContributionGroup,
    payload: ImmutableRootPayload,
  ): boolean {
    return #payload in proof && proof.#payload === payload;
  }
}
Object.freeze(NativeKnowledgeRootContributionGroup);
Object.freeze(NativeKnowledgeRootContributionGroup.prototype);
export type { NativeKnowledgeRootContributionGroup };
class NativeKnowledgeRootEvidence {
  #branch: ConversationKnowledgeBranch;
  #source: CapturedSessionEntryReadSource;
  #assertCurrent: SessionSourceAssertion;
  #payload: ImmutableRootPayload;

  constructor(
    issuer: typeof rootEvidenceIssuer,
    branch: ConversationKnowledgeBranch,
    source: CapturedSessionEntryReadSource,
    events: readonly TranscriptEvent[],
    assertCurrent: SessionSourceAssertion,
    payload?: ImmutableRootPayload,
  ) {
    if (issuer !== rootEvidenceIssuer) {
      throw new Error("Knowledge root evidence requires its native read owner");
    }
    this.#branch = structuredClone(branch);
    this.#source = structuredClone(source);
    this.#assertCurrent = assertCurrent;
    this.#payload = payload ?? rootPayload(source, branch, events);
    Object.freeze(this);
  }

  #key(reference: ConversationKnowledgeReference) {
    return referenceKey(reference);
  }

  static assertContribution(
    evidence: unknown,
    target: ConversationKnowledgeBranch,
    reference: ConversationKnowledgeReference,
  ): void {
    if (typeof evidence !== "object" || evidence === null || !(#branch in evidence)) {
      throw new Error("Personal contribution requires native root evidence");
    }
    evidence.#assertCurrent();
    if (
      target.agentId !== evidence.#branch.agentId ||
      target.storePath !== evidence.#branch.storePath ||
      !isDeepStrictEqual(target.root, evidence.#branch.root) ||
      !isDeepStrictEqual(evidence.#payload.references.get(evidence.#key(reference)), reference)
    ) {
      throw new Error("Personal contribution has no matching native root evidence");
    }
  }

  static prepareGroup(
    evidence: unknown,
    target: ConversationKnowledgeBranch,
    references: readonly ConversationKnowledgeReference[],
  ) {
    for (const reference of references) {
      NativeKnowledgeRootEvidence.assertContribution(evidence, target, reference);
    }
    if (!(evidence instanceof NativeKnowledgeRootEvidence)) {
      throw new Error("Contribution group requires native root evidence");
    }
    return new NativeKnowledgeRootContributionGroup(
      contributionGroupProofIssuer,
      evidence.#payload,
    );
  }
  static assertGroup(
    evidence: unknown,
    target: ConversationKnowledgeBranch,
    proof: NativeKnowledgeRootContributionGroup,
  ) {
    if (
      !(evidence instanceof NativeKnowledgeRootEvidence) ||
      !(proof instanceof NativeKnowledgeRootContributionGroup)
    ) {
      throw new Error("Contribution group requires native root evidence");
    }
    evidence.#assertCurrent();
    if (
      target.agentId !== evidence.#branch.agentId ||
      target.storePath !== evidence.#branch.storePath ||
      !isDeepStrictEqual(target.root, evidence.#branch.root) ||
      !NativeKnowledgeRootContributionGroup.matches(proof, evidence.#payload)
    ) {
      throw new Error("Prepared contribution group root changed");
    }
  }

  static prepareCandidates(
    evidence: unknown,
    references: readonly ConversationKnowledgeReference[],
    maxBytes: number,
    sharedMetadata = false,
  ): PreparedKnowledgeRootCandidates {
    if (typeof evidence !== "object" || evidence === null || !(#branch in evidence)) {
      throw new Error("Prepared contributions require native root evidence");
    }
    evidence.#assertCurrent();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("Prepared root candidates exceed their bounded manifest");
    }
    const events = new Map<string, TranscriptEvent>();
    for (const reference of references) {
      const key = evidence.#key(reference);
      if (!isDeepStrictEqual(evidence.#payload.references.get(key), reference)) {
        throw new Error("Prepared contribution has no matching native root evidence");
      }
      events.set(key, evidence.#payload.byKey.get(key)!);
    }
    evidence.#assertCurrent();
    return new PreparedKnowledgeRootCandidates(
      rootEvidenceIssuer,
      evidence.#branch,
      evidence.#source,
      [...events.values()],
      maxBytes,
      sharedMetadata,
    );
  }

  static rebindSubset(
    evidence: unknown,
    target: ConversationKnowledgeBranch,
    selected: {
      branch: ConversationKnowledgeBranch;
      source: CapturedSessionEntryReadSource;
      payload: ImmutableRootPayload;
    },
  ) {
    if (typeof evidence !== "object" || evidence === null || !(#branch in evidence)) {
      throw new Error("Prepared subset requires current native root evidence");
    }
    evidence.#assertCurrent();
    if (
      !isDeepStrictEqual(target, evidence.#branch) ||
      !isDeepStrictEqual(selected.branch, evidence.#branch) ||
      !isDeepStrictEqual(selected.source, evidence.#source)
    ) {
      throw new Error("Prepared subset root, physical source or recipient changed");
    }
    for (const reference of selected.payload.references.values()) {
      if (
        reference.retirement ||
        !isDeepStrictEqual(evidence.#payload.references.get(referenceKey(reference)), reference)
      ) {
        throw new Error("Prepared subset contains a changed or retired original");
      }
    }
    evidence.#assertCurrent();
    return {
      evidence: new NativeKnowledgeRootEvidence(
        rootEvidenceIssuer,
        target,
        evidence.#source,
        [],
        evidence.#assertCurrent,
        selected.payload,
      ),
      scopeKey: JSON.stringify([evidence.#source, evidence.#branch]),
    };
  }
}
Object.freeze(NativeKnowledgeRootEvidence);
Object.freeze(NativeKnowledgeRootEvidence.prototype);

export type { NativeKnowledgeRootEvidence };

/** Immutable native provenance only. No reader, execution lease or disclosure grant is retained. */
class PreparedKnowledgeRootCandidates {
  #branch: ConversationKnowledgeBranch;
  #source: CapturedSessionEntryReadSource;
  #payload: ImmutableRootPayload;
  #byteLength: number;

  constructor(
    issuer: typeof rootEvidenceIssuer,
    branch: ConversationKnowledgeBranch,
    source: CapturedSessionEntryReadSource,
    events: readonly TranscriptEvent[],
    maxBytes: number,
    sharedMetadata = false,
  ) {
    if (issuer !== rootEvidenceIssuer) {
      throw new Error("Prepared contributions require their native root issuer");
    }
    this.#branch = structuredClone(branch);
    this.#source = structuredClone(source);
    this.#payload = rootPayload(source, branch, events);
    this.#byteLength = Buffer.byteLength(
      JSON.stringify({ branch: this.#branch, source: this.#source }),
    );
    if (this.#byteLength + (sharedMetadata ? 0 : this.#payload.byteLength) > maxBytes) {
      throw new RangeError("Prepared root candidates exceed their bounded manifest");
    }
    Object.freeze(this);
  }

  get byteLength(): number {
    return this.#byteLength + this.#payload.byteLength;
  }
  get ownedByteLength(): number {
    return this.#byteLength;
  }

  static subset(
    this: void,
    params: {
      evidence: NativeKnowledgeRootEvidence | undefined;
      branch: ConversationKnowledgeBranch;
    } & (
      | { manifest: PreparedKnowledgeRootCandidates }
      | { references: readonly ConversationKnowledgeReference[]; maxBytes: number }
    ),
  ) {
    const manifest =
      "manifest" in params
        ? params.manifest
        : NativeKnowledgeRootEvidence.prepareCandidates(
            params.evidence,
            params.references,
            params.maxBytes,
            true,
          );
    if (typeof manifest !== "object" || manifest === null || !(#payload in manifest)) {
      throw new Error("Prepared subset requires a native candidate manifest");
    }
    return {
      manifest,
      ...NativeKnowledgeRootEvidence.rebindSubset(params.evidence, params.branch, {
        branch: manifest.#branch,
        source: manifest.#source,
        payload: manifest.#payload,
      }),
    };
  }

  static async evidence(params: KnowledgeRootReadParams & { manifest: unknown }) {
    const { manifest } = params;
    if (typeof manifest !== "object" || manifest === null || !(#branch in manifest)) {
      throw new Error("Prepared contributions require a native candidate manifest");
    }
    const check = () => {
      params.signal?.throwIfAborted();
      params.reader.assertCurrent();
      params.assertCurrent();
    };
    check();
    if (
      params.branch.agentId !== manifest.#branch.agentId ||
      params.branch.storePath !== manifest.#branch.storePath ||
      params.branch.sessionKey !== manifest.#branch.sessionKey ||
      params.branch.sessionId !== manifest.#branch.sessionId ||
      params.branch.lifecycleRevision !== manifest.#branch.lifecycleRevision ||
      !isDeepStrictEqual(params.branch.root, manifest.#branch.root)
    ) {
      throw new Error("Prepared conversation root or recipient changed");
    }
    const source = await readValidatedKnowledgeRootSource(params);
    check();
    if (!isDeepStrictEqual(source, manifest.#source)) {
      throw new Error("Prepared conversation root physical source changed");
    }
    return new NativeKnowledgeRootEvidence(
      rootEvidenceIssuer,
      params.branch,
      source,
      [],
      check,
      manifest.#payload,
    );
  }
  static async read(params: KnowledgeRootReadParams & { manifest: unknown }) {
    const evidence = await PreparedKnowledgeRootCandidates.evidence(params);
    const { manifest } = params;
    if (typeof manifest !== "object" || manifest === null || !(#payload in manifest)) {
      throw new Error("Prepared contributions require a native candidate manifest");
    }
    const events: TranscriptEvent[] & { evidence?: NativeKnowledgeRootEvidence } = [
      ...manifest.#payload.events,
    ];
    Object.defineProperty(events, "evidence", { value: evidence });
    return events;
  }
}
Object.freeze(PreparedKnowledgeRootCandidates);
Object.freeze(PreparedKnowledgeRootCandidates.prototype);
export type { PreparedKnowledgeRootCandidates };

/** Reuse one immutable native subset only while every original remains in the current full selection. */
export const prepareConversationKnowledgeRootSubset = PreparedKnowledgeRootCandidates.subset;

export function prepareNativeKnowledgeRootContributionGroup(
  evidence: unknown,
  target: ConversationKnowledgeBranch,
  references: readonly ConversationKnowledgeReference[],
) {
  return NativeKnowledgeRootEvidence.prepareGroup(evidence, target, references);
}
export function assertNativeKnowledgeRootContributionGroup(
  evidence: unknown,
  target: ConversationKnowledgeBranch,
  proof: NativeKnowledgeRootContributionGroup,
): void {
  NativeKnowledgeRootEvidence.assertGroup(evidence, target, proof);
}

/** Select exact immutable receipt wrappers while the original native root read is still current. */
export function issuePreparedKnowledgeRootCandidates(
  evidence: unknown,
  references: readonly ConversationKnowledgeReference[],
  options: { maxBytes: number; sharedMetadata?: boolean },
): PreparedKnowledgeRootCandidates {
  return NativeKnowledgeRootEvidence.prepareCandidates(
    evidence,
    references,
    options.maxBytes,
    options.sharedMetadata,
  );
}

/** Rebind provenance to a fresh recipient read; actual source/audience grants remain separate. */
export function readPreparedConversationKnowledgeRoot(
  params: KnowledgeRootReadParams & { manifest: PreparedKnowledgeRootCandidates },
) {
  return PreparedKnowledgeRootCandidates.read(params);
}

/** Rebind only native provenance custody; ready admission never copies the historical payload. */
export function readPreparedConversationKnowledgeRootEvidence(
  params: KnowledgeRootReadParams & { manifest: PreparedKnowledgeRootCandidates },
): Promise<NativeKnowledgeRootEvidence> {
  return PreparedKnowledgeRootCandidates.evidence(params);
}

/** Validate through the native class brand, never through an overridable object method. */
export function assertNativeKnowledgeRootContribution(
  evidence: unknown,
  target: ConversationKnowledgeBranch,
  reference: ConversationKnowledgeReference,
): void {
  NativeKnowledgeRootEvidence.assertContribution(evidence, target, reference);
}

type KnowledgeRootReadParams = {
  branch: ConversationKnowledgeBranch;
  reader: SessionEntryCohortReader;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
  rootContinuation?: ConversationKnowledgeRootContinuation;
  /** Actual native absent-to-created recipient, never a caller's allow-missing flag. */
  creation?: PreparedConversationBranchCreation;
};

/** Both full reads and prepared candidates use the same native enrollment checks. */
async function readValidatedKnowledgeRootSource(params: KnowledgeRootReadParams) {
  const { branch, reader, assertCurrent, signal } = params;
  signal?.throwIfAborted();
  return reader.withRead(
    { sessionKeys: [branch.sessionKey, branch.root.sessionKey] },
    assertCurrent,
    (read) => {
      signal?.throwIfAborted();
      const current = read.entries.find((row) => row.sessionKey === branch.sessionKey)?.entry;
      const root = read.entries.find((row) => row.sessionKey === branch.root.sessionKey)?.entry;
      assertSessionConversationRootEntry(root, branch.root.sessionKey);
      if (params.creation) {
        assertConversationBranchCreationRoot({
          creation: params.creation,
          branch,
          source: read.source,
          currentEntry: current,
          rootEntry: root,
        });
        return structuredClone(read.source);
      }
      if (
        current?.sessionId !== branch.sessionId ||
        current.lifecycleRevision !== branch.lifecycleRevision ||
        root.sessionId !== branch.root.sessionId ||
        root.lifecycleRevision !== branch.root.lifecycleRevision ||
        current.conversationTopology?.role !== "branch" ||
        current.conversationTopology.rootSessionKey !== branch.root.sessionKey ||
        current.conversationTopology.rootSessionId !== root.sessionId ||
        current.conversationTopology.rootSessionLifecycleRevision !== root.lifecycleRevision
      ) {
        throw new Error("Conversation knowledge root changed");
      }
      return structuredClone(read.source);
    },
  );
}

function attachNativeKnowledgeRootEvidence(
  branch: ConversationKnowledgeBranch,
  source: CapturedSessionEntryReadSource,
  events: TranscriptEvent[],
  assertCurrent: SessionSourceAssertion,
  payload?: ImmutableRootPayload,
) {
  const result: TranscriptEvent[] & { evidence?: NativeKnowledgeRootEvidence } = events;
  Object.defineProperty(result, "evidence", {
    value: new NativeKnowledgeRootEvidence(
      rootEvidenceIssuer,
      branch,
      source,
      result,
      assertCurrent,
      payload,
    ),
  });
  return result;
}

/** Host reads only opaque receipt references from its infrastructure root, never source dialogue. */
export async function readConversationKnowledgeRoot(params: KnowledgeRootReadParams) {
  const { branch, assertCurrent, signal } = params;
  const originalSource = await readValidatedKnowledgeRootSource(params);
  assertCurrent();
  const result = await readConversationKnowledgeRootReports({
    target: { ...branch, ...branch.root },
    customTypes: [CONVERSATION_KNOWLEDGE_REPORT, CONVERSATION_UTTERANCE_REPORT],
    assertCurrent,
    signal,
    source: originalSource,
    lifecycleRevision: branch.root.lifecycleRevision,
    continuation: params.rootContinuation,
    revalidate: async () => {
      if (!isDeepStrictEqual(originalSource, await readValidatedKnowledgeRootSource(params))) {
        throw new Error("Conversation knowledge root physical source changed");
      }
    },
  });
  assertCurrent();
  return attachNativeKnowledgeRootEvidence(branch, originalSource, result, assertCurrent);
}
