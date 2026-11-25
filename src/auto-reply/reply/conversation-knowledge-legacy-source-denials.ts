import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RetainedLegacyConversationSourceDenial } from "../../gateway/session-transcript-personal-read.js";

const MAX_RETAINED_LEGACY_SOURCE_DENIALS = 16;

export const admissionKey = (
  source: SessionTranscriptRuntimeTarget & { lifecycleRevision: string },
) =>
  JSON.stringify([
    source.agentId,
    source.storePath,
    source.sessionKey,
    source.sessionId,
    source.lifecycleRevision,
  ]);

export function createLegacySourceDenials(
  releaseAdmissions: (denials: Iterable<RetainedLegacyConversationSourceDenial>) => void,
) {
  const legacyDenials = new Map<
    string,
    { sourceKey: string; proof: RetainedLegacyConversationSourceDenial }
  >();
  let clearEpoch = 0;
  const reader = {
    watchesLegacyDeniedSource(sessionKey: string) {
      return legacyDenials.has(sessionKey);
    },
    hasCurrentLegacyDenial(
      source: SessionTranscriptRuntimeTarget & { lifecycleRevision: string },
      cfg: OpenClawConfig,
    ) {
      const { sessionKey } = source;
      const denial = legacyDenials.get(sessionKey);
      if (denial?.sourceKey !== admissionKey(source)) {
        return false;
      }
      try {
        if (denial.proof.isCurrent(cfg)) {
          legacyDenials.delete(sessionKey);
          legacyDenials.set(sessionKey, denial);
          return true;
        }
      } catch {
        // Pending, unavailable and replaced native publications go through normal admission.
      }
      legacyDenials.delete(sessionKey);
      releaseAdmissions([denial.proof]);
      return false;
    },
    prepareLegacyDenialRetention(
      source: SessionTranscriptRuntimeTarget & { lifecycleRevision: string },
    ) {
      const epoch = clearEpoch;
      const sourceKey = admissionKey(source);
      const { sessionKey } = source;
      return (proof: RetainedLegacyConversationSourceDenial) => {
        // These leases retain native metadata only. Do not displace prepared context.
        const previous = legacyDenials.get(sessionKey);
        if (clearEpoch !== epoch || previous?.sourceKey === sourceKey) {
          return false;
        }
        if (previous) {
          legacyDenials.delete(sessionKey);
          releaseAdmissions([previous.proof]);
        } else if (legacyDenials.size >= MAX_RETAINED_LEGACY_SOURCE_DENIALS) {
          const [oldestKey, oldest] = legacyDenials.entries().next().value!;
          legacyDenials.delete(oldestKey);
          releaseAdmissions([oldest.proof]);
        }
        legacyDenials.set(sessionKey, { sourceKey, proof });
        return true;
      };
    },
  };
  return {
    reader,
    clear(retire: (proof: RetainedLegacyConversationSourceDenial) => void) {
      clearEpoch++;
      for (const { proof } of legacyDenials.values()) {
        retire(proof);
      }
      legacyDenials.clear();
    },
  };
}
