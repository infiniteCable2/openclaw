import type { ChannelIngressIdentitySubjectInput } from "openclaw/plugin-sdk/channel-ingress-runtime";

/**
 * Attribute the SDK event sender / RTC membership to its Matrix identity, not
 * its display name or a locally guessed profile. This supplies product identity
 * only: each producer retains its existing authentication, admission and
 * command policy. It does not establish cross-signing or a private audience.
 */
export function resolveMatrixSenderParticipant(subject: ChannelIngressIdentitySubjectInput) {
  const id = subject.stableId;
  if (typeof id !== "string" || id !== id.trim()) {
    return undefined;
  }
  const match = /^@[^:\s]+:([^\s]+)$/u.exec(id);
  const domain = match?.[1];
  if (!domain || /[/\\?#@]/u.test(domain)) {
    return undefined;
  }
  try {
    const issuer = new URL(`https://${domain}`);
    if (
      !issuer.hostname ||
      issuer.username ||
      issuer.password ||
      issuer.pathname !== "/" ||
      issuer.search ||
      issuer.hash
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  // Preserve the complete, case-sensitive MXID. Ports and IPv6 server names
  // remain part of the issuer namespace instead of being split at every colon.
  return { domain, idKind: "user-id", id };
}
