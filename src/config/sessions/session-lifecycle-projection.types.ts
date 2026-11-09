import type { MaterializedSessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type {
  ProjectedLifecycleCommitInput,
  ProjectedLifecycleCommitResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type {
  SessionSourcePredicate,
  SessionSourceValidation,
  SessionSourceTransactionGrant,
} from "./session-source-authority.js";

export type SessionLifecycleProjectionCommit = ProjectedLifecycleCommitInput & {
  creationSource?: Omit<SessionSourceTransactionGrant, "assertCurrent">;
  sources?: SessionSourcePredicate[];
  agentId: string;
  removalPlans: MaterializedSessionStateDeletePlan[];
};

export type SessionLifecycleProjectionCommitted = {
  sourceValidation?: SessionSourceValidation;
  kind: "session-lifecycle-projection";
  result: ProjectedLifecycleCommitResult;
  progressCardResetKeys: string[];
  projectionReconcileSessionIds: string[];
  publication: SessionEntryReplacementPublication;
};
