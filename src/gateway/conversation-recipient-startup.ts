import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { openConversationKnowledgeRoot } from "../auto-reply/reply/conversation-knowledge-open.js";
import { wakeConversationRecipientsAfterConfigChange } from "../auto-reply/reply/conversation-knowledge-prefetch.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import { captureConversationRecipientEnrollment } from "../config/sessions/conversation-recipient-enrollment.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getBackgroundOwnerLane } from "../process/background-work.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import type { ConversationPrivateAudience } from "../sessions/conversation-private-audience.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { onOperatorRolePolicyChanged } from "./operator-role-policy.js";
import { prepareGatewayOperatorSourceCustody } from "./operator-source-custody.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import type { EntryRow } from "./session-row-projection-record.js";
import { SessionMutationFactsUnavailableError } from "./session-sharing-incognito.js";

const log = createSubsystemLogger("conversation-knowledge");

function reusable(entry: InternalSessionEntry) {
  return (
    entry.conversationTopology?.role === "branch" &&
    entry.chatType === "direct" &&
    entry.visibility === "draft" &&
    !entry.incognito &&
    entry.archivedAt === undefined &&
    entry.publicShare === undefined
  );
}

/** Re-admit durable recipient sources, not former requests or transport connections. */
export function startGatewayConversationRecipients(params: {
  context: GatewayRequestContext;
  signal: AbortSignal;
  log: { warn(message: string): void };
}) {
  const { context } = params;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    params.signal,
    controller.signal,
    getGatewayRestartDrainSignal(),
  ]);
  const projection = getSessionRowProjection(context);
  if (!projection || signal.aborted) {
    return undefined;
  }
  const getConfig = context.getCommittedRuntimeConfig ?? context.getRuntimeConfig;
  let committed = getConfig();
  let runtime = context.getRuntimeConfig();
  const owners = new Map<
    string,
    { sessionKey: string; fingerprint: string; custodySignal: AbortSignal; stop(): Promise<void> }
  >();
  const attempted = new Map<string, string>();
  const retryable = new Map<string, string>();
  const changed = new Set<string>();
  let all = true;
  let pending: Promise<void> | undefined;
  let closing = false;
  const warn = () =>
    params.log.warn("Reusable conversation preparation deferred; source admission unavailable.");
  const id = (row: EntryRow) => JSON.stringify([row.agentId, row.storeTarget.storePath, row.key]);
  const eligible = (row: EntryRow) =>
    reusable(row.entry) && resolveAgentConversationMode(getConfig(), row.agentId) === "branches";

  const enroll = async (row: EntryRow, workSignal: AbortSignal) => {
    const key = id(row);
    const stored = eligible(row) ? row.entry.conversationRecipientEnrollment : undefined;
    const fingerprint = JSON.stringify(stored) ?? "";
    const previous = owners.get(key);
    if (!stored && !previous) {
      return;
    }
    if (
      (previous?.fingerprint === fingerprint && !previous.custodySignal.aborted) ||
      attempted.get(key) === fingerprint
    ) {
      return;
    }
    attempted.set(key, fingerprint);
    await previous?.stop();
    owners.delete(key);
    if (!stored) {
      return;
    }
    const enrollment = captureConversationRecipientEnrollment(stored);
    if (!enrollment) {
      return;
    }
    const recipientController = new AbortController();
    const lifetime = AbortSignal.any([signal, workSignal, recipientController.signal]);
    const target = {
      agentId: row.agentId,
      sessionKey: row.key,
      sessionId: row.entry.sessionId,
      storePath: row.storeTarget.storePath,
    };
    const assertCurrent = () => {
      lifetime.throwIfAborted();
      const current = projection.sharingTarget({
        agentId: row.agentId,
        key: row.key,
        storePath: row.storeTarget.storePath,
      });
      const topology = current?.entry.conversationTopology;
      if (
        !current ||
        !reusable(current.entry) ||
        enrollment.branch.agentId !== target.agentId ||
        enrollment.branch.sessionKey !== target.sessionKey ||
        enrollment.branch.storePath !== target.storePath ||
        current.entry.sessionId !== enrollment.branch.sessionId ||
        current.entry.lifecycleRevision !== enrollment.branch.lifecycleRevision ||
        topology?.role !== "branch" ||
        topology.rootSessionKey !== enrollment.branch.root.sessionKey ||
        topology.rootSessionId !== enrollment.branch.root.sessionId ||
        topology.rootSessionLifecycleRevision !== enrollment.branch.root.lifecycleRevision ||
        !isDeepStrictEqual(current.entry.conversationRecipientEnrollment, stored) ||
        resolveAgentConversationMode(getConfig(), row.agentId) !== "branches"
      ) {
        throw new Error("Reusable conversation recipient changed before preparation");
      }
    };
    assertCurrent();
    const custody = await prepareGatewayOperatorSourceCustody({
      snapshot: enrollment.source.snapshot,
      context,
      assertCurrent,
      signal: lifetime,
    });
    let registration: Awaited<ReturnType<typeof openConversationKnowledgeRoot>> = undefined;
    const owner = {
      sessionKey: row.key,
      fingerprint,
      custodySignal: custody.signal,
      async stop() {
        recipientController.abort();
        await registration?.close();
        custody.release();
      },
    };
    try {
      assertCurrent();
      const audience: ConversationPrivateAudience = Object.freeze({
        agentId: row.agentId,
        sessionKey: row.key,
        channelId: "webchat",
        accountId: "default",
        nativeChannelId: row.key,
        participant: { type: "profile" as const, id: custody.profileId },
        assertCurrent() {
          assertCurrent();
          custody.assertCurrent();
        },
        retain() {
          audience.assertCurrent();
          const release = custody.retain();
          return [{ source: custody, audience, signal: custody.signal, release }];
        },
      });
      registration = await openConversationKnowledgeRoot({
        target,
        participant: audience.participant,
        audience,
        getRuntimeConfig: getConfig,
        signal: lifetime,
      });
      audience.assertCurrent();
      if (!registration) {
        await owner.stop();
        return;
      }
      owners.set(key, owner);
      log.debug("Reusable conversation recipient restored", {
        recipient: redactIdentifier(target.sessionId),
      });
    } catch (error) {
      // A rejected publication may already own a registration. Keep its cleanup
      // reachable until the existing native close has actually settled.
      owners.set(key, owner);
      try {
        await owner.stop();
        owners.delete(key);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Conversation recipient cleanup remains pending",
          { cause: cleanupError },
        );
      }
      throw error;
    }
  };

  const request = () => {
    if (pending || closing || signal.aborted || (!all && !changed.size)) {
      return;
    }
    pending = runInDetachedAsyncContext(() =>
      enqueueCommandInLane(
        getBackgroundOwnerLane("conversation-recipient-startup"),
        async () => {
          const workSignal = signal;
          await projection.ensureMaterialized();
          workSignal.throwIfAborted();
          const broad = all;
          const keys = [...changed];
          all = false;
          changed.clear();
          const rows = broad
            ? projection.selectEntries()
            : keys.flatMap((key) => projection.selectEntries({ key }));
          const selected = new Set(rows.map(id));
          for (const [key, owner] of owners) {
            if ((broad || keys.includes(owner.sessionKey)) && !selected.has(key)) {
              await owner.stop();
              owners.delete(key);
              attempted.delete(key);
            }
          }
          for (const row of rows) {
            // Enrollment prepares custody; recipient writers independently yield
            // to active turns. Do not make unrelated conversations wait for them.
            await setImmediate(undefined, { signal: workSignal });
            workSignal.throwIfAborted();
            try {
              await enroll(row, workSignal);
            } catch (error) {
              if (error instanceof SessionMutationFactsUnavailableError) {
                retryable.set(id(row), row.key);
              }
              if (!signal.aborted) {
                warn();
              }
            }
          }
        },
        { abortSignal: signal, priority: "background" },
      ),
    )
      .catch(() => {
        // A failed preparation waits for a fresh owner publication, never a busy retry.
        all = false;
        changed.clear();
        if (!signal.aborted) {
          warn();
        }
      })
      .finally(() => {
        pending = undefined;
        request();
      });
  };
  projection.onFactsChange((change) => {
    if (closing || signal.aborted) {
      return;
    }
    // Only a subsequent external publication re-arms transient admission. Facts
    // published by the failed attempt itself must not produce a retry loop.
    if (!pending) {
      for (const [key, sessionKey] of retryable) {
        if (change.kind === "reset" || change.key === sessionKey) {
          attempted.delete(key);
          retryable.delete(key);
        }
      }
    }
    if (change.kind === "reset") {
      all = true;
    } else {
      changed.add(change.key);
    }
    request();
  });
  const gatewayOwner = context.resolveGatewayContext?.() ?? context;
  const unsubscribeConfig = onOperatorRolePolicyChanged((change) => {
    if (closing || signal.aborted || change.kind !== "config" || change.context !== gatewayOwner) {
      return;
    }
    const current = getConfig();
    if (current !== committed) {
      // Channel readers can hold the runtime snapshot; operator sources hold the committed one.
      wakeConversationRecipientsAfterConfigChange(committed, runtime);
      committed = current;
      runtime = context.getRuntimeConfig();
      attempted.clear();
      all = true;
      request();
    }
  });
  let closed: Promise<void> | undefined;
  const close = () => {
    if (closed) {
      return closed;
    }
    closing = true;
    unsubscribeConfig();
    closed = Promise.resolve(pending).then(async () => {
      const failures: unknown[] = [];
      for (const [key, owner] of owners) {
        try {
          await owner.stop();
          owners.delete(key);
        } catch (error) {
          failures.push(error);
        }
      }
      attempted.clear();
      retryable.clear();
      changed.clear();
      if (failures.length) {
        throw new AggregateError(failures, "Conversation recipient cleanup remains pending");
      }
    });
    void closed.catch(() => {
      closed = undefined;
    });
    controller.abort();
    return closed;
  };
  signal.addEventListener(
    "abort",
    () => {
      void close().catch(warn);
    },
    { once: true },
  );
  request();
  return {
    close,
    async settled() {
      for (let current = pending; current; current = pending) {
        await current;
      }
    },
  };
}
