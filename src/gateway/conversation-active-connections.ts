import type { ConversationActiveConnection } from "../../packages/gateway-protocol/src/schema/agent.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { selectTalkConnectionPresentations } from "../talk/session-registry.js";
import type { prepareTranscriptReadAuthority } from "./session-transcript-read-authority.js";

const nativeReads = {
  selectTalkConnectionPresentations,
  async prepareTranscriptReadAuthority(...args: Parameters<typeof prepareTranscriptReadAuthority>) {
    const owner = await import("./session-transcript-read-authority.js");
    return owner.prepareTranscriptReadAuthority(...args);
  },
};

type ActiveConnectionRead = Pick<
  Awaited<ReturnType<typeof prepareTranscriptReadAuthority>>,
  "assertCurrent" | "release"
> & { sources: readonly { sessionId: string }[] };
type ActiveConnectionDependencies = {
  selectTalkConnectionPresentations: typeof selectTalkConnectionPresentations;
  prepareTranscriptReadAuthority(
    params: Parameters<typeof prepareTranscriptReadAuthority>[0],
  ): Promise<ActiveConnectionRead>;
};

/** Connection discovery uses the same person/role/sharing owner as native conversation reads. */
export async function prepareConversationActiveConnections(
  params: {
    authority?: AdmittedRunOperatorAuthority;
    getRuntimeConfig: () => OpenClawConfig;
    agentId: string;
    channel?: string;
    query?: string;
    limit: number;
  },
  deps: ActiveConnectionDependencies = nativeReads,
) {
  const prepared: {
    connection: ReturnType<typeof selectTalkConnectionPresentations>[number];
    read: ActiveConnectionRead;
  }[] = [];
  let active = true;
  const release = () => {
    active = false;
    const errors: unknown[] = [];
    for (let index = prepared.length - 1; index >= 0; index--) {
      try {
        prepared[index]!.read.release();
        prepared.splice(index, 1);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Active connection read release failed");
  };
  try {
    if (params.authority) {
      params.authority.assertCurrent();
      for (const connection of deps.selectTalkConnectionPresentations()) {
        const { presentation } = connection;
        if (
          presentation.readTarget.agentId !== params.agentId ||
          (params.channel && presentation.channel !== params.channel.trim().toLowerCase())
        ) {
          continue;
        }
        try {
          connection.assertCurrent();
          const read = await deps.prepareTranscriptReadAuthority({
            authority: params.authority,
            getRuntimeConfig: params.getRuntimeConfig,
            sources: [presentation.readTarget],
          });
          prepared.push({ connection, read });
          connection.assertCurrent();
        } catch {
          // Unknown, not yet materialized, private or replaced targets reveal no metadata.
          params.authority.assertCurrent();
        }
      }
    }
    return {
      present(): ConversationActiveConnection[] {
        if (!active) throw new Error("Active connection read has been released");
        params.authority?.assertCurrent();
        const rows: ConversationActiveConnection[] = [];
        const query = params.query?.trim().toLowerCase();
        for (const { connection, read } of prepared) {
          try {
            connection.assertCurrent();
            read.assertCurrent();
            const { presentation } = connection;
            const source = read.sources[0];
            if (
              !source ||
              (presentation.readTarget.sessionId &&
                source.sessionId !== presentation.readTarget.sessionId)
            ) {
              continue;
            }
            const state = presentation.state();
            if (state === "closed") continue;
            if (
              query &&
              ![presentation.label, presentation.channel, presentation.kind].some((value) =>
                value.toLowerCase().includes(query),
              )
            ) {
              continue;
            }
            rows.push({
              connectionRef: connection.connectionRef,
              kind: presentation.kind,
              channel: presentation.channel,
              label: presentation.label,
              state,
              input: { ...presentation.input },
              output: { ...presentation.output },
              operations: [...presentation.operations],
            });
          } catch {
            // Presence and read grants can disappear while another address is prepared.
            params.authority?.assertCurrent();
          }
          if (rows.length >= params.limit) break;
        }
        return rows;
      },
      release,
    };
  } catch (error) {
    try {
      release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Active connection authorization cleanup failed",
      );
    }
    throw error;
  }
}
