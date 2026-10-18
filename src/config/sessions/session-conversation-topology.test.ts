import { describe, expect, it } from "vitest";
import { resolveReplySessionRolloverState } from "../../auto-reply/reply/session-rollover-state.js";
import {
  clearGenerationPrivateFieldsForRotatedSessionPatch,
  generationValidPrivateFieldsForSameSession,
} from "../../plugin-sdk/session-store-runtime-internal.js";
import {
  captureSessionConversationTopology,
  mergeSessionConversationTopology,
  preserveSessionConversationTopology,
  resolveConversationModelRunError,
  type SessionConversationTopology,
} from "./session-conversation-topology.js";
import {
  projectPublicSessionEntry,
  projectPublicSessionEntryPatch,
  SESSION_ENTRY_PRIVATE_CLEAR_PATCH,
} from "./session-entry-projection.js";
import { mergeSessionEntry, type InternalSessionEntry } from "./types.js";

const topology: SessionConversationTopology = {
  version: 1,
  role: "branch",
  rootSessionKey: "agent:example:main",
  rootSessionId: "root-original",
  rootSessionLifecycleRevision: "root-lifecycle-original",
};
const entry: InternalSessionEntry = {
  sessionId: "branch-original",
  lifecycleRevision: "branch-lifecycle-original",
  updatedAt: 1,
  conversationTopology: topology,
};

describe("internal conversation topology", () => {
  it("reserves roots for consolidation without changing ordinary model admission", () => {
    expect(
      resolveConversationModelRunError({
        sessionId: "root-session",
        updatedAt: 1,
        conversationTopology: { version: 1, role: "root" },
      }),
    ).toContain("cannot run model work");
    expect(resolveConversationModelRunError(entry)).toBeUndefined();
    expect(
      resolveConversationModelRunError({ sessionId: "native-session", updatedAt: 1 }),
    ).toBeUndefined();
    expect(resolveConversationModelRunError(undefined)).toBeUndefined();
  });

  it("captures only the relationship, never authority or implied membership", () => {
    expect(captureSessionConversationTopology(undefined)).toBeUndefined();
    expect(captureSessionConversationTopology({ version: 1, role: "root" })).toEqual({
      version: 1,
      role: "root",
    });
    const captured = captureSessionConversationTopology(topology);
    expect(captured).toEqual(topology);
    expect(captured).not.toBe(topology);
    expect(preserveSessionConversationTopology(undefined)).toEqual({
      conversationTopology: undefined,
    });
    expect(preserveSessionConversationTopology({})).toEqual({ conversationTopology: undefined });
  });

  it.each([
    null,
    { version: 2, role: "root" },
    { version: 1, role: "root", permissionMode: "full" },
    { ...topology, rootSessionKey: " " },
    { ...topology, rootSessionId: " root-original" },
    { ...topology, rootSessionLifecycleRevision: undefined },
    { ...topology, spawnedBy: "agent:example:main" },
  ])("rejects malformed or expanded metadata %j", (value) => {
    expect(() => captureSessionConversationTopology(value)).toThrow("Invalid internal");
  });

  it("retains the same node's binding without changing its pinned root incarnation", () => {
    const merged: InternalSessionEntry = mergeSessionEntry(entry, { label: "New title" });
    expect(merged.conversationTopology).toEqual(topology);
    expect(merged.conversationTopology).not.toBe(topology);
    expect(() =>
      mergeSessionConversationTopology(entry, {
        conversationTopology: { ...topology, rootSessionId: "replacement-root" },
      }),
    ).toThrow("cannot rebind");
    expect(() => mergeSessionConversationTopology({}, { conversationTopology: topology })).toThrow(
      "requires explicit topology admission",
    );
    expect(
      resolveReplySessionRolloverState(entry, "agent:example:matrix:direct:peer"),
    ).toMatchObject({ conversationTopology: topology });
    expect(merged.spawnedBy).toBeUndefined();
    expect(merged.parentSessionKey).toBeUndefined();
    expect(merged.forkSource).toBeUndefined();
  });

  it("strips public copies and honors public rotation clear instead of global preservation", () => {
    expect(projectPublicSessionEntry(entry)).not.toHaveProperty("conversationTopology");
    expect(projectPublicSessionEntryPatch(entry)).not.toHaveProperty("conversationTopology");
    const rotated = clearGenerationPrivateFieldsForRotatedSessionPatch(entry, {
      sessionId: "different-session",
    });
    const replacement: InternalSessionEntry = mergeSessionEntry(entry, rotated);
    expect(replacement.conversationTopology).toBeUndefined();
    expect(
      generationValidPrivateFieldsForSameSession(entry, entry.sessionId, entry.lifecycleRevision),
    ).toMatchObject({ conversationTopology: topology });
    expect(
      generationValidPrivateFieldsForSameSession(
        entry,
        "different-session",
        entry.lifecycleRevision,
      ),
    ).toBeUndefined();
    expect(
      generationValidPrivateFieldsForSameSession(entry, entry.sessionId, "different-lifecycle"),
    ).toBeUndefined();
    const recreated: InternalSessionEntry = mergeSessionEntry(undefined, {
      ...entry,
      ...SESSION_ENTRY_PRIVATE_CLEAR_PATCH,
      sessionId: "unrelated-node",
    });
    expect(recreated.conversationTopology).toBeUndefined();
    const publicCopy: InternalSessionEntry = mergeSessionEntry(undefined, {
      ...projectPublicSessionEntry(entry),
      sessionId: "new-key-task",
      spawnedBy: "agent:example:matrix:direct:peer",
    });
    expect(publicCopy.conversationTopology).toBeUndefined();
    expect(projectPublicSessionEntry(entry).sessionId).toBe(entry.sessionId);
  });
});
