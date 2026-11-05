import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  decodeGatewayOperatorRecoverySnapshot,
  type OperatorRunRecoverySnapshot,
} from "../../gateway/operator-run-recovery-source.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import { patchSessionEntryInWorker } from "./session-entry-patch.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import type { SessionSourceAssertion, SessionSourcePredicate } from "./session-source-authority.js";
import type { InternalSessionEntry } from "./types.js";

/** Original admitted principal metadata, never a persisted permission or input credential. */
export type ConversationRecipientRestartSource = Readonly<{
  kind: "operator";
  snapshot: OperatorRunRecoverySnapshot;
}>;

export type ConversationRecipientEnrollment = Readonly<{
  version: 1;
  lifetime: "reusable";
  branch: ConversationKnowledgeBranch;
  source: ConversationRecipientRestartSource;
}>;

const identity = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value === value.trim());
const schema = z.strictObject({
  version: z.literal(1),
  lifetime: z.literal("reusable"),
  branch: z.strictObject({
    agentId: identity,
    sessionKey: identity,
    sessionId: identity,
    lifecycleRevision: identity,
    storePath: identity,
    root: z.strictObject({
      sessionKey: identity,
      sessionId: identity,
      lifecycleRevision: identity,
    }),
  }),
  source: z.strictObject({ kind: z.literal("operator"), snapshot: z.unknown() }),
});

/** Decode exact custody metadata; historical origin/rosters cannot supply missing fields. */
export function captureConversationRecipientEnrollment(
  value: unknown,
): ConversationRecipientEnrollment | undefined {
  if (value === undefined) {
    return undefined;
  }
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json, "utf8") > 131_072) {
    throw new Error("Conversation recipient enrollment exceeds its storage bound");
  }
  const parsed = schema.parse(value);
  return freezeJsonSnapshot({
    ...parsed,
    source: {
      kind: "operator",
      snapshot: decodeGatewayOperatorRecoverySnapshot(parsed.source.snapshot),
    },
  });
}

const fields = [
  "sessionId",
  "lifecycleRevision",
  "conversationTopology",
  "visibility",
  "chatType",
  "incognito",
  "publicShare",
  "archivedAt",
  "createdActor",
  "owner",
  "participants",
  "participantCount",
  "conversationRecipientEnrollment",
] as const satisfies readonly (keyof InternalSessionEntry)[];

/** Only a genuine current private opening/turn enrolls; background reads never call this owner. */
export async function retainConversationRecipientEnrollment(params: {
  reader: SessionEntryCohortReader;
  branch: ConversationKnowledgeBranch;
  audience: ConversationPrivateAudience;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
}): Promise<void> {
  const { reader, branch, audience } = params;
  const restart = audience.restartSource;
  if (!restart) {
    return;
  }
  const check = () => {
    params.signal?.throwIfAborted();
    reader.assertCurrent();
    params.assertCurrent();
    audience.assertCurrent();
    if (
      reader.sessionKey !== branch.sessionKey ||
      reader.logicalAgentId !== branch.agentId ||
      audience.agentId !== branch.agentId ||
      audience.sessionKey !== branch.sessionKey ||
      audience.participant.type !== "profile" ||
      audience.participant.id !== restart.snapshot.profileId
    ) {
      throw new Error("Conversation recipient enrollment lost its original private audience");
    }
  };
  check();
  const enrollment = captureConversationRecipientEnrollment({
    version: 1,
    lifetime: "reusable",
    branch,
    source: restart,
  })!;
  const captured = await reader.withRead(
    { sessionKeys: [branch.sessionKey, branch.root.sessionKey], includeMembers: true },
    check,
    (read) => {
      const entry = read.entries.find((row) => row.sessionKey === branch.sessionKey)?.entry;
      const root = read.entries.find((row) => row.sessionKey === branch.root.sessionKey)?.entry;
      const topology = entry?.conversationTopology;
      if (
        read.source.path !== branch.storePath ||
        entry?.sessionId !== branch.sessionId ||
        entry.lifecycleRevision !== branch.lifecycleRevision ||
        topology?.role !== "branch" ||
        topology.rootSessionKey !== branch.root.sessionKey ||
        topology.rootSessionId !== branch.root.sessionId ||
        topology.rootSessionLifecycleRevision !== branch.root.lifecycleRevision ||
        root?.sessionId !== branch.root.sessionId ||
        root.lifecycleRevision !== branch.root.lifecycleRevision ||
        root.conversationTopology?.role !== "root"
      ) {
        throw new Error("Conversation recipient enrollment changed incarnation");
      }
      // Enrollment is optional for a valid current endpoint. Unsupported privacy
      // never promotes a shared conversation or aborts its admitted foreground turn.
      if (
        entry.visibility !== "draft" ||
        entry.chatType !== "direct" ||
        entry.incognito ||
        entry.publicShare !== undefined ||
        entry.archivedAt !== undefined
      ) {
        return undefined;
      }
      return {
        unchanged: isDeepStrictEqual(entry.conversationRecipientEnrollment, enrollment),
        predicates: [branch.sessionKey, branch.root.sessionKey].map(
          (sessionKey): SessionSourcePredicate => ({
            source: read.source,
            sessionKey,
            fields: [...fields],
            expected: structuredClone(sessionKey === branch.sessionKey ? entry : root),
            members: read.members?.[sessionKey]?.map((member) => member.identityId) ?? [],
          }),
        ),
      };
    },
  );
  check();
  if (!captured || captured.unchanged) {
    return;
  }
  await patchSessionEntryInWorker({
    database: reader.database,
    agentId: branch.agentId,
    selection: { kind: "entry", sessionKey: branch.sessionKey, exact: true },
    assertCurrent: check,
    guard: { assertCurrent: check },
    preparedSource: {
      assertCurrent: check,
      checks: captured.predicates.map((predicate) => ({
        predicate,
        refuse(): never {
          throw new Error("Conversation recipient enrollment changed before commit");
        },
      })),
    },
    async prepare(prepared) {
      check();
      const entry = prepared[0]?.entry;
      if (!entry || entry.sessionId !== branch.sessionId) {
        throw new Error("Conversation recipient enrollment target disappeared");
      }
      return {
        selection: { kind: "entry", sessionKey: branch.sessionKey, exact: true },
        prepared,
        sessionKey: branch.sessionKey,
        writeBase: entry,
        next: { ...entry, conversationRecipientEnrollment: enrollment },
        operationLabel: "session-entry.patch",
        validateCanonicalKeys: true,
      };
    },
  });
}
