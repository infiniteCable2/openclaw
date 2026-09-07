import path from "node:path";
import type { MatrixRtcAdmission, MatrixRtcConfig } from "../types.js";

export type ResolvedMatrixRtcConfig = {
  authServiceUrl: string;
  mediaBridgeCommand: string;
  transcriptionProvider: string;
  providers: Record<string, Record<string, unknown>>;
  toolPolicy: "safe-read-only" | "owner" | "none";
  responseStreaming: "off" | "sentence";
  admissions: MatrixRtcAdmission[];
};

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`MatrixRTC ${label} is required when rtc.enabled is true`);
  }
  return value.trim();
}

function normalizedAuthServiceUrl(value: unknown): string {
  const raw = requiredString(value, "authServiceUrl");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MatrixRTC authServiceUrl must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(
      "MatrixRTC authServiceUrl must use HTTPS without credentials, query, or fragment",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function validateAdmission(value: MatrixRtcAdmission, index: number): MatrixRtcAdmission {
  const roomId = requiredString(value.roomId, `admissions[${index}].roomId`);
  const userId = requiredString(value.userId, `admissions[${index}].userId`);
  const agentId = requiredString(value.agentId, `admissions[${index}].agentId`);
  if (!roomId.startsWith("!") || !roomId.includes(":")) {
    throw new Error(`MatrixRTC admissions[${index}].roomId must be an exact Matrix room ID`);
  }
  if (!userId.startsWith("@") || !userId.includes(":")) {
    throw new Error(`MatrixRTC admissions[${index}].userId must be an exact Matrix user ID`);
  }
  if (roomId.includes("*") || userId.includes("*") || agentId.includes("*")) {
    throw new Error(`MatrixRTC admissions[${index}] cannot contain wildcards`);
  }
  return { roomId, userId, agentId };
}

export function resolveMatrixRtcConfig(
  config: MatrixRtcConfig | undefined,
): ResolvedMatrixRtcConfig | null {
  if (config?.enabled !== true) {
    return null;
  }
  const mediaBridgeCommand = requiredString(config.mediaBridgeCommand, "mediaBridgeCommand");
  if (!path.isAbsolute(mediaBridgeCommand)) {
    throw new Error("MatrixRTC mediaBridgeCommand must be an absolute path");
  }
  const transcriptionProvider = requiredString(
    config.transcriptionProvider,
    "transcriptionProvider",
  );
  const admissions = (config.admissions ?? []).map(validateAdmission);
  if (admissions.length === 0) {
    throw new Error("MatrixRTC requires at least one exact admission");
  }
  const seenRooms = new Set<string>();
  for (const admission of admissions) {
    if (seenRooms.has(admission.roomId)) {
      throw new Error(`MatrixRTC room ${admission.roomId} has more than one admission`);
    }
    seenRooms.add(admission.roomId);
  }
  return {
    authServiceUrl: normalizedAuthServiceUrl(config.authServiceUrl),
    mediaBridgeCommand,
    transcriptionProvider,
    providers: config.providers ?? {},
    toolPolicy: config.toolPolicy ?? "safe-read-only",
    responseStreaming: config.responseStreaming ?? "off",
    admissions,
  };
}

export function findMatrixRtcAdmission(
  config: ResolvedMatrixRtcConfig,
  roomId: string,
): MatrixRtcAdmission | undefined {
  return config.admissions.find((entry) => entry.roomId === roomId);
}
