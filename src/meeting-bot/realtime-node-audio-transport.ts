import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import { sleep } from "../utils/sleep.js";
import { decodeMeetingAudioBase64 } from "./audio-base64.js";
import { createMeetingOutputLoopbackVerifier } from "./output-loopback-verifier.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";

const NODE_OUTPUT_GENERATION_CAPABILITY = Symbol.for(
  "openclaw.internal.meeting-node-output-generation.v1",
);
// Bound one node RPC to at most 500 ms of 24-kHz mono PCM. Small writes keep
// device-side playout backpressure below the invoke timeout and let a fenced
// clear preempt a long TTS segment without queueing its remaining audio.
const MAX_NODE_OUTPUT_CHUNK_BYTES = 24_000;

function readNodeAudioResult(raw: unknown): Record<string, unknown> {
  const envelope = asOptionalRecord(raw);
  const payloadJSON = readNonBlankString(envelope?.payloadJSON);
  if (payloadJSON) {
    return asOptionalRecord(JSON.parse(payloadJSON)) ?? {};
  }
  return asOptionalRecord(envelope?.payload ?? raw) ?? {};
}

export function createNodeMeetingRealtimeAudioTransport(params: {
  runtime: PluginRuntime;
  nodeId: string;
  bridgeId: string;
  logger: RuntimeLogger;
  /** Platform registration owns this stable command name; paired nodes call it verbatim. */
  commandName: string;
  logScope: string;
  logPrefix: string;
  audioFormat?: MeetingRealtimeAudioFormat;
  /** Generation returned by a node's start command; enables stale-output fencing. */
  initialOutputGeneration?: number;
}): MeetingRealtimeAudioTransport {
  if (
    params.initialOutputGeneration !== undefined &&
    (!Number.isSafeInteger(params.initialOutputGeneration) || params.initialOutputGeneration < 0)
  ) {
    throw new Error("invalid initial node output generation");
  }
  let stopped = false;
  let inputStarted = false;
  let consecutiveInputErrors = 0;
  let lastInputError: string | undefined;
  let fatalSignaled = false;
  let fatalHandler: (() => void) | undefined;
  let outputGeneration = params.initialOutputGeneration ?? 0;
  let outputGenerationSupported = params.initialOutputGeneration !== undefined;
  let legacyOutputTail = Promise.resolve();
  const outputLoopbackVerifier = createMeetingOutputLoopbackVerifier({
    audioFormat: params.audioFormat ?? "pcm16-24khz",
  });
  const invoke = (action: string, payload: Record<string, unknown> = {}, timeoutMs = 5_000) =>
    params.runtime.nodes.invoke({
      nodeId: params.nodeId,
      command: params.commandName,
      params: { action, bridgeId: params.bridgeId, ...payload },
      timeoutMs,
    });
  const runOutputCommand = <T>(task: () => Promise<T>): Promise<T> => {
    if (outputGenerationSupported) {
      return task();
    }
    const result = legacyOutputTail.then(task, task);
    legacyOutputTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const signalFatal = () => {
    if (!fatalSignaled) {
      fatalSignaled = true;
      fatalHandler?.();
    }
  };

  const transport: MeetingRealtimeAudioTransport = {
    onFatal: (handler) => {
      fatalHandler = handler;
      if (fatalSignaled) {
        handler();
      }
    },
    startInput: (onAudio) => {
      if (inputStarted) {
        throw new Error("audio input transport already started");
      }
      inputStarted = true;
      void (async () => {
        for (;;) {
          if (stopped) {
            break;
          }
          try {
            // Long-poll cadence bounds both normal input latency and transient-error retries.
            const raw = await invoke("pullAudio", { timeoutMs: 250 }, 2_000);
            if (stopped) {
              break;
            }
            const result = readNodeAudioResult(raw);
            const base64 = readNonBlankString(result.base64);
            if (base64) {
              const audio = decodeMeetingAudioBase64(base64, "pullAudio");
              outputLoopbackVerifier.recordInput(audio);
              onAudio(audio);
            }
            consecutiveInputErrors = 0;
            lastInputError = undefined;
            if (result.closed === true) {
              signalFatal();
              break;
            }
          } catch (error) {
            if (stopped) {
              break;
            }
            const message = formatErrorMessage(error);
            consecutiveInputErrors += 1;
            lastInputError = message;
            params.logger.warn(
              `${params.logScope} ${params.logPrefix} audio input failed (${consecutiveInputErrors}/5): ${message}`,
            );
            if (
              consecutiveInputErrors >= 5 ||
              /unknown bridgeId|bridge is not open/i.test(message)
            ) {
              signalFatal();
              break;
            }
            await sleep(250);
          }
        }
      })();
    },
    beginOutput: () => outputLoopbackVerifier.beginOutput(),
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      outputLoopbackVerifier.cancelOutput();
      try {
        await invoke("stop");
      } catch (error) {
        params.logger.debug?.(
          `${params.logScope} node audio bridge stop ignored: ${formatErrorMessage(error)}`,
        );
      }
    },
    writeOutput: async (audio) => {
      if (stopped) {
        return;
      }
      const generation = outputGeneration;
      try {
        await runOutputCommand(async () => {
          for (let offset = 0; offset < audio.byteLength; offset += MAX_NODE_OUTPUT_CHUNK_BYTES) {
            if (stopped || (outputGenerationSupported && generation !== outputGeneration)) {
              return;
            }
            const chunk = audio.subarray(offset, offset + MAX_NODE_OUTPUT_CHUNK_BYTES);
            const response = await params.runtime.nodes.invoke({
              nodeId: params.nodeId,
              command: params.commandName,
              params: {
                action: "pushAudio",
                bridgeId: params.bridgeId,
                base64: chunk.toString("base64"),
                ...(outputGenerationSupported ? { outputGeneration: generation } : {}),
              },
              timeoutMs: 5_000,
            });
            if (stopped || (outputGenerationSupported && generation !== outputGeneration)) {
              return;
            }
            const responseRecord = readNodeAudioResult(response);
            if (responseRecord?.dropped === true || responseRecord?.stale === true) {
              throw new Error("node rejected current audio output generation");
            }
            outputLoopbackVerifier.recordOutput(chunk);
          }
        });
      } catch (error) {
        if (!stopped && generation === outputGeneration) {
          outputLoopbackVerifier.cancelOutput();
        }
        throw error;
      }
    },
    clearOutput: async () => {
      if (stopped) {
        return;
      }
      outputGeneration += 1;
      outputLoopbackVerifier.cancelOutput();
      await runOutputCommand(async () => {
        if (stopped) {
          return;
        }
        await invoke("clearAudio", outputGenerationSupported ? { outputGeneration } : {});
      });
    },
    dispose: async () => {
      await transport.stop();
    },
    getHealth: () => ({
      consecutiveInputErrors,
      lastInputError,
      ...outputLoopbackVerifier.getHealth(),
    }),
  };

  Object.defineProperty(transport, NODE_OUTPUT_GENERATION_CAPABILITY, {
    get() {
      return outputGenerationSupported;
    },
    set(value) {
      outputGenerationSupported = value === true;
    },
  });

  return transport;
}
