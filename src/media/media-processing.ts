import type { MediaProcessingPurpose } from "@openclaw/media-core/constants";

type MediaProcessingInput = {
  purpose?: MediaProcessingPurpose | null;
  voiceMessage?: boolean | null;
  speechInput?: boolean | null;
};

/** Reject unknown explicit intent rather than silently enabling automatic processing. */
export function normalizeMediaProcessingPurpose(
  value: unknown,
): MediaProcessingPurpose | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  switch (value) {
    case "communication":
      return "communication";
    case "analysis":
      return "analysis";
    case "recording":
      return "recording";
    case "relay":
      return "relay";
    default:
      throw new Error("Unsupported media processing purpose");
  }
}

/**
 * Explicit intent takes precedence over old voice flags. Missing intent retains the native
 * legacy contract; these decisions are projections, never a second stored media state.
 */
export function resolveMediaProcessingIntent(input: MediaProcessingInput) {
  const purpose = normalizeMediaProcessingPurpose(input.purpose);
  return {
    automaticUnderstanding: purpose !== "recording" && purpose !== "relay",
    speechInput:
      purpose === "communication" ||
      (purpose === undefined && (input.speechInput === true || input.voiceMessage === true)),
    voiceReply:
      purpose === "communication" || (purpose === undefined && input.voiceMessage !== false),
  };
}
