import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { acquireTestPortBlock } from "../../src/test-utils/port-claims.js";
import {
  connectConversationOperator,
  isolateConversationGatewayEnvironment,
  startConversationModel,
} from "./conversation-branches-gateway.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";
import { createDeferred, withinTest } from "./promise.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

const FIRST = "LOCAL_CAPTURE_A_COBALT_23";
const SECOND = "LOCAL_CAPTURE_B_AMBER_61";

async function requireStagedLocalMedia(root: string) {
  if (!path.isAbsolute(root)) {
    throw new Error("The selected local-media plugin root must be absolute");
  }
  const canonical = await fs.realpath(root);
  const manifest: unknown = JSON.parse(
    await fs.readFile(path.join(canonical, "openclaw.plugin.json"), "utf8"),
  );
  if (!isRecord(manifest)) throw new Error("The staged local-media manifest must be an object");
  expect(manifest.id).toBe("local-media");
  const entry = await fs.realpath(path.join(canonical, "dist/index.js"));
  expect(path.relative(canonical, entry).startsWith("..")).toBe(false);
  expect((await fs.stat(entry)).isFile()).toBe(true);
  const host = await fs.realpath(process.env.OPENCLAW_E2E_INSTALLED_PACKAGE_ROOT ?? process.cwd());
  expect(await fs.realpath(path.join(canonical, "node_modules/openclaw"))).toBe(host);
  return canonical;
}

/** Only the neural decoder is synthetic; the selected plugin owns real batching/endpoints. */
async function startDecoder(signal: AbortSignal) {
  const claim = await acquireTestPortBlock({ offsets: [0], signal });
  const firstRequest = createDeferred<void>();
  void firstRequest.promise.catch(() => {});
  const releaseFirst = createDeferred<void>();
  const requests: number[] = [];
  const errors: unknown[] = [];
  const tasks = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const work = (async () => {
      if (request.method === "POST" && /^\/v1\/requests\/[^/]+\/cancel$/u.test(request.url ?? "")) {
        response.writeHead(204).end();
        return;
      }
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/audio/transcriptions");
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        expect(length).toBeLessThanOrEqual(256 * 1024);
        chunks.push(bytes);
      }
      const form = await new Response(Uint8Array.from(Buffer.concat(chunks)).buffer, {
        headers: { "content-type": String(request.headers["content-type"]) },
      }).formData();
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      if (!(file instanceof File)) throw new Error("Synthetic decoder requires actual WAV input");
      const wav = Buffer.from(await file.arrayBuffer());
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
      expect(wav.readUInt32LE(24)).toBe(8_000);
      expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
      let squares = 0;
      for (let offset = 44; offset < wav.length; offset += 2) {
        squares += wav.readInt16LE(offset) ** 2;
      }
      expect(Math.sqrt(squares / ((wav.length - 44) / 2))).toBeGreaterThan(1_000);
      const index = requests.push((wav.length - 44) / 16);
      expect(index).toBeLessThanOrEqual(2);
      if (index === 1) {
        firstRequest.resolve();
        await withinTest(releaseFirst.promise, signal);
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"type":"speech.confirmed"}\n\n' +
          `data: ${JSON.stringify({ type: "transcript.done", text: index === 1 ? FIRST : SECOND, model: "synthetic" })}\n\n`,
      );
    })();
    tasks.add(work);
    void work
      .catch((error: unknown) => {
        errors.push(error);
        firstRequest.reject(error);
        response.writeHead(500).end();
      })
      .finally(() => tasks.delete(work));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(claim.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await claim.release();
    throw error;
  }
  return {
    baseUrl: `http://127.0.0.1:${claim.port}/v1`,
    firstRequest: firstRequest.promise,
    release: () => releaseFirst.resolve(),
    requests,
    errors,
    async stop() {
      releaseFirst.resolve();
      server.closeAllConnections();
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await Promise.allSettled(tasks);
      } finally {
        await claim.release();
      }
    },
  };
}

function pcm(ms: number, voiced: boolean) {
  const audio = Buffer.alloc(ms * 32);
  if (voiced) {
    for (let offset = 0; offset < audio.length; offset += 2) {
      audio.writeInt16LE((offset / 2) % 32 < 16 ? 8_000 : -8_000, offset);
    }
  }
  return audio;
}

export async function playLocalMediaInputEnd(params: {
  pluginRoot: string;
  configuration(baseUrl: string): OpenClawConfig;
  signal: AbortSignal;
  verifyCleanup(cleanup: () => Promise<void>): Promise<void>;
}) {
  const pluginRoot = await requireStagedLocalMedia(params.pluginRoot);
  let decoder: Awaited<ReturnType<typeof startDecoder>> | undefined;
  let model: Awaited<ReturnType<typeof startConversationModel>> | undefined;
  let gateway: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
  let operator: Awaited<ReturnType<typeof connectConversationOperator>> | undefined;
  let releaseModel: (() => void) | undefined;
  let phase = "startup";
  return await runQaGatewayFixture(
    async () => {
      decoder = await startDecoder(params.signal);
      model = await startConversationModel(
        params.signal,
        (_request, index) => `ENDPOINT_REPLY_${index}.`,
      );
      const config = params.configuration(model.baseUrl);
      config.messages = { queue: { mode: "followup" } };
      config.talk = {
        ...config.talk,
        speech: { agentProfiles: { main: { inputEndMode: "client" } } },
      };
      config.plugins!.load!.paths!.push(pluginRoot);
      config.plugins!.entries!["local-media"] = { enabled: true };
      config.plugins!.entries!["voice-call"] = {
        enabled: false,
        config: {
          streaming: {
            providers: {
              "local-media": {
                baseUrl: decoder.baseUrl,
                speechOnsetMs: 40,
                minSpeechMs: 40,
                silenceMs: 200,
                preRollMs: 40,
                maxUtteranceMs: 1_000,
              },
            },
          },
        },
      };
      gateway = await createOpenClawTestInstance({
        name: "local-media-client-input",
        signal: params.signal,
        verifyCleanup: params.verifyCleanup,
        config,
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
          OPENCLAW_LOG_LEVEL: "debug",
        },
      });
      isolateConversationGatewayEnvironment(gateway);
      const captureA = randomUUID(),
        captureB = randomUUID(),
        captureEmpty = randomUUID();
      const outcomes = new Map(
        [captureA, captureB, captureEmpty].map((id) => [
          id,
          createDeferred<Record<string, unknown>>(),
        ]),
      );
      const firstTranscript = createDeferred<void>(),
        outputs = createDeferred<void>();
      const frames: Buffer[] = [],
        events: Record<string, unknown>[] = [];
      const assistantReplies = new Set<string>();
      let audioDone = 0;
      for (const promise of [
        firstTranscript.promise,
        outputs.promise,
        ...[...outcomes.values()].map((gate) => gate.promise),
      ])
        void promise.catch(() => {});
      await gateway.startGateway();
      operator = await connectConversationOperator(gateway, "alex@example.test", params.signal, {
        scopes: ["operator.read", "operator.write", "operator.talk"],
        onEvent(event, value) {
          if (event !== "talk.event" || !isRecord(value)) return;
          events.push(value);
          if (value.type === "audio" && typeof value.audioBase64 === "string")
            frames.push(Buffer.from(value.audioBase64, "base64"));
          if (value.type === "transcript" && value.final === true) {
            if (value.role === "user" && value.text === FIRST) firstTranscript.resolve();
            if (value.role === "assistant" && typeof value.text === "string")
              assistantReplies.add(value.text);
          }
          const talk = value.talkEvent;
          if (isRecord(talk)) {
            if (talk.type === "output.audio.done") audioDone++;
            if (talk.type === "session.error") {
              const error = new Error(`Native Talk failed: ${JSON.stringify(talk)}`);
              firstTranscript.reject(error);
              outputs.reject(error);
              for (const gate of outcomes.values()) gate.reject(error);
            }
            if (
              talk.type === "input.outcome" &&
              typeof talk.captureId === "string" &&
              isRecord(talk.payload) &&
              talk.payload.scope === "capture"
            )
              outcomes.get(talk.captureId)?.resolve(talk);
          }
          // B's finalized input intentionally supersedes A's held output
          // generation. Both native requests remain valid; only B is audible.
          if (audioDone === 1 && assistantReplies.has("ENDPOINT_REPLY_2.")) outputs.resolve();
        },
      });
      const voiceKey = `agent:main:voice:local-end-${randomUUID()}`;
      const created = await operator.call<{
        sessionId: string;
        readyMark: string;
        audio: { inputEndMode: string };
      }>("talk.session.create", {
        sessionKey: voiceKey,
        mode: "stt-tts",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "local-media",
        capabilities: ["activity-v1", "isolated-input", "output-gate", "input-end"],
      });
      expect(created.audio.inputEndMode).toBe("client");
      await operator.call("talk.session.acknowledgeMark", {
        sessionId: created.sessionId,
        markName: created.readyMark,
      });
      const append = (captureId: string, audio: Buffer) =>
        operator!.call("talk.session.appendAudio", {
          sessionId: created.sessionId,
          captureId,
          audioBase64: audio.toString("base64"),
        });
      const end = (captureId: string) =>
        operator!.call("talk.session.appendAudio", {
          sessionId: created.sessionId,
          captureId,
          audioBase64: "",
          endOfInput: true,
        });
      const heldModel = model.holdNext(() => true);
      releaseModel = heldModel.release;
      phase = "pause-before-client-end";
      await append(captureA, Buffer.concat([pcm(200, true), pcm(400, false)]));
      expect(decoder.requests).toEqual([]);
      expect(model.requests).toEqual([]);
      await append(captureA, pcm(400, true));
      await withinTest(decoder.firstRequest, params.signal);
      expect(decoder.requests).toEqual([1_000]);
      await end(captureA);
      expect(model.requests).toEqual([]);
      phase = "late-a-while-b-active";
      await append(captureB, pcm(200, true));
      decoder.release();
      await withinTest(firstTranscript.promise, params.signal);
      expect(
        events.filter(
          (event) => event.type === "transcript" && event.role === "user" && event.text === SECOND,
        ),
      ).toHaveLength(0);
      await end(captureA); // An old duplicate must not seal the currently open B capture.
      await append(captureB, pcm(200, false));
      await end(captureB);
      await end(captureB);
      await withinTest(
        Promise.all([heldModel.entered, outcomes.get(captureB)!.promise]),
        params.signal,
      );
      expect(model.requests).toHaveLength(1);
      expect(JSON.stringify(model.requests[0])).toContain(FIRST);
      expect(JSON.stringify(model.requests[0])).not.toContain(SECOND);
      heldModel.release();
      await withinTest(outputs.promise, params.signal);
      for (const id of [captureA, captureB]) {
        expect(await withinTest(outcomes.get(id)!.promise, params.signal)).toMatchObject({
          captureId: id,
          payload: { scope: "capture", outcome: "transcribed" },
        });
        expect(
          events.filter(
            (event) =>
              isRecord(event.talkEvent) &&
              event.talkEvent.type === "input.outcome" &&
              event.talkEvent.captureId === id &&
              isRecord(event.talkEvent.payload) &&
              event.talkEvent.payload.scope === "capture",
          ),
        ).toHaveLength(1);
      }
      expect(model.requests).toHaveLength(2);
      expect(JSON.stringify(model.requests[1])).toContain(SECOND);
      for (const text of [FIRST, SECOND])
        expect(
          events.filter(
            (event) =>
              event.type === "transcript" &&
              event.role === "user" &&
              event.text === text &&
              event.final === true,
          ),
        ).toHaveLength(1);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every((frame) => frame.length > 0 && frame.length % 2 === 0)).toBe(true);
      expect(Buffer.concat(frames).length).toBe(960);
      expect(audioDone).toBe(1);
      frames.length = 0; // The synthetic local sink drains before the next capture.
      phase = "empty-capture";
      await append(captureEmpty, pcm(400, false));
      await end(captureEmpty);
      await end(captureEmpty);
      expect(await withinTest(outcomes.get(captureEmpty)!.promise, params.signal)).toMatchObject({
        payload: { outcome: "no-input" },
      });
      expect(model.requests).toHaveLength(2);
      expect(decoder.requests).toEqual([1_000, 400]);
      expect(decoder.errors).toEqual([]);
      expect(model.errors).toEqual([]);
      expect(gateway.logs()).not.toContain("talk native speech input failed");
      console.info(
        JSON.stringify({
          fixture: "actual-local-media-input-end",
          captures: 3,
          modelRequests: model.requests.length,
          batchAudioMs: decoder.requests,
        }),
      );
      await operator.call("talk.session.close", { sessionId: created.sessionId });
    },
    () => {
      releaseModel?.();
      decoder?.release();
      if (gateway) console.info(JSON.stringify({ fixture: "actual-local-media-end-phase", phase }));
    },
    () =>
      params.verifyCleanup(async () => {
        await operator?.close();
      }),
    () =>
      params.verifyCleanup(async () => {
        await gateway?.cleanup();
      }),
    () =>
      params.verifyCleanup(async () => {
        await model?.stop();
      }),
    () =>
      params.verifyCleanup(async () => {
        await decoder?.stop();
      }),
  ).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        fixture: "actual-local-media-failure",
        phase,
        modelRequests: model?.requests.length,
        batchAudioMs: decoder?.requests,
      }),
      gateway?.logs(),
    );
    throw error;
  });
}
