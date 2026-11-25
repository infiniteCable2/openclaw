import { snapshotConversationKnowledgeProgress } from "../../config/sessions/conversation-knowledge-checkpoint-context.js";
import type {
  ConversationKnowledgeImportProgress,
  ConversationKnowledgePacketProgress,
} from "../../config/sessions/conversation-knowledge-packets.js";
import type { PreparedKnowledgeRootCandidates } from "../../config/sessions/conversation-knowledge-store.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-transcript-context-version.types.js";
import type { SessionTranscriptMaintenanceCheckpoint } from "../../config/sessions/session-transcript-hydration.types.js";

export type ConversationKnowledgeProgressBase = {
  point: SessionTranscriptMaintenanceCheckpoint;
  imports: ConversationKnowledgeImportProgress;
};

/** Reserve the disposable raw receipt base and its snapshot under the existing input budget. */
export function prepareConversationKnowledgeProgressInput(params: {
  version: SessionTranscriptContextVersion;
  manifest: PreparedKnowledgeRootCandidates;
  progress: ReadonlyMap<string, ConversationKnowledgePacketProgress>;
  epoch: number;
  base?: ConversationKnowledgeProgressBase;
  reserve(additional: number): boolean;
}) {
  const { version, manifest, progress, epoch, base, reserve } = params;
  const snapshot = snapshotConversationKnowledgeProgress(progress);
  const size =
    manifest.byteLength + Buffer.byteLength(JSON.stringify(version)) + snapshot.byteLength;
  // Charge a second packet map conservatively without traversing it again.
  const baseSize = base
    ? snapshot.byteLength +
      Buffer.byteLength(JSON.stringify([base.point, base.imports.checkpoints]))
    : 0;
  const keepBase = base && reserve(size + baseSize);
  if (!keepBase && !reserve(size)) {
    return undefined;
  }
  return {
    version: structuredClone(version),
    manifest,
    progress: snapshot.progress,
    epoch,
    ...(keepBase ? { base } : {}),
    bytes: size + (keepBase ? baseSize : 0),
  };
}
