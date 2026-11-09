import { getMatrixRuntime } from "../../runtime.js";
import type {
  DimensionalFileInfo,
  EncryptedFile,
  FileWithThumbnailInfo,
  MatrixClient,
} from "../sdk.js";
import type { MatrixMediaContent, MatrixMediaMsgType, MatrixRelation } from "./types.js";

export async function resolveMatrixVoiceWaveform(
  media: { buffer: Buffer; fileName?: string; contentType?: string },
  isVoice: boolean,
): Promise<number[] | undefined> {
  if (!isVoice) {
    return undefined;
  }
  return await getMatrixRuntime()
    .media.getAudioWaveform({
      audioBuffer: media.buffer,
      inputFileName: media.fileName,
      inputContentType: media.contentType,
    })
    .catch(() => undefined);
}

function buildMatrixMediaInfo(params: {
  size: number;
  mimetype?: string;
  durationMs?: number;
  imageInfo?: DimensionalFileInfo;
}): MatrixMediaContent["info"] {
  const base: FileWithThumbnailInfo = {};
  if (Number.isFinite(params.size)) {
    base.size = params.size;
  }
  if (params.mimetype) {
    base.mimetype = params.mimetype;
  }
  const info = params.imageInfo ? { ...base, ...params.imageInfo } : base;
  if (typeof params.durationMs === "number") {
    return { ...info, duration: params.durationMs };
  }
  if (!params.imageInfo && Object.keys(info).length === 0) {
    return undefined;
  }
  return info;
}

export function buildMediaContent(params: {
  msgtype: MatrixMediaMsgType;
  body: string;
  url?: string;
  filename?: string;
  mimetype?: string;
  size: number;
  relation?: MatrixRelation;
  isVoice?: boolean;
  durationMs?: number;
  waveform?: number[];
  imageInfo?: DimensionalFileInfo;
  file?: EncryptedFile;
}): MatrixMediaContent {
  const base: MatrixMediaContent = {
    msgtype: params.msgtype,
    body: params.body,
    filename: params.filename,
    info: buildMatrixMediaInfo(params),
  };
  // Encrypted media should only include the "file" payload, not top-level "url".
  if (!params.file && params.url) {
    base.url = params.url;
  }
  if (params.file) {
    base.file = params.file;
  }
  if (params.isVoice) {
    base["org.matrix.msc3245.voice"] = {};
    if (typeof params.durationMs === "number" || params.waveform?.length) {
      base["org.matrix.msc1767.audio"] = {
        ...(typeof params.durationMs === "number" ? { duration: params.durationMs } : {}),
        ...(params.waveform?.length ? { waveform: params.waveform } : {}),
      };
    }
  }
  if (params.relation) {
    base["m.relates_to"] = params.relation;
  }
  return base;
}

const THUMBNAIL_MAX_SIDE = 800;
const THUMBNAIL_QUALITY = 80;
export async function prepareImageInfo(params: {
  buffer: Buffer;
  client: MatrixClient;
  roomId: string;
}): Promise<DimensionalFileInfo | undefined> {
  const meta = await getMatrixRuntime()
    .media.getImageMetadata(params.buffer)
    .catch(() => null);
  if (!meta) {
    return undefined;
  }
  const imageInfo: DimensionalFileInfo = { w: meta.width, h: meta.height };
  const maxDim = Math.max(meta.width, meta.height);
  if (maxDim > THUMBNAIL_MAX_SIDE) {
    try {
      const thumbBuffer = await getMatrixRuntime().media.resizeToJpeg({
        buffer: params.buffer,
        maxSide: THUMBNAIL_MAX_SIDE,
        quality: THUMBNAIL_QUALITY,
        withoutEnlargement: true,
      });
      const thumbMeta = await getMatrixRuntime()
        .media.getImageMetadata(thumbBuffer)
        .catch(() => null);
      const result = await uploadMediaWithEncryption(params.client, params.roomId, thumbBuffer, {
        contentType: "image/jpeg",
        filename: "thumbnail.jpg",
      });
      if (result.file) {
        imageInfo.thumbnail_file = result.file;
      } else {
        imageInfo.thumbnail_url = result.url;
      }
      if (thumbMeta) {
        imageInfo.thumbnail_info = {
          w: thumbMeta.width,
          h: thumbMeta.height,
          mimetype: "image/jpeg",
          size: thumbBuffer.byteLength,
        };
      }
    } catch {
      // Thumbnail generation failed, continue without it
    }
  }
  return imageInfo;
}

export async function uploadMediaWithEncryption(
  client: MatrixClient,
  roomId: string,
  buffer: Buffer,
  params: {
    contentType?: string;
    filename?: string;
  },
): Promise<{ url: string; file?: EncryptedFile }> {
  // Downloads and thumbnail generation can yield while encryption changes;
  // resolve room policy at the upload boundary instead of reusing stale facts.
  if ((await client.prepareRoomForMessageSend(roomId)) === "m.room.encrypted") {
    if (!client.crypto) {
      throw new Error("Encrypted Matrix room: enable encryption before uploading media");
    }
    const encrypted = await client.crypto.encryptMedia(buffer);
    // Upload URLs and headers are visible; keep real media metadata inside
    // the encrypted room event instead of exposing it with the ciphertext.
    const mxc = await client.uploadContent(encrypted.buffer, "application/octet-stream");
    const file: EncryptedFile = { url: mxc, ...encrypted.file };
    return {
      url: mxc,
      file,
    };
  }

  const mxc = await client.uploadContent(buffer, params.contentType, params.filename);
  return { url: mxc };
}
