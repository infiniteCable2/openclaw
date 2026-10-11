import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  SpeechExpression,
  SpeechExpressionCapabilities,
  SpeechSynthesisTarget,
} from "./provider-types.js";

const MAX_PARTS = 128;
const MAX_CONTROLS = 64;
const MAX_TEXT = 16_384;

function requireLabel(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value)) {
    throw new Error("Speech expression labels must be short lowercase identifiers");
  }
  return value;
}

/** Admit one structured speech fact; arbitrary text markup is never an expression source. */
export function parseSpeechExpression(value: unknown, plainText: string): SpeechExpression {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "emotion" && key !== "parts") ||
    !Array.isArray(value.parts) ||
    value.parts.length === 0 ||
    value.parts.length > MAX_PARTS
  ) {
    throw new Error("Speech expression requires a bounded parts array and optional emotion");
  }
  const emotion = value.emotion === undefined ? undefined : requireLabel(value.emotion);
  let controls = emotion ? 1 : 0;
  let projection = "";
  const parts: SpeechExpression["parts"] = value.parts.map((part: unknown) => {
    if (!isRecord(part)) {
      throw new Error("Speech expression parts must be objects");
    }
    if (Object.hasOwn(part, "event")) {
      if (Object.keys(part).length !== 1) {
        throw new Error("Speech events must not also carry text or other fields");
      }
      controls += 1;
      return { event: requireLabel(part.event) };
    }
    if (
      Object.keys(part).some((key) => key !== "text" && key !== "emphasis") ||
      typeof part.text !== "string" ||
      part.text.length === 0 ||
      (part.emphasis !== undefined && typeof part.emphasis !== "boolean")
    ) {
      throw new Error("Speech text parts require nonempty text and optional boolean emphasis");
    }
    if (part.emphasis === true) {
      if (part.text.length > 80) {
        throw new Error("Speech emphasis must be a short phrase of at most 80 characters");
      }
      controls += 1;
    }
    projection += part.text;
    return { text: part.text, ...(part.emphasis === undefined ? {} : { emphasis: part.emphasis }) };
  });
  if (projection.length === 0 || projection.length > MAX_TEXT || controls > MAX_CONTROLS) {
    throw new Error("Speech expression exceeds its text or control budget");
  }
  if (projection !== plainText) {
    throw new Error("Speech expression text must project exactly to plain voiceText");
  }
  return { ...(emotion ? { emotion } : {}), parts };
}

/** Exact admitted agent/channel/target only; absent policy or context never inherits permission. */
export function isSpeechExpressionEnabled(params: {
  cfg: Pick<OpenClawConfig, "talk">;
  agentId?: string;
  channelId?: string;
  target: SpeechSynthesisTarget;
}): boolean {
  const profiles = params.cfg.talk?.speech?.agentProfiles;
  if (
    !params.agentId ||
    !params.channelId ||
    !profiles ||
    !Object.hasOwn(profiles, params.agentId)
  ) {
    return false;
  }
  const channels = profiles[params.agentId]?.expression?.channels;
  return Boolean(
    channels &&
    Object.hasOwn(channels, params.channelId) &&
    channels[params.channelId]?.targets.includes(params.target),
  );
}

/** Provider vocabulary is an admitted fact; unsupported presentation fails before synthesis. */
export function assertSpeechExpressionSupported(
  expression: SpeechExpression,
  capabilities: SpeechExpressionCapabilities | undefined,
): void {
  if (!capabilities) {
    throw new Error("Selected speech provider does not support expressions");
  }
  if (expression.emotion && !capabilities.emotions.includes(expression.emotion)) {
    throw new Error("Selected speech provider does not support the requested emotion");
  }
  for (const part of expression.parts) {
    if ("event" in part && !capabilities.vocalEvents.includes(part.event)) {
      throw new Error("Selected speech provider does not support the requested vocal event");
    }
    if ("text" in part && part.emphasis && !capabilities.emphasis) {
      throw new Error("Selected speech provider does not support emphasis");
    }
  }
}
