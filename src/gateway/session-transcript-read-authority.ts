import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import {
  composeSessionSourceAssertion,
  type PreparedSessionSourceAuthority,
} from "../config/sessions/session-source-authority.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { resolveAdmittedRunOperatorRolePolicy } from "./operator-role-policy.js";
import { prepareSessionCreatorProfile } from "./session-creator.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import { prepareSessionSharingProfileAuthority } from "./session-sharing-profile-authority.js";
import { createSessionReadEntryFilter } from "./session-sharing-read-policy.js";
import {
  preparePersonalConversationRead,
  type PersonalConversationReadParams,
} from "./session-transcript-personal-read.js";

/** Selected reads retain their original operator grant or narrowly bound personal-difference proof. */
export async function prepareTranscriptReadAuthority(
  params:
    | {
        purpose?: "operator-history";
        authority: AdmittedRunOperatorAuthority;
        getRuntimeConfig: () => OpenClawConfig;
        sources: readonly { agentId: string; sessionKey: string }[];
      }
    | PersonalConversationReadParams,
) {
  if (params.purpose === "conversation-differences") {
    return preparePersonalConversationRead(params);
  }
  assertAdmittedRunOperatorAuthority(params.authority);
  if (!params.sources.length || params.sources.length > MAX_SESSION_ROW_FACTS_KEYS) {
    throw new Error(`Transcript reads require 1 to ${MAX_SESSION_ROW_FACTS_KEYS} selected sources`);
  }
  const { authority } = params;
  const requestedSources = params.sources.map(({ agentId, sessionKey }) => ({
    agentId,
    sessionKey,
  }));
  if (requestedSources.some((source) => isIncognitoSessionKey(source.sessionKey))) {
    throw new Error("Transcript source authority requires durable sessions");
  }
  authority.assertCurrent();
  const reads: Awaited<ReturnType<typeof prepareSessionMutationFacts>>[] = [];
  const sources: Readonly<{
    agentId: string;
    canonicalKey: string;
    storePath: string;
    sessionId: string;
    lifecycleRevision: string | undefined;
    readSource: CapturedSessionEntryReadSource;
  }>[] = [];
  const releases: (() => void)[] = [];
  let active = true;
  let revoked = false;
  let refusal: unknown;
  const release = () => {
    active = false;
    const errors: unknown[] = [];
    for (let index = releases.length - 1; index >= 0; index--) {
      try {
        releases[index]!();
        releases.splice(index, 1);
      } catch (error) {
        errors.push(error);
      }
    }
    throwSqliteLifecycleErrors(errors, "Transcript read authority release failed");
  };
  try {
    const releaseOperator = authority.retain?.();
    if (releaseOperator) {
      releases.push(releaseOperator);
    }
    const profileId =
      authority.profileId === GATEWAY_OWNER_PROFILE_ID ? undefined : authority.profileId;
    const readProfile = profileId
      ? await prepareSessionSharingProfileAuthority(profileId)
      : () => undefined;
    const readPolicy = () => {
      if (!active) {
        throw new Error("Transcript read authority has been released");
      }
      if (revoked) {
        throw refusal;
      }
      authority.signal?.throwIfAborted();
      authority.assertCurrent();
      const cfg = params.getRuntimeConfig();
      const profile = readProfile();
      if (profileId && (!profile || !profile.aliases.has(profileId))) {
        throw new Error("Transcript reader profile is unavailable");
      }
      const policy = resolveAdmittedRunOperatorRolePolicy(authority, cfg);
      if (
        policy &&
        !roleScopesAllow({
          role: "operator",
          requestedScopes: authority.scopes,
          allowedScopes: policy.scopes,
        })
      ) {
        throw new Error("Transcript reader operator role changed");
      }
      const filter = createSessionReadEntryFilter(
        {
          profileId,
          admin: authority.scopes.includes("operator.admin"),
          system: false,
          rolesConfigured: Boolean(cfg.gateway?.roles),
          sessionCap: policy?.sessions.others,
        },
        prepareSessionCreatorProfile(profileId, profile?.aliases),
      );
      return { cfg, filter };
    };
    const refuse = (error: unknown): never => {
      revoked = true;
      refusal = error;
      throw error;
    };
    const assertCurrent = () => {
      try {
        const { cfg, filter } = readPolicy();
        for (const [index, read] of reads.entries()) {
          const target = read.readCurrent(cfg).target;
          const expected = sources[index];
          if (
            !expected ||
            !target ||
            target.agentId !== expected.agentId ||
            target.canonicalKey !== expected.canonicalKey ||
            target.storePath !== expected.storePath ||
            target.entry.sessionId !== expected.sessionId ||
            target.entry.lifecycleRevision !== expected.lifecycleRevision ||
            target.readSource?.agentId !== expected.readSource.agentId ||
            target.readSource.path !== expected.readSource.path ||
            target.readSource.databaseIdentity !== expected.readSource.databaseIdentity ||
            target.readSource.databaseBirthtime !== expected.readSource.databaseBirthtime ||
            filter?.(target.canonicalKey, target.entry) === false
          ) {
            throw new Error("Transcript source is no longer readable");
          }
        }
      } catch (error) {
        refuse(error);
      }
    };
    for (const source of requestedSources) {
      const { cfg } = readPolicy();
      if (!authorizeOperatorScopesForMethod("chat.history", authority.scopes, source).allowed) {
        throw new Error("Transcript reader lacks history scope");
      }
      const read = await prepareSessionMutationFacts({ cfg, ...source });
      releases.push(() => read.release());
      const target = read.readCurrent(params.getRuntimeConfig()).target;
      if (!target?.entry.sessionId || !target.readSource) {
        throw new Error("Transcript source identity is unavailable");
      }
      if (
        isIncognitoSessionKey(target.canonicalKey) ||
        typeof target.readSource.databaseIdentity !== "string"
      ) {
        throw new Error("Transcript source authority requires durable sessions");
      }
      sources.push(
        Object.freeze({
          agentId: target.agentId,
          canonicalKey: target.canonicalKey,
          storePath: target.storePath,
          sessionId: target.entry.sessionId,
          lifecycleRevision: target.entry.lifecycleRevision,
          readSource: Object.freeze({ ...target.readSource }),
        }),
      );
      reads.push(read);
      assertCurrent();
    }
    const prepare = (): Promise<PreparedSessionSourceAuthority> => {
      assertCurrent();
      const cfg = params.getRuntimeConfig();
      const checks: PreparedSessionSourceAuthority["checks"] = [];
      const expectedEntries = reads.map((read) => read.readCurrent(cfg).target.entry);
      for (const [index, read] of reads.entries()) {
        const source = sources[index]!;
        const facts = read.readCurrent(cfg);
        checks.push({
          predicate: {
            source: source.readSource,
            sessionKey: facts.target.storeKey,
            fields: ["sessionId", "lifecycleRevision", "createdActor", "visibility", "incognito"],
            expected: facts.target.entry,
            members: [...facts.membership],
          },
          refuse: () => refuse(new Error("Transcript source read facts changed")),
        });
      }
      return Promise.resolve({
        assertCurrent,
        // Row/source/member equality belongs to the atomic worker predicates.
        // Only prepared operator/profile/config facts are consumed on the host.
        assertPreparedCurrent: () => {
          try {
            const { filter } = readPolicy();
            for (const [index, entry] of expectedEntries.entries()) {
              if (filter?.(sources[index]!.canonicalKey, entry) === false) {
                throw new Error("Transcript source is no longer readable");
              }
            }
          } catch (error) {
            refuse(error);
          }
        },
        checks,
      });
    };
    const sourceAssertion = Object.assign(assertCurrent, {
      prepareSessionSource: prepare,
      prepareSessionSourceScope: prepare,
    });
    return {
      sources: Object.freeze(sources),
      contributionRange: undefined,
      assertCurrent: composeSessionSourceAssertion([authority.assertCurrent, sourceAssertion]),
      release,
    };
  } catch (error) {
    try {
      release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Transcript read preparation and release failed",
        { cause: releaseError },
      );
    }
    throw error;
  }
}
