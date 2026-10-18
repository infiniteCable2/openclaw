import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { kickSessionHistoryDiskBudgetMaintenance } from "./session-history-eviction.js";

export async function withCommittedHistoryMaintenance<T>(
  { agentId, env, storePath }: { agentId?: string; env?: NodeJS.ProcessEnv; storePath: string },
  run: (
    recordCommit: (database: OpenClawAgentDatabase) => void,
    markCommitted: () => void,
  ) => Promise<T>,
  options: { scheduleNext?: boolean } = {},
): Promise<T> {
  let committed = false;
  try {
    return await run(
      (database) => {
        deferOpenClawAgentPostCommitPublication(database, () => {
          committed = true;
        });
      },
      () => {
        committed = true;
      },
    );
  } finally {
    // A partial commit still needs maintenance, but only after archive publication and
    // lifecycle-owner cleanup finish. Rejected preparation or rollback creates no pressure.
    if (committed && options.scheduleNext !== false) {
      kickSessionHistoryDiskBudgetMaintenance({ agentId, env, storePath, force: true });
    }
  }
}
