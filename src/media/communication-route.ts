import { resolveMediaProcessingIntent } from "./media-processing.js";

export type CommunicationModality = "text" | "image" | "audio" | "video";
export type CommunicationCapabilities = {
  /** Facts for this prepared model AND the selected adapter, not provider marketing metadata. */
  input: readonly CommunicationModality[];
  output: readonly ("text" | "audio")[];
};

/** Conversion planning never selects models, invokes providers or grants media access. */
export function planCommunicationMediaRoute(params: {
  source: readonly CommunicationModality[];
  target: CommunicationCapabilities;
  purpose?: "communication" | "analysis" | "recording" | "relay";
  output: "text" | "audio";
  converters: { stt: boolean; tts: boolean; videoFrames: boolean };
}) {
  if (!resolveMediaProcessingIntent(params).automaticUnderstanding) {
    return { kind: "passthrough" as const, steps: [], unsupported: [] };
  }
  const steps: Array<"stt" | "video-frames" | "tts"> = [];
  const unsupported: CommunicationModality[] = [];
  for (const source of new Set(params.source)) {
    if (params.target.input.includes(source)) {
      continue;
    }
    if (source === "audio" && params.target.input.includes("text") && params.converters.stt) {
      steps.push("stt");
    } else if (
      source === "video" &&
      params.target.input.includes("image") &&
      params.converters.videoFrames
    ) {
      steps.push("video-frames");
    } else {
      unsupported.push(source);
    }
  }
  if (!params.target.output.includes(params.output)) {
    if (
      params.output === "audio" &&
      params.target.output.includes("text") &&
      params.converters.tts
    ) {
      steps.push("tts");
    } else {
      unsupported.push(params.output);
    }
  }
  return {
    kind: unsupported.length ? ("unsupported" as const) : ("ready" as const),
    steps,
    unsupported: [...new Set(unsupported)],
  };
}
