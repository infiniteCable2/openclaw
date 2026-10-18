import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { InternalSessionEntry } from "./types.js";

/** Conversation membership is data, never parent/spawn, identity, or history-read authority. */
export type SessionConversationTopology =
  | { version: 1; role: "root" }
  | {
      version: 1;
      role: "branch";
      rootSessionKey: string;
      rootSessionId: string;
      rootSessionLifecycleRevision: string;
    };

type ConversationTopologyEntry = { conversationTopology?: SessionConversationTopology };

/** Roots consolidate knowledge; model dispatch is a branch responsibility, even for internal work. */
export function resolveConversationModelRunError(
  entry: InternalSessionEntry | null | undefined,
): string | undefined {
  return entry?.conversationTopology?.role === "root"
    ? "A consolidating conversation root cannot run model work. Select a conversation branch or an independent task session."
    : undefined;
}

/** Validate persisted shape without resolving aliases or silently rebinding a root incarnation. */
export function captureSessionConversationTopology(
  value: unknown,
): SessionConversationTopology | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isRecord(value) && value.version === 1) {
    if (value.role === "root" && Object.keys(value).length === 2) {
      return { version: 1, role: "root" };
    }
    if (
      value.role === "branch" &&
      Object.keys(value).length === 5 &&
      isExactIdentity(value.rootSessionKey) &&
      isExactIdentity(value.rootSessionId) &&
      isExactIdentity(value.rootSessionLifecycleRevision)
    ) {
      return {
        version: 1,
        role: "branch",
        rootSessionKey: value.rootSessionKey,
        rootSessionId: value.rootSessionId,
        rootSessionLifecycleRevision: value.rootSessionLifecycleRevision,
      };
    }
  }
  throw new Error("Invalid internal conversation topology");
}

function isExactIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

/** Native same-node resets retain only the target's own membership, including its absence. */
export function preserveSessionConversationTopology(
  current: ConversationTopologyEntry | undefined,
): ConversationTopologyEntry {
  return {
    conversationTopology: captureSessionConversationTopology(current?.conversationTopology),
  };
}

/** Ordinary merges retain membership; an explicit private-clear patch still removes it. */
export function mergeSessionConversationTopology(
  current: ConversationTopologyEntry | undefined,
  patch: ConversationTopologyEntry,
): ConversationTopologyEntry {
  const previous = captureSessionConversationTopology(current?.conversationTopology);
  if (!Object.hasOwn(patch, "conversationTopology")) {
    return previous ? { conversationTopology: previous } : {};
  }
  const selected = captureSessionConversationTopology(patch.conversationTopology);
  if (current && !previous && selected) {
    throw new Error("An existing unmarked conversation requires explicit topology admission");
  }
  if (previous && selected && JSON.stringify(previous) !== JSON.stringify(selected)) {
    throw new Error("An existing conversation cannot rebind its topology through a merge");
  }
  return { conversationTopology: selected };
}
