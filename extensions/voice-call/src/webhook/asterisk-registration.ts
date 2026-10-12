import type http from "node:http";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { createWebhookInFlightLimiter } from "openclaw/plugin-sdk/webhook-ingress";
import { readRequestBodyWithLimit } from "../../api.js";
import { isAllowlistedCaller, normalizePhoneNumber } from "../allowlist.js";
import type { VoiceCallConfig } from "../config.js";
import { getHeader } from "../http-headers.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { WebhookResponsePayload } from "../webhook.types.js";

const MAX_ASTERISK_REGISTRATION_BYTES = 8 * 1024;
const ASTERISK_REGISTRATION_TIMEOUT_MS = 5_000;

export async function handleAsteriskRegistrationRequest(params: {
  req: http.IncomingMessage;
  provider: VoiceCallProvider;
  config: VoiceCallConfig;
  logger: PluginLogger;
  inFlightLimiter: ReturnType<typeof createWebhookInFlightLimiter>;
  inFlightKey: string;
}): Promise<WebhookResponsePayload> {
  const { req, provider, config, logger, inFlightLimiter, inFlightKey } = params;
  if (!inFlightLimiter.tryAcquire(inFlightKey)) {
    logger.warn("Asterisk registration rejected: too many in-flight requests");
    return { statusCode: 429, body: "Too Many Requests" };
  }
  try {
    return await register();
  } finally {
    inFlightLimiter.release(inFlightKey);
  }

  async function register(): Promise<WebhookResponsePayload> {
    if (req.method !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }
    const authorization = getHeader(req.headers, "authorization") ?? "";
    const match = /^Bearer (?<token>\S+)$/u.exec(authorization);
    if (!match?.groups?.token) {
      return { statusCode: 401, body: "Unauthorized" };
    }
    const { AsteriskProvider } = await import("../providers/asterisk.js");
    if (!(provider instanceof AsteriskProvider)) {
      return { statusCode: 401, body: "Unauthorized" };
    }
    if (!provider.verifyRegistrationToken(match.groups.token)) {
      return { statusCode: 401, body: "Unauthorized" };
    }
    let rawBody: string;
    try {
      rawBody = await readRequestBodyWithLimit(req, {
        maxBytes: MAX_ASTERISK_REGISTRATION_BYTES,
        timeoutMs: ASTERISK_REGISTRATION_TIMEOUT_MS,
      });
    } catch {
      return { statusCode: 400, body: "Invalid registration" };
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { statusCode: 400, body: "Invalid registration" };
    }
    if (!isRecord(body)) {
      return { statusCode: 400, body: "Invalid registration" };
    }
    const registration = body;
    if (
      typeof registration.uuid !== "string" ||
      typeof registration.from !== "string" ||
      typeof registration.to !== "string"
    ) {
      return { statusCode: 400, body: "Invalid registration" };
    }
    if (!shouldAcceptInboundCaller(config, registration.from)) {
      logger.info("Asterisk inbound call rejected before AudioSocket admission");
      return { statusCode: 403, body: "Forbidden" };
    }
    try {
      provider.registerInboundCall(
        {
          uuid: registration.uuid,
          from: registration.from,
          to: registration.to,
          direction: "inbound",
        },
        match.groups.token,
      );
      return { statusCode: 202, body: "Accepted" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Unauthorized")) {
        return { statusCode: 401, body: "Unauthorized" };
      }
      logger.warn(`Asterisk registration rejected: ${message}`);
      return {
        statusCode: message.includes("already registered") ? 409 : 400,
        body: "Invalid registration",
      };
    }
  }
}
function shouldAcceptInboundCaller(config: VoiceCallConfig, from: string | undefined): boolean {
  switch (config.inboundPolicy) {
    case "open":
      return true;
    case "allowlist":
    case "pairing":
      return isAllowlistedCaller(normalizePhoneNumber(from), config.allowFrom);
    default:
      return false;
  }
}
