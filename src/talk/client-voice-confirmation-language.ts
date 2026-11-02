import { resolveUserMessageLocale, type UserMessageLocale } from "../shared/language.js";

const vocabulary: Record<UserMessageLocale, { affirmation: RegExp; refusal: RegExp }> = {
  en: {
    affirmation:
      /^(yes|yes do it|do it|confirm|confirmed|go ahead|proceed|send it|make the change|restart it)$/,
    refusal: /\b(no|don't|do not|cancel|stop|never mind)\b/,
  },
  de: {
    affirmation:
      /^(ja|ja bitte|ja mach das|mach es|mach das|bestätigen|bestätigt|in ordnung|sende es|führe es aus)$/u,
    refusal:
      /(?:^|[^\p{L}\p{N}])(?:nein|nicht|kein|keine|keinen|keinem|keiner|keines|niemals|abbrechen|abbruch|stopp|stop|lass es|vergiss es)(?=$|[^\p{L}\p{N}])/u,
  },
};

function normalizeUtterance(text: string): string {
  return text
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[,;:.!?]+/g, "")
    .replace(/\s+/g, " ");
}

/** A refusal anywhere in the selected language cancels; affirmations are whole utterances. */
export function classifyVoiceConfirmationUtterance(
  text: string,
  language?: string,
): "affirmation" | "refusal" | "other" {
  const normalized = normalizeUtterance(text);
  const selected = vocabulary[resolveUserMessageLocale(language)];
  if (selected.refusal.test(normalized)) {
    return "refusal";
  }
  return selected.affirmation.test(normalized) ? "affirmation" : "other";
}
