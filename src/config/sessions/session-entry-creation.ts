import { isMainThread } from "node:worker_threads";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createSessionEntryWithTranscriptInScope } from "./session-accessor.sqlite-creation.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
  prepareSqliteScope,
  resolveSqliteWriteAdmissionScope,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import type {
  SessionAccessScope,
  SessionEntryCreateWithTranscriptContext,
  SessionEntryCreateWithTranscriptResult,
  SessionEntryCreateWithTranscriptPrepareResult,
  SessionEntryCreateWithTranscriptOptions,
} from "./session-accessor.types.js";
import { captureIncognitoSessionBinding } from "./session-incognito-binding.js";
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
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const storePath = resolveSessionStorePathForScope(captured);
  const agentId = captured.agentId ?? resolveAgentIdFromSessionKey(captured.sessionKey);
  const target = { ...captured, agentId, storePath };
  const incognito = captureIncognitoSessionBinding(target);
  // A sibling's cold registration must not invalidate discovery of this same store.
  // Release admission before creation callbacks acquire their own commit custody.
  const admission =
    isMainThread && !incognito ? resolveSqliteWriteAdmissionScope(target) : undefined;
  const prepare = async () => {
    const resolved = await prepareSqliteScope(target);
    if (admission && resolved.path !== admission.path) {
      throw new Error("Session creation preparation changed its reserved database path");
    }
    return resolved;
  };
  const resolved = captureLifecycleDatabaseScope(
    isMainThread && !incognito
      ? admission
        ? await runExclusiveSqliteSessionWrite(
            admission,
            prepare,
            "session.entry.create-with-transcript",
          )
        : await prepare()
      : resolveSqliteScope(target),
  );
  return createSessionEntryWithTranscriptInScope(resolved, createEntry, options, requireAbsent);
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
