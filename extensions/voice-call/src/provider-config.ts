import {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { TWILIO_REGIONS } from "./providers/twilio-region.js";

const SecretInputSchema = buildSecretInputSchema();
const ASTERISK_REGISTRATION_TOKEN_PATH =
  "plugins.entries.voice-call.config.asterisk.registrationToken";

export const TelnyxConfigSchema = z
  .object({
    /** Telnyx API v2 key */
    apiKey: z.string().min(1).optional(),
    /** Telnyx connection ID (from Call Control app) */
    connectionId: z.string().min(1).optional(),
    /** Public key for webhook signature verification */
    publicKey: z.string().min(1).optional(),
  })
  .strict();
export type TelnyxConfig = z.infer<typeof TelnyxConfigSchema>;

export const TwilioConfigSchema = z
  .object({
    /** Twilio Account SID */
    accountSid: z.string().min(1).optional(),
    /** Twilio Auth Token */
    authToken: SecretInputSchema.optional(),
    /** Twilio processing Region (for example, ie1) */
    region: z.enum(TWILIO_REGIONS).optional(),
  })
  .strict();

export const PlivoConfigSchema = z
  .object({
    /** Plivo Auth ID (starts with MA/SA) */
    authId: z.string().min(1).optional(),
    /** Plivo Auth Token */
    authToken: z.string().min(1).optional(),
  })
  .strict();
export type PlivoConfig = z.infer<typeof PlivoConfigSchema>;

const AsteriskAudioSocketConfigSchema = z
  .object({
    /** Loopback address for Asterisk AudioSocket TCP connections. */
    bind: z.string().default("127.0.0.1"),
    /** TCP port used by the AudioSocket dialplan leg. */
    port: z.number().int().nonnegative().max(65_535).default(9092),
    /** Signed-linear PCM sample rate selected in the Asterisk channel driver. */
    sampleRate: z
      .union([
        z.literal(8_000),
        z.literal(12_000),
        z.literal(16_000),
        z.literal(24_000),
        z.literal(32_000),
        z.literal(44_100),
        z.literal(48_000),
        z.literal(96_000),
        z.literal(192_000),
      ])
      .default(8_000),
    /** Time allowed for the first UUID frame. */
    handshakeTimeoutMs: z.number().int().positive().default(5_000),
    /** One-time registration lifetime before the AudioSocket leg connects. */
    registrationTtlMs: z.number().int().positive().default(30_000),
    /** Maximum concurrent AudioSocket calls. */
    maxConnections: z.number().int().positive().default(16),
  })
  .strict()
  .default({
    bind: "127.0.0.1",
    port: 9092,
    sampleRate: 8_000,
    handshakeTimeoutMs: 5_000,
    registrationTtlMs: 30_000,
    maxConnections: 16,
  });

export const AsteriskConfigSchema = z
  .object({
    /** Bearer token used by the dialplan registration request. */
    registrationToken: SecretInputSchema.optional(),
    /** HTTP path for one-time inbound call registrations. */
    registrationPath: z.string().min(1).default("/voice/asterisk/register"),
    audioSocket: AsteriskAudioSocketConfigSchema,
  })
  .strict()
  .default({
    registrationPath: "/voice/asterisk/register",
    audioSocket: {
      bind: "127.0.0.1",
      port: 9092,
      sampleRate: 8_000,
      handshakeTimeoutMs: 5_000,
      registrationTtlMs: 30_000,
      maxConnections: 16,
    },
  });
export type AsteriskConfig = z.infer<typeof AsteriskConfigSchema>;

export function resolveAsteriskRegistrationToken(
  config: Pick<AsteriskConfig, "registrationToken">,
): string | undefined {
  return normalizeResolvedSecretInputString({
    value: config.registrationToken,
    path: ASTERISK_REGISTRATION_TOKEN_PATH,
  });
}

export function validateAsteriskProviderConfig(
  config: AsteriskConfig,
  streamingEnabled: boolean,
): string[] {
  const errors: string[] = [];
  if (!hasConfiguredSecretInput(config.registrationToken)) {
    errors.push("plugins.entries.voice-call.config.asterisk.registrationToken is required");
  }
  if (!streamingEnabled) {
    errors.push(
      "plugins.entries.voice-call.config.streaming.enabled must be true for Asterisk calls",
    );
  }
  return errors;
}
