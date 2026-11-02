/** Canonical BCP 47 language tags for configured agent presentation. */
export function normalizeLanguageTag(value: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(value.trim())[0];
  } catch {
    return undefined;
  }
}

export type UserMessageLocale = "en" | "de";

/** Unsupported languages deliberately use the maintained English catalog. */
export function resolveUserMessageLocale(language?: string): UserMessageLocale {
  const normalized = language ? normalizeLanguageTag(language) : undefined;
  return normalized?.split("-")[0] === "de" ? "de" : "en";
}
