import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import { createSessionEntryWithTranscriptInScope } from "./session-accessor.sqlite-creation.js";
import {
  captureLifecycleDatabaseScope,
  withPreparedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import type {
  SessionAccessScope,
  SessionEntryCreateWithTranscriptContext,
  SessionEntryCreateWithTranscriptResult,
  SessionEntryCreateWithTranscriptPrepareResult,
  SessionEntryCreateWithTranscriptOptions,
} from "./session-accessor.types.js";
import { createSessionActorEntryWithTranscriptInScope } from "./session-actor-entry-adapter.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

type PrepareEntry<TError> = (
  context: SessionEntryCreateWithTranscriptContext,
) =>
  | Promise<SessionEntryCreateWithTranscriptPrepareResult<TError>>
  | SessionEntryCreateWithTranscriptPrepareResult<TError>;

/** Creation shares one storage/admission owner, including infrastructure-only absent claims. */
async function createEntryWithTranscript<TError>(
  scope: SessionAccessScope,
  createEntry: PrepareEntry<TError>,
  options: SessionEntryCreateWithTranscriptOptions,
  requireAbsent: boolean,
): Promise<SessionEntryCreateWithTranscriptResult<TError>> {
  if (requireAbsent && captureMemoryExactSessionReader(scope, () => {})) {
    throw new Error("Absent-only session creation requires its durable worker owner");
  }
  const memory = await createSessionActorEntryWithTranscriptInScope(scope, createEntry, options);
  if (memory) {
    return memory;
  }
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const storePath = resolveSessionStorePathForScope(captured);
  const agentId = captured.agentId ?? resolveAgentIdFromSessionKey(captured.sessionKey);
  const target = { ...captured, agentId, storePath };
  return withPreparedSqliteScope(target, (prepared) =>
    createSessionEntryWithTranscriptInScope(
      captureLifecycleDatabaseScope(prepared),
      createEntry,
      options,
      requireAbsent,
    ),
  );
}

/** Creates or updates one entry and its transcript through the native lifecycle owner. */
export function createSessionEntryWithTranscript<TError = string>(
  scope: SessionAccessScope,
  createEntry: PrepareEntry<TError>,
  options: SessionEntryCreateWithTranscriptOptions = {},
): Promise<SessionEntryCreateWithTranscriptResult<TError>> {
  return createEntryWithTranscript(scope, createEntry, options, false);
}

/** Host infrastructure may create an absent durable row, never replace a concurrent claim. */
export function createSessionEntryWithTranscriptIfAbsent<TError = string>(
  scope: SessionAccessScope,
  createEntry: PrepareEntry<TError>,
  options: SessionEntryCreateWithTranscriptOptions = {},
): Promise<SessionEntryCreateWithTranscriptResult<TError>> {
  return createEntryWithTranscript(scope, createEntry, options, true);
}
