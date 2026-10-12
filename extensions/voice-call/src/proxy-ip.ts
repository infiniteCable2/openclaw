import type http from "node:http";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { VoiceCallConfig } from "./config.js";
import { getHeader } from "./http-headers.js";

// Voice Call plugin module normalizes proxy IP representations.
export function normalizeProxyIp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const normalized = unwrapped.toLowerCase();
  const mappedIpv4Prefix = "::ffff:";
  if (normalized.startsWith(mappedIpv4Prefix)) {
    const mappedIpv4 = normalized.slice(mappedIpv4Prefix.length);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(mappedIpv4)) {
      return mappedIpv4;
    }
  }
  return normalized;
}

function resolveForwardedClientIp(
  request: Pick<http.IncomingMessage, "headers">,
  normalizedTrustedProxyIps: ReadonlySet<string>,
): string | undefined {
  const forwardedFor = getHeader(request.headers, "x-forwarded-for");
  if (forwardedFor) {
    const forwardedIps = normalizeStringEntries(forwardedFor.split(","));
    if (forwardedIps.length > 0) {
      for (let index = forwardedIps.length - 1; index >= 0; index -= 1) {
        const hop = forwardedIps[index];
        if (!normalizedTrustedProxyIps.has(normalizeProxyIp(hop) ?? "")) {
          return hop;
        }
      }
      return forwardedIps[0];
    }
  }

  const realIp = getHeader(request.headers, "x-real-ip")?.trim();
  return realIp || undefined;
}

export function resolveMediaStreamClientIp(
  request: Pick<http.IncomingMessage, "headers"> & {
    socket: Pick<http.IncomingMessage["socket"], "remoteAddress">;
  },
  security: VoiceCallConfig["webhookSecurity"],
): string | undefined {
  const remoteIp = request.socket.remoteAddress ?? undefined;
  const normalizedTrustedProxyIps = new Set(
    security.trustedProxyIPs
      .map((ip) => normalizeProxyIp(ip))
      .filter((ip): ip is string => Boolean(ip)),
  );
  const normalizedRemoteIp = normalizeProxyIp(remoteIp);
  const fromTrustedProxy =
    normalizedRemoteIp !== undefined && normalizedTrustedProxyIps.has(normalizedRemoteIp);
  const shouldTrustForwardingHeaders = security.trustForwardingHeaders && fromTrustedProxy;

  if (shouldTrustForwardingHeaders) {
    const forwardedIp = resolveForwardedClientIp(request, normalizedTrustedProxyIps);
    if (forwardedIp) {
      return forwardedIp;
    }
  }

  return remoteIp;
}
