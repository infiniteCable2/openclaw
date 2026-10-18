import type {
  SubagentMaintenanceDurableBasis,
  SubagentRunsDurableBasis,
} from "../../agents/subagents/registry/subagent-registry-read.types.js";
import type { MaterializedSessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type {
  ProjectedLifecycleCommitInput,
  ProjectedLifecycleCommitResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type {
  SessionSourcePredicate,
  SessionSourceValidation,
} from "./session-source-authority.js";

export type SessionLifecycleProjectionCommit = ProjectedLifecycleCommitInput & {
  sources?: SessionSourcePredicate[];
  agentId: string;
  removalPlans: MaterializedSessionStateDeletePlan[];
  descendantRunBasis?: SubagentRunsDurableBasis;
  maintenanceRunBasis?: SubagentMaintenanceDurableBasis;
};

export type SessionLifecycleProjectionCommitted = {
  sourceValidation?: SessionSourceValidation;
  kind: "session-lifecycle-projection";
  result: ProjectedLifecycleCommitResult;
  progressCardResetKeys: string[];
  projectionReconcileSessionIds: string[];
  publication: SessionEntryReplacementPublication;
};
