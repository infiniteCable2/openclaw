export type MatrixRtcVideoOptions = {
  enabled: boolean;
  intervalMs?: number;
  maxSourceDimension?: number;
  maxSourceBytes?: number;
};

export type MatrixRtcVideoFrame = {
  data: Buffer;
  mimeType: "image/png";
  timestampMs: number;
  sourceId: string;
};

const HEADER_BYTES = 32;
const MAX_SOURCE_DIMENSION = 4_096;
const MAX_SOURCE_BYTES = 32 * 1_024 * 1_024;

export function resolveMatrixRtcVideoLimits(options: MatrixRtcVideoOptions) {
  const intervalMs = options.intervalMs ?? 1_000;
  const maxSourceDimension = options.maxSourceDimension ?? 1_920;
  const maxSourceBytes = options.maxSourceBytes ?? 16 * 1_024 * 1_024;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 250 ||
    intervalMs > 60_000 ||
    !Number.isSafeInteger(maxSourceDimension) ||
    maxSourceDimension < 64 ||
    maxSourceDimension > MAX_SOURCE_DIMENSION ||
    !Number.isSafeInteger(maxSourceBytes) ||
    maxSourceBytes < 4_096 ||
    maxSourceBytes > MAX_SOURCE_BYTES
  ) {
    throw new Error("MatrixRTC video capture limits are invalid");
  }
  return { intervalMs, maxSourceDimension, maxSourceBytes };
}

/** The private bridge sends only bounded, tightly packed, already rotated RGBA. */
export function decodeMatrixRtcVideoHeader(header: Buffer, options: MatrixRtcVideoOptions) {
  const limits = resolveMatrixRtcVideoLimits(options);
  if (
    header.length !== HEADER_BYTES ||
    header.subarray(0, 4).toString("ascii") !== "OCVF" ||
    header[4] !== 1 ||
    header[5] !== 1 ||
    header.readUInt16BE(6) !== 0
  ) {
    throw new Error("MatrixRTC video frame header is invalid");
  }
  const timestamp = header.readBigUInt64BE(8);
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  const source = header.readUInt32BE(24);
  const bytes = header.readUInt32BE(28);
  if (
    timestamp > BigInt(Number.MAX_SAFE_INTEGER) ||
    !width ||
    !height ||
    !source ||
    width > limits.maxSourceDimension ||
    height > limits.maxSourceDimension ||
    bytes !== width * height * 4 ||
    bytes > limits.maxSourceBytes
  ) {
    throw new Error("MatrixRTC video frame exceeds the admitted limits");
  }
  return { timestampMs: Number(timestamp), width, height, sourceId: `video-${source}`, bytes };
}

/** One frame is encoded at a time; socket backpressure never touches the PCM stream. */
export async function consumeMatrixRtcVideo(params: {
  source: AsyncIterable<Buffer>;
  options: MatrixRtcVideoOptions;
  isCurrent: () => boolean;
  onFrame: (frame: MatrixRtcVideoFrame) => void;
}) {
  const { encodePngRgbaAsync } = await import("openclaw/plugin-sdk/media-runtime");
  let buffered: Buffer[] = [];
  let bufferedBytes = 0;
  let header: ReturnType<typeof decodeMatrixRtcVideoHeader> | undefined;
  let needed = HEADER_BYTES;
  for await (const chunk of params.source) {
    if (!params.isCurrent()) {
      return;
    }
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(needed - bufferedBytes, chunk.length - offset);
      buffered.push(chunk.subarray(offset, offset + take));
      bufferedBytes += take;
      offset += take;
      if (bufferedBytes !== needed) {
        continue;
      }
      const value = Buffer.concat(buffered, bufferedBytes);
      buffered = [];
      bufferedBytes = 0;
      if (!header) {
        header = decodeMatrixRtcVideoHeader(value, params.options);
        needed = header.bytes;
        continue;
      }
      const data = await encodePngRgbaAsync(value, header.width, header.height);
      if (!params.isCurrent()) {
        return;
      }
      if (data.byteLength <= (params.options.maxSourceBytes ?? 16 * 1_024 * 1_024)) {
        params.onFrame({
          data,
          mimeType: "image/png",
          timestampMs: header.timestampMs,
          sourceId: header.sourceId,
        });
      }
      header = undefined;
      needed = HEADER_BYTES;
    }
  }
  if (params.isCurrent() && (header || bufferedBytes)) {
    throw new Error("MatrixRTC video stream ended inside a frame");
  }
}
