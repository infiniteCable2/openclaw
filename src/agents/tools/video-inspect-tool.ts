import { normalizeMimeType } from "@openclaw/media-core/mime";
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureAmbientGatewayOperatorAuthority } from "../../gateway/operator-invocation-authority.js";
import { resolveMediaUnderstandingScope } from "../../media-understanding/scope.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import { isVideoFrameSource } from "../../media/video-frame-source.js";
import type { RenderedVideoFrame, VideoFrameProfile } from "../../media/video-frames.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { createSandboxBridgeReadFile } from "../sandbox-media-paths.js";
import { optionalPositiveIntegerSchema, optionalStringEnum } from "../schema/typebox.js";
import type { ToolFsPolicy } from "../tool-fs-policy.js";
import {
  asToolParamsRecord,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";
import { buildNativeImageToolResult } from "./image-tool.result.js";
import {
  resolveMediaToolInboundRoots,
  resolveMediaToolReferenceAccess,
  resolveMediaToolSandboxConfig,
  type MediaToolSandbox,
} from "./media-tool-shared.js";
import { jsonResult } from "./tool-results.js";

type VideoInspectOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  cwd?: string;
  fsPolicy?: ToolFsPolicy;
  sandbox?: MediaToolSandbox;
  modelHasVision?: boolean;
  agentChannel?: string | null;
  agentAccountId?: string | null;
  currentChannelId?: string | null;
  currentChatType?: string;
  agentSessionKey?: string;
  runSessionKey?: string;
  assertInvocationCurrent?: () => void;
  toolBindings?: Readonly<Record<string, unknown>>;
};

function readProfile(value: unknown, fallback: VideoFrameProfile = "preview"): VideoFrameProfile {
  if (value === undefined) {
    return fallback;
  }
  if (value === "preview" || value === "detail" || value === "source") {
    return value;
  }
  throw new ToolInputError("profile must be preview, detail, or source");
}

/** Native frame inspection never selects another model or describes an image through a second provider. */
export function createVideoInspectTool(options: VideoInspectOptions): AnyAgentTool | null {
  const config = options.config?.tools?.media?.video;
  const frameSource = isVideoFrameSource(options.toolBindings?.video_inspect)
    ? options.toolBindings.video_inspect
    : undefined;
  if (
    options.modelHasVision !== true ||
    config?.enabled === false ||
    (!frameSource && config?.frames?.enabled !== true) ||
    resolveMediaUnderstandingScope({
      scope: config?.scope,
      channel: options.agentChannel ?? options.currentChannelId ?? undefined,
      chatType: options.currentChatType,
      sessionKey: options.runSessionKey ?? options.agentSessionKey,
    }) === "deny"
  ) {
    return null;
  }
  return {
    name: "video_inspect",
    label: "Inspect Video",
    catalogMode: "direct-only",
    description:
      "Inspect a local/media:// video without another model call: info returns metadata; overview samples frames; frames inspects exact times. save writes the selected frames to workspace media/video-frames independently of the live buffer, returning file paths without sending images. save defaults to source quality; other actions default to configured preview. detail/source revisit the original, not recovery of lost detail. A frameId revisits an exact retained live frame; expired references are not substituted. Retention metadata is a current estimate: unpinned frames may be evicted earlier under memory pressure or session close. Inspection images enter private model context, not user chat. This is not semantic video search.",
    parameters: Type.Object({
      action: optionalStringEnum(["info", "overview", "frames", "save"]),
      path: Type.Optional(
        Type.String({
          description:
            "One accessible local path, file:// URL, or media:// attachment reference. Not an HTTP URL.",
        }),
      ),
      frameId: Type.Optional(
        Type.String({
          description:
            "Exact retained live-frame reference, instead of path. info, frames, or save.",
        }),
      ),
      timestampsSeconds: Type.Optional(
        Type.Array(Type.Number({ minimum: 0 }), {
          minItems: 1,
          maxItems: 12,
          description:
            "Required for frames/save with path. Seconds from video start; less than duration.",
        }),
      ),
      count: optionalPositiveIntegerSchema({
        maximum: 12,
        description: "Overview sample count; default is the configured frame count or 3.",
      }),
      profile: optionalStringEnum(["preview", "detail", "source"]),
      maxSide: optionalPositiveIntegerSchema({
        maximum: 8192,
        description: "Preview/detail longest side, 64..8192 pixels; no enlargement.",
      }),
      targetBytes: optionalPositiveIntegerSchema({
        maximum: 16 * 1024 * 1024,
        description:
          "Preview/detail target bytes, 4096..16777216. Source does not add lossy compression; model image limits still apply.",
      }),
    }),
    execute: async (_id, args, suppliedSignal) =>
      runWithAsyncWorkResources(async (onAcquired) => {
        const record = { ...asToolParamsRecord(args) };
        if (Array.isArray(record.timestampsSeconds)) {
          record.timestampsSeconds = [...record.timestampsSeconds];
        }
        const captured = await captureAmbientGatewayOperatorAuthority({
          missingBindingError: () =>
            new Error("Video inspection requires its current Gateway binding."),
          retainInherited: true,
        });
        if (captured.release) {
          onAcquired({ release: captured.release });
        }
        const signal = captured.authority?.signal
          ? suppliedSignal
            ? AbortSignal.any([suppliedSignal, captured.authority.signal])
            : captured.authority.signal
          : suppliedSignal;
        const assertCurrent = () => {
          options.assertInvocationCurrent?.();
          captured.assertInvocationCurrent?.();
          captured.authority?.assertCurrent();
          signal?.throwIfAborted();
        };
        assertCurrent();
        const path = readToolStringParam(record, "path");
        const frameId = readToolStringParam(record, "frameId");
        if (Boolean(path) === Boolean(frameId)) {
          throw new ToolInputError("Provide exactly one path or frameId");
        }
        const action = readToolStringParam(record, "action") ?? (frameId ? "frames" : "info");
        if (
          action !== "info" &&
          action !== "overview" &&
          action !== "frames" &&
          action !== "save"
        ) {
          throw new ToolInputError("action must be info, overview, frames, or save");
        }
        const profile = readProfile(
          record.profile,
          action === "save" ? "source" : config?.frames?.profile,
        );
        const saveFrames = async (
          frames: readonly RenderedVideoFrame[],
          assertSourceCurrent = assertCurrent,
        ) => {
          const { saveInspectedVideoFrames } = await import("./video-inspect-save.js");
          assertCurrent();
          const files = await saveInspectedVideoFrames({
            frames,
            workspaceDir: options.fsPolicy?.root ?? options.workspaceDir ?? options.cwd,
            sandbox: options.sandbox,
            signal,
            assertCurrent: assertSourceCurrent,
          });
          assertCurrent();
          return {
            files,
            storage: "workspace",
            automaticExpiry: false,
            media: { outbound: false },
          };
        };
        const maxSide =
          readPositiveIntegerParam(record, "maxSide", { max: 8192 }) ?? config?.frames?.maxSide;
        const targetBytes =
          readPositiveIntegerParam(record, "targetBytes", { max: 16 * 1024 * 1024 }) ??
          config?.frames?.targetBytes;
        if (
          (maxSide !== undefined && maxSide < 64) ||
          (targetBytes !== undefined && targetBytes < 4096)
        ) {
          throw new ToolInputError(
            "maxSide must be at least 64; targetBytes must be at least 4096",
          );
        }
        if (frameId) {
          if (!frameSource) {
            throw new ToolInputError("This invocation has no retained live-frame source");
          }
          if (action === "overview" || record.timestampsSeconds !== undefined) {
            throw new ToolInputError(
              "A live frameId supports info, frames, or save without timestampsSeconds",
            );
          }
          frameSource.assertCurrent();
          const frame = frameSource.read(frameId);
          assertCurrent();
          frameSource.assertCurrent();
          if (!frame || frame.id !== frameId) {
            throw new ToolInputError(
              "The exact live frame is unavailable or expired; request a new observation",
            );
          }
          if (action === "info") {
            return jsonResult({
              frameId: frame.id,
              timestampMs: frame.timestampMs,
              mimeType: frame.mimeType,
              retention: frame.retention,
              media: { outbound: false },
            });
          }
          const { renderVideoFrameBuffer } = await import("../../media/video-frames.js");
          assertCurrent();
          const rendered = await renderVideoFrameBuffer({
            buffer: frame.data,
            profile,
            maxSide,
            targetBytes,
            signal,
          });
          assertCurrent();
          frameSource.assertCurrent();
          if (action === "save") {
            return jsonResult({
              ...(await saveFrames([rendered], () => {
                assertCurrent();
                frameSource.assertCurrent();
              })),
              frameId: frame.id,
              timestampMs: frame.timestampMs,
              profile,
            });
          }
          const result = await buildNativeImageToolResult(
            [{ buffer: rendered.buffer, mimeType: rendered.mimeType, resolvedInput: frame.id }],
            options.config,
          );
          assertCurrent();
          frameSource.assertCurrent();
          return {
            ...result,
            content: [
              {
                type: "text",
                text: `Frame ${frame.id}. Retention: ${JSON.stringify(frame.retention ?? null)}. Unpinned frames may be evicted earlier under memory pressure; session close removes all live frames. Use save to keep a workspace copy.`,
              },
              ...result.content,
            ],
            details: {
              frameId: frame.id,
              timestampMs: frame.timestampMs,
              retention: frame.retention,
              profile,
              transport: "native",
              media: { outbound: false },
            },
          };
        }
        if (config?.frames?.enabled !== true) {
          throw new ToolInputError("Uploaded video inspection is not enabled for this invocation");
        }
        const input = normalizeMediaReferenceSource((path ?? "").replace(/^@\s*/, ""));
        const reference = classifyMediaReferenceSource(input);
        if (reference.hasUnsupportedScheme || reference.isHttpUrl || reference.isDataUrl) {
          throw new ToolInputError(
            "video_inspect requires an accessible local path, file:// URL, or media:// attachment reference",
          );
        }
        const sandbox = resolveMediaToolSandboxConfig(
          options.sandbox,
          options.fsPolicy?.workspaceOnly,
        );
        const access = await resolveMediaToolReferenceAccess({
          input,
          isDataUrl: false,
          workspaceDir: options.workspaceDir,
          cwd: options.cwd,
          fsPolicy: options.fsPolicy,
          sandbox,
        });
        assertCurrent();
        const { loadWebMedia } = await import("../../media/web-media.js");
        const {
          probeVideoBuffer,
          extractVideoFrames,
          buildVideoOverviewTimestamps,
          MAX_VIDEO_FRAME_SOURCE_BYTES,
          MAX_VIDEO_FRAME_COUNT,
        } = await import("../../media/video-frames.js");
        assertCurrent();
        const media = await loadWebMedia(access.resolvedPath ?? input, {
          maxBytes: MAX_VIDEO_FRAME_SOURCE_BYTES,
          ...(sandbox
            ? { sandboxValidated: true, readFile: createSandboxBridgeReadFile({ sandbox }) }
            : {
                localRoots: access.localRoots,
                inboundRoots: resolveMediaToolInboundRoots({
                  workspaceOnly: options.fsPolicy?.workspaceOnly,
                  cfg: options.config,
                  channelId: options.agentChannel ?? options.currentChannelId,
                  accountId: options.agentAccountId,
                }),
              }),
        });
        assertCurrent();
        if (media.kind !== "video" || !normalizeMimeType(media.contentType)?.startsWith("video/")) {
          throw new ToolInputError("The referenced media is not a supported video");
        }
        const metadata = await probeVideoBuffer({ buffer: media.buffer, signal });
        assertCurrent();
        if (action === "info") {
          return jsonResult({ ...metadata, source: input, media: { outbound: false } });
        }
        let timestamps: number[];
        if (action === "overview") {
          const count =
            readPositiveIntegerParam(record, "count", { max: MAX_VIDEO_FRAME_COUNT }) ??
            config.frames.maxFrames ??
            3;
          timestamps = buildVideoOverviewTimestamps(metadata.durationSeconds, count);
        } else {
          const raw = record.timestampsSeconds;
          if (
            !Array.isArray(raw) ||
            raw.length < 1 ||
            raw.length > MAX_VIDEO_FRAME_COUNT ||
            raw.some(
              (time) =>
                typeof time !== "number" ||
                !Number.isFinite(time) ||
                time < 0 ||
                time >= metadata.durationSeconds,
            )
          ) {
            throw new ToolInputError(
              `timestampsSeconds must contain 1..${MAX_VIDEO_FRAME_COUNT} finite times within the video duration`,
            );
          }
          timestamps = raw.map((time: number) => time);
        }
        const frames = await extractVideoFrames({
          buffer: media.buffer,
          timestampsSeconds: timestamps,
          profile,
          maxSide,
          targetBytes,
          signal,
        });
        assertCurrent();
        if (action === "save") {
          return jsonResult({
            ...(await saveFrames(frames)),
            source: input,
            profile,
            timestampsSeconds: frames.map((frame) => frame.timestampSeconds),
          });
        }
        const result = await buildNativeImageToolResult(
          frames.map((frame) => ({
            buffer: frame.buffer,
            mimeType: frame.mimeType,
            resolvedInput: input,
          })),
          options.config,
        );
        assertCurrent();
        return {
          content: [
            {
              type: "text",
              text: `Video ${metadata.durationSeconds.toFixed(3)}s. Requested frame times (seconds): ${frames.map((frame) => frame.timestampSeconds.toFixed(3)).join(", ")}. Profile: ${profile}. Sampled frames do not describe the entire video; original remains available for re-extraction. ${metadata.hasAudio ? "Audio is present but is not transcribed by this tool." : "No audio track detected."}`,
            },
            ...result.content,
          ],
          details: {
            ...metadata,
            source: input,
            profile,
            timestampsSeconds: frames.map((frame) => frame.timestampSeconds),
            transport: "native",
            media: { outbound: false },
          },
        };
      }),
  };
}
