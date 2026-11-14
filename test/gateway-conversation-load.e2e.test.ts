import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as measureWindow } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { gatewayBenchCpuProfileArgs } from "../scripts/lib/gateway-bench-runtime.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { workshopPluginConfig } from "../src/skills/test-support/workshop-config.test-support.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../src/state/openclaw-state-db.paths.js";
import { setUserProfileRole } from "../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../src/state/user-profiles.js";
import {
  BRANCH_GATEWAY_ORIGIN,
  connectConversationOperator,
  isolateConversationGatewayEnvironment,
  startConversationModel,
} from "./helpers/conversation-branches-gateway.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runCleanups, runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "./helpers/qa-gateway-test-lifetime.js";

const SPEECH = "qa-conversation-speech";
const SCOPES = ["operator.read", "operator.write", "operator.talk"] as const;

function configuration(baseUrl: string, mode: "native" | "branches" = "branches"): OpenClawConfig {
  const provider = buildMockOpenAiResponsesProvider(baseUrl, "conversation-load");
  return workshopPluginConfig(
    { autonomous: { mode: "off" } },
    {
      gateway: {
        mode: "local",
        bind: "loopback",
        trustedProxies: ["127.0.0.1", "::1"],
        auth: {
          mode: "trusted-proxy",
          token: undefined,
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowLoopback: true,
            deviceAutoApprove: { enabled: true, scopes: [...SCOPES] },
          },
        },
        controlUi: { enabled: false, allowedOrigins: [BRANCH_GATEWAY_ORIGIN] },
        roles: {
          default: "limited",
          definitions: {
            limited: { sessions: { others: "view" }, agents: "*", scopes: [...SCOPES] },
          },
        },
      },
      logging: { level: "debug", consoleLevel: "debug", consoleStyle: "json" },
      agents: {
        entries: { main: { conversationMode: mode, skills: [] } },
        defaults: {
          model: { primary: provider.modelRef, fallbacks: [] },
          modelPolicy: { allow: [provider.modelRef] },
          models: {
            [provider.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
          utilityModel: "",
          workspace: "~/workspace",
          skills: [],
          skipBootstrap: true,
          sandbox: { mode: "off" },
        },
      },
      session: { scope: "per-sender" },
      tools: { deny: ["*"] },
      models: {
        mode: "replace",
        providers: {
          [provider.providerId]: {
            ...provider.config,
            request: { allowPrivateNetwork: true },
            models: provider.config.models.map((model) =>
              Object.assign({}, model, { input: [...model.input] }),
            ),
          },
        },
      },
      talk: {
        agentId: "main",
        provider: SPEECH,
        providers: { [SPEECH]: { modelId: "offline-pcm", voiceId: "fixture" } },
      },
      plugins: {
        slots: { memory: "none" },
        load: { paths: [path.resolve("test/fixtures/conversation-speech")] },
        entries: { [SPEECH]: { enabled: true } },
      },
      messages: { queue: { mode: "steer", debounceMsByChannel: { webchat: 0 } } },
    },
  );
}

// Linux process accounting includes all Gateway threads, not children or the test runner.
// Report clock ticks, without assuming the host's CLK_TCK or calling this main-thread CPU.
async function cpuTicks(pid: number, mainThread = false) {
  const stat = await readFile(
    mainThread ? `/proc/${pid}/task/${pid}/stat` : `/proc/${pid}/stat`,
    "utf8",
  );
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const user = Number(fields[11]);
  const system = Number(fields[12]);
  if (!Number.isFinite(user + system)) {
    throw new Error("Gateway process CPU accounting unavailable");
  }
  return user + system;
}

// No provider requests, manifests, IDs or log lines are retained by the observer.
function diagnostics() {
  let counts: Record<string, number> = {};
  let maxima: Record<string, number> = {};
  const buffers = new Map<string, string>();
  const labels = [
    "Related-history preparation input root",
    "Related-history prepared selection",
    "Related-history preparation work",
    "Related-history source preparation settled",
    "Related-history recipient quantum settled",
    "Related-history root projection ready",
    "Conversation knowledge transfer",
  ];
  const consume = (stream: string, chunk: Buffer) => {
    const lines = ((buffers.get(stream) ?? "") + chunk.toString("utf8")).split("\n");
    buffers.set(stream, lines.pop() ?? "");
    for (const raw of lines) {
      const line = raw.replaceAll('\\"', '"');
      const label = labels.find((candidate) => line.includes(candidate));
      if (!label) {
        continue;
      }
      counts[label] = (counts[label] ?? 0) + 1;
      for (const key of ["outcome", "cause", "phase", "owner"]) {
        const value = new RegExp(`"${key}"\\s*:\\s*"([a-z-]+)"`, "u").exec(line)?.[1];
        if (value) {
          counts[`${label}:${key}:${value}`] = (counts[`${label}:${key}:${value}`] ?? 0) + 1;
        }
      }
      for (const key of [
        "preparingSources",
        "more",
        "sourcesRequested",
        "saturated",
        "idleProgress",
        "manifestReused",
        "coalesced",
        "requestedDuringPreparation",
      ]) {
        if (new RegExp(`"${key}"\\s*:\\s*true`, "u").test(line)) {
          counts[`${label}:${key}`] = (counts[`${label}:${key}`] ?? 0) + 1;
        }
      }
      for (const key of [
        "manifestBytes",
        "inputRootBytes",
        "inputProgressBytes",
        "preparedRootBytes",
        "stagedBytes",
        "preparedTailCount",
        "preparedPackets",
        "admissionBytes",
        "rawBytes",
        "maxBytes",
      ]) {
        const value = new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "u").exec(line)?.[1];
        if (value !== undefined) {
          maxima[key] = Math.max(maxima[key] ?? 0, Number(value));
        }
      }
    }
  };
  return {
    stdout: (chunk: Buffer) => consume("stdout", chunk),
    stderr: (chunk: Buffer) => consume("stderr", chunk),
    take() {
      const result = { counts, maxima };
      counts = {};
      maxima = {};
      return result;
    },
  };
}

// Explain extra provider calls without retaining prompts or adding an oracle to the model leaf.
function modelRequestShape(request: Record<string, unknown>) {
  const messages = Array.isArray(request.input) ? request.input.filter(isRecord) : [];
  const systems = messages
    .filter((message) => message.role === "system")
    .flatMap((message) =>
      Array.isArray(message.content)
        ? message.content
            .filter(isRecord)
            .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
        : [],
    );
  const system = [
    typeof request.instructions === "string" ? request.instructions : "",
    ...systems,
  ].join("\n");
  const context = JSON.stringify([request.instructions, request.input]);
  return {
    contextBytes: Buffer.byteLength(context),
    systemBytes: Buffer.byteLength(system),
    summarizationInstruction: system.includes("You are a context summarization assistant."),
    foreignFactPresent: context.includes("COBALT_LOAD"),
    speechMarkerPresent: context.includes("LOAD_SPEECH_"),
    maxOutputTokens:
      typeof request.max_output_tokens === "number" ? request.max_output_tokens : undefined,
  };
}

async function workload() {
  const file = process.env.OPENCLAW_E2E_CONVERSATION_LOAD_CORPUS;
  if (!file) {
    return { selected: [], totalUserRows: 0, totalSources: 0 };
  }
  const limit = Number(process.env.OPENCLAW_E2E_CONVERSATION_LOAD_TURNS ?? 64);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) {
    throw new Error("Corpus workload must contain 1–1024 native turns");
  }
  const bytes = await readFile(file);
  if (bytes.length > 32 * 1024 * 1024) {
    throw new Error("Corpus workload too large");
  }
  const data: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.references)) {
    throw new Error("Corpus workload contract unavailable");
  }
  const selected: Array<{ source: string; text: string }> = [];
  let totalUserRows = 0;
  const sources = new Set<string>();
  for (const row of data.references) {
    if (
      !isRecord(row) ||
      typeof row.source !== "string" ||
      typeof row.text !== "string" ||
      (row.role !== "user" && row.role !== "assistant")
    ) {
      throw new Error("Corpus workload reference invalid");
    }
    sources.add(row.source);
    if (row.role === "user") {
      totalUserRows++;
      if (selected.length < limit) {
        selected.push({ source: row.source, text: row.text });
      }
    }
  }
  if (!selected.length) {
    throw new Error("Corpus workload has no user input");
  }
  return { selected, totalUserRows, totalSources: sources.size };
}

/** Opt-in measurement, not a replacement for Matrix, PSTN or physical Echo acceptance.
 * Uses native default context/compaction budgets and native provider execution. Only the
 * external model and speech hardware leaves are synthetic. No historical corpus is
 * imported here: optional corpus USER text is replayed as NEW authenticated turns.
 * Old assistant messages, receipts and remote/profile audiences are not impersonated.
 */
it.skipIf(process.env.OPENCLAW_E2E_CONVERSATION_LOAD !== "1")(
  "measures native Chat and connected Talk work across reuse and restart",
  async (context) => {
    if (process.platform !== "linux") {
      throw new Error("Load accounting requires Linux /proc");
    }
    const quietMs = Number(process.env.OPENCLAW_E2E_CONVERSATION_LOAD_QUIET_MS ?? 10_000);
    if (!Number.isSafeInteger(quietMs) || quietMs < 1_000 || quietMs > 60_000) {
      throw new Error("Quiet measurement window must be 1–60 seconds");
    }
    const sourceBucketCap = Number(process.env.OPENCLAW_E2E_CONVERSATION_LOAD_SOURCE_BUCKETS ?? 0);
    if (!Number.isSafeInteger(sourceBucketCap) || sourceBucketCap < 0 || sourceBucketCap > 64) {
      throw new Error("Source buckets must be 0 (original aliases) or 1–64");
    }
    const sourceMapping = sourceBucketCap === 0 ? "original-alias" : "bounded-new-sources";
    const diagnosticDirectory = process.env.OPENCLAW_E2E_CONVERSATION_DIAGNOSTIC_PROFILE_DIR;
    if (diagnosticDirectory && process.env.OPENCLAW_E2E_CONVERSATION_CPU_PROFILE_DIR) {
      throw new Error("Native diagnostic profiling cannot run alongside startup CPU profiling");
    }
    const cleanups: Array<() => Promise<void>> = [];
    await runQaGatewayTestFixture(
      context,
      async ({ signal, verifyCleanup }) => {
        const corpus = await workload();
        const inputs = corpus.selected;
        // Assign aliases by first appearance; preserve every selected input and its order.
        // Buckets describe NEW authenticated histories, never historical identity equivalence.
        const mappedSources = new Map(
          [...new Set(inputs.map((input) => input.source))].map((alias, index) => [
            alias,
            sourceBucketCap === 0 ? alias : String(index % sourceBucketCap),
          ]),
        );
        const model = await startConversationModel(signal, () => "LOAD_REPLY.");
        cleanups.push(() => model.stop());
        const selected = configuration(model.baseUrl);
        if (diagnosticDirectory) {
          expect(inputs.length).toBeGreaterThan(0);
          selected.gateway!.roles!.definitions.observer = {
            sessions: { others: "view" },
            agents: "*",
            scopes: ["operator.admin"],
          };
          selected.gateway!.auth!.trustedProxy!.deviceAutoApprove!.scopes = [
            ...SCOPES,
            "operator.admin",
          ];
        }
        const gateway = await createOpenClawTestInstance({
          name: "conversation-load",
          signal,
          verifyCleanup,
          config: selected,
          gatewayCommandPrefix: process.env.OPENCLAW_E2E_CONVERSATION_CPU_PROFILE_DIR
            ? [
                process.execPath,
                ...gatewayBenchCpuProfileArgs(
                  process.env.OPENCLAW_E2E_CONVERSATION_CPU_PROFILE_DIR,
                ),
              ]
            : undefined,
          env: {
            OPENCLAW_SKIP_PROVIDERS: undefined,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
            OPENCLAW_LOG_LEVEL: "debug",
          },
        });
        cleanups.push(() => gateway.cleanup());
        isolateConversationGatewayEnvironment(gateway);
        if (diagnosticDirectory) {
          const observer = ensureProfileForEmail("load-observer@example.test", {
            env: gateway.env,
          });
          setUserProfileRole(observer.id, "observer", { env: gateway.env });
          await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(gateway.env));
        }
        gateway.state.applyEnv();
        const meter = diagnostics();
        let diagnosticRecords = 0;
        let operator: Awaited<ReturnType<typeof connectConversationOperator>> | undefined;
        let observer: typeof operator;
        let profile: Promise<void> | undefined;
        cleanups.push(async () => {
          await operator?.close();
        });
        cleanups.push(async () => {
          await profile?.catch(() => {});
        });
        cleanups.push(async () => {
          await observer?.close();
        });
        const live = new Set<string>();
        const available = new Set<string>();
        const waiters = new Map<string, ReturnType<typeof createDeferred<void>>>();
        let turn:
          | {
              id: string;
              ended: ReturnType<typeof createDeferred<void>>;
              audio: ReturnType<typeof createDeferred<void>>;
              frames: number;
            }
          | undefined;
        let child: typeof gateway.child;
        const attach = () => {
          child = gateway.child;
          if (!child?.pid) {
            throw new Error("Gateway process not started");
          }
          child.stdout.on("data", meter.stdout);
          child.stderr.on("data", meter.stderr);
        };
        const detach = () => {
          child?.stdout.off("data", meter.stdout);
          child?.stderr.off("data", meter.stderr);
        };
        const connect = () =>
          connectConversationOperator(gateway, "load-person@example.test", signal, {
            scopes: [...SCOPES],
            onEvent(event, payload) {
              if (
                event !== "talk.event" ||
                !isRecord(payload) ||
                typeof payload.sessionId !== "string"
              ) {
                return;
              }
              const current = turn?.id === payload.sessionId ? turn : undefined;
              if (current && payload.type === "audio" && typeof payload.audioBase64 === "string") {
                expect(Buffer.from(payload.audioBase64, "base64").length).toBeGreaterThan(0);
                current.frames++;
              }
              const e = payload.talkEvent;
              if (!isRecord(e)) {
                return;
              }
              if (
                e.type === "session.activity" &&
                isRecord(e.payload) &&
                isRecord(e.payload.input)
              ) {
                if (e.payload.input.available === true) {
                  available.add(payload.sessionId);
                  waiters.get(payload.sessionId)?.resolve();
                } else {
                  available.delete(payload.sessionId);
                }
              }
              if (e.type === "turn.ended") {
                current?.ended.resolve();
              }
              if (e.type === "output.audio.done") {
                current?.audio.resolve();
              }
              if (e.type === "session.error" || e.type === "session.closed") {
                const error = new Error("Talk ended before the measured operation completed");
                current?.ended.reject(error);
                current?.audio.reject(error);
                waiters.get(payload.sessionId)?.reject(error);
              }
            },
          });
        const sample = async (phase: string, work: () => Promise<void>) => {
          const pid = gateway.child?.pid;
          if (!pid) {
            throw new Error("Measured Gateway process absent");
          }
          meter.take();
          const startCpu = await cpuTicks(pid);
          const start = performance.now();
          const requests = model.requests.length;
          let completed = false;
          await runQaGatewayFixture(
            async () => {
              await work();
              completed = true;
            },
            async () => {
              expect(gateway.child?.pid).toBe(pid);
              const observed = meter.take();
              diagnosticRecords += Object.values(observed.counts).reduce(
                (sum, value) => sum + value,
                0,
              );
              console.log(
                JSON.stringify({
                  kind: "native-gateway-load",
                  phase,
                  outcome: completed ? "completed" : "failed",
                  elapsedMs: performance.now() - start,
                  cpuTicks: (await cpuTicks(pid)) - startCpu,
                  modelRequests: model.requests.length - requests,
                  modelShapes: model.requests.slice(requests).slice(-4).map(modelRequestShape),
                  ...observed,
                  boundary: "signed-webchat-and-talk-gateway-relay",
                  corpusSeeded: false,
                  sourceMapping,
                  sourceBucketCap,
                }),
              );
            },
          );
        };
        const chatKey = `agent:main:load-chat-${randomUUID()}`;
        const assertInput = (before: number, current: string, foreign: string) => {
          const matching = model.requests
            .slice(before)
            .filter((request) => JSON.stringify(request.input).includes(current));
          // An ambiguous/background match is a failed witness, never pick an arbitrary request.
          expect(matching).toHaveLength(1);
          expect(JSON.stringify([matching[0]!.instructions, matching[0]!.input])).toContain(
            foreign,
          );
        };
        const chat = async (message: string, sessionKey = chatKey, foreign?: string) => {
          const before = model.requests.length;
          const reply = await operator!.call<{ runId: string }>("chat.send", {
            sessionKey,
            message,
            deliver: false,
            idempotencyKey: randomUUID(),
          });
          expect(
            await operator!.call(
              "agent.wait",
              { runId: reply.runId, timeoutMs: 30_000 },
              { timeoutMs: 31_000 },
            ),
          ).toMatchObject({ status: "ok" });
          if (foreign) {
            assertInput(before, message, foreign);
          }
        };
        const close = async (id: string) => {
          await operator!.call("talk.session.close", { sessionId: id });
          live.delete(id);
        };
        const speak = async (id: string, activity: boolean, marker: string) => {
          if (activity && !available.has(id)) {
            const ready = createDeferred();
            void ready.promise.catch(() => {});
            waiters.set(id, ready);
            try {
              await withinTest(ready.promise, signal);
            } finally {
              waiters.delete(id);
            }
          }
          const current = { id, ended: createDeferred(), audio: createDeferred(), frames: 0 };
          turn = current;
          const completed = Promise.all([current.ended.promise, current.audio.promise]);
          void completed.catch(() => {});
          const before = model.requests.length;
          const text = `${marker}: Please reply briefly.`;
          const pcm = Buffer.from(text + (Buffer.byteLength(text) % 2 ? " " : ""));
          try {
            await operator!.call("talk.session.appendAudio", {
              sessionId: id,
              audioBase64: pcm.toString("base64"),
              ...(activity ? { captureId: randomUUID() } : {}),
              endOfInput: true,
            });
            await withinTest(completed, signal);
            expect(current.frames).toBeGreaterThan(0);
            assertInput(before, marker, "COBALT_LOAD");
          } finally {
            turn = undefined;
          }
        };
        const keys = new Map([
          ["isolated-duplex", `agent:main:voice:load-${randomUUID()}`],
          ["activity-v1", `agent:main:voice:load-${randomUUID()}`],
        ]);
        try {
          await gateway.startGateway();
          attach();
          operator = await connect();
          if (diagnosticDirectory) {
            observer = await connectConversationOperator(
              gateway,
              "load-observer@example.test",
              signal,
              {
                scopes: ["operator.admin"],
              },
            );
          }
          const sources = new Map<string, string>();
          await sample("corpus-new-authenticated-turns", async () => {
            const started = performance.now();
            let completedTurns = 0;
            let textBytes = 0;
            let maxTurnMs = 0;
            for (const input of inputs) {
              const mappedSource = mappedSources.get(input.source)!;
              let key = sources.get(mappedSource);
              if (!key) {
                key = `agent:main:load-corpus-${randomUUID()}`;
                sources.set(mappedSource, key);
              }
              const turnStarted = performance.now();
              await chat(input.text, key);
              completedTurns++;
              if (observer && completedTurns === Math.max(1, inputs.length - 64)) {
                // Observe the main isolate natively without pausing input or elevating its sender.
                profile = observer
                  .call("diagnostics.cpuProfile", {}, { timeoutMs: 30_000 })
                  .then(async (result) => {
                    await writeFile(
                      path.join(diagnosticDirectory!, "native-main-profile.json"),
                      JSON.stringify(result) + "\n",
                      { flag: "wx", mode: 0o600 },
                    );
                  });
                void profile.catch(() => {});
              }
              textBytes += Buffer.byteLength(input.text);
              maxTurnMs = Math.max(maxTurnMs, performance.now() - turnStarted);
              if (completedTurns % 16 === 0) {
                console.log(
                  JSON.stringify({
                    kind: "native-gateway-workload-progress",
                    phase: "corpus-new-authenticated-turns",
                    completedTurns,
                    selectedTurns: inputs.length,
                    sources: sources.size,
                    sourceMapping,
                    sourceBucketCap,
                    totalCorpusSources: corpus.totalSources,
                    textBytes,
                    elapsedMs: performance.now() - started,
                    maxTurnMs,
                  }),
                );
              }
            }
            if (observer) {
              await profile;
              await observer.close();
              observer = undefined;
            }
          });
          console.log(
            JSON.stringify({
              kind: "native-gateway-workload",
              turns: inputs.length,
              sources: sources.size,
              sourceMapping,
              sourceBucketCap,
              selectedOriginalSources: mappedSources.size,
              selection: "first-user-rows-in-file-order",
              totalUserRows: corpus.totalUserRows,
              totalCorpusSources: corpus.totalSources,
              textBytes: inputs.reduce((sum, input) => sum + Buffer.byteLength(input.text), 0),
              historicalReceiptsImported: false,
              originalAudienceEquivalenceClaimed: false,
              exactRootReceiptCount: null,
            }),
          );
          await sample("new-chat", () => chat("Remember the synthetic codeword COBALT_LOAD."));
          for (const generation of ["initial", "restarted"]) {
            if (generation === "restarted") {
              await operator.close();
              operator = undefined;
              detach();
              await gateway.stopGateway();
              await gateway.startGateway();
              attach();
              operator = await connect();
            }
            for (const [profile, key] of keys) {
              const activity = profile === "activity-v1";
              for (const transport of ["open", "reopen"]) {
                const marker = `LOAD_SPEECH_${generation}_${profile}_${transport}`;
                let id = "";
                await sample(`${generation}:${profile}:${transport}`, async () => {
                  const created = await operator!.call<{ sessionId: string; readyMark: string }>(
                    "talk.session.create",
                    {
                      sessionKey: key,
                      mode: "stt-tts",
                      transport: "gateway-relay",
                      brain: "agent-consult",
                      provider: SPEECH,
                      capabilities: activity ? ["activity-v1"] : ["isolated-input", "output-gate"],
                    },
                  );
                  id = created.sessionId;
                  live.add(id);
                  await operator!.call("talk.session.acknowledgeMark", {
                    sessionId: id,
                    markName: created.readyMark,
                  });
                  await speak(id, activity, marker);
                });
                // A real timed window measures quiet work, never substitutes for readiness.
                await sample(`${generation}:${profile}:${transport}:quiet`, async () => {
                  await measureWindow(quietMs, undefined, { signal });
                });
                await sample(`${generation}:${profile}:${transport}:active-chat`, () =>
                  chat(`LOAD_CHAT_${generation}_${profile}_${transport}`, chatKey, marker),
                );
                await sample(`${generation}:${profile}:${transport}:follow-up`, () =>
                  speak(id, activity, `${marker}_FOLLOWUP`),
                );
                await close(id);
              }
            }
          }
          expect(model.errors).toEqual([]);
          expect(diagnosticRecords).toBeGreaterThan(0);
          const history = await operator.call<{ messages: unknown[] }>("chat.history", {
            sessionKey: chatKey,
            limit: 100,
          });
          expect(JSON.stringify(history.messages)).toContain("COBALT_LOAD");
        } finally {
          detach();
          for (const id of live) {
            await operator?.call("talk.session.close", { sessionId: id }).catch(() => {});
          }
        }
      },
      () => runCleanups(cleanups, "Gateway load cleanup failed"),
    );
  },
);

// This measures the real relay/Core boundary, not Matrix RTP, hardware VAD or AEC.
// The synthetic STT buffers PCM; closing without EOF discards silence without a transcript.
it.skipIf(process.env.OPENCLAW_E2E_CONVERSATION_PCM_LOAD !== "1")(
  "measures continuous silent Talk relay input in native and branch conversations",
  async (context) => {
    if (process.platform !== "linux") {
      throw new Error("Load accounting requires Linux /proc");
    }
    for (let repetition = 1; repetition <= 5; repetition++) {
      const modes =
        repetition % 2 ? (["native", "branches"] as const) : (["branches", "native"] as const);
      for (const mode of modes) {
        const cleanups: Array<() => Promise<void>> = [];
        await runQaGatewayTestFixture(
          context,
          async ({ signal, verifyCleanup }) => {
            const model = await startConversationModel(signal, () => "PCM_REPLY.");
            cleanups.push(() => model.stop());
            const gateway = await createOpenClawTestInstance({
              name: "conversation-pcm-load",
              signal,
              verifyCleanup,
              config: configuration(model.baseUrl, mode),
              env: {
                OPENCLAW_SKIP_PROVIDERS: undefined,
                OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
                OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
                OPENCLAW_LOG_LEVEL: "debug",
              },
            });
            cleanups.push(() => gateway.cleanup());
            isolateConversationGatewayEnvironment(gateway);
            gateway.state.applyEnv();
            await gateway.startGateway();
            const child = gateway.child;
            if (!child?.pid) {
              throw new Error("Measured Gateway process absent");
            }
            const pid = child.pid,
              meter = diagnostics();
            child.stdout.on("data", meter.stdout);
            child.stderr.on("data", meter.stderr);
            cleanups.push(async () => {
              child.stdout.off("data", meter.stdout);
              child.stderr.off("data", meter.stderr);
            });
            const ended = createDeferred(),
              audio = createDeferred();
            const completed = Promise.all([ended.promise, audio.promise]);
            void completed.catch(() => {});
            let closing = false,
              failure: Error | undefined;
            let acceptedFrames = 0,
              acceptedBytes = 0,
              outputFrames = 0;
            const fail = () => {
              failure = new Error("Talk failed during a measured connection");
              ended.reject(failure);
              audio.reject(failure);
            };
            const operator = await connectConversationOperator(
              gateway,
              "pcm-person@example.test",
              signal,
              {
                scopes: [...SCOPES],
                onEvent(event, payload) {
                  if (event !== "talk.event" || !isRecord(payload)) {
                    return;
                  }
                  if (!closing && payload.type === "close") {
                    fail();
                  }
                  if (payload.type === "audio" && typeof payload.audioBase64 === "string") {
                    expect(Buffer.from(payload.audioBase64, "base64").length).toBeGreaterThan(0);
                    outputFrames++;
                  }
                  if (!isRecord(payload.talkEvent)) {
                    return;
                  }
                  const e = payload.talkEvent;
                  if (e.type === "turn.ended") {
                    ended.resolve();
                  }
                  if (e.type === "output.audio.done") {
                    audio.resolve();
                  }
                  if (
                    e.type === "input.audio.delta" &&
                    isRecord(e.payload) &&
                    typeof e.payload.bytes === "number"
                  ) {
                    acceptedFrames++;
                    acceptedBytes += e.payload.bytes;
                  }
                  if (!closing && (e.type === "session.error" || e.type === "session.closed")) {
                    fail();
                  }
                },
              },
            );
            cleanups.push(() => operator.close());
            const created = await operator.call<{ sessionId: string; readyMark: string }>(
              "talk.session.create",
              {
                sessionKey: `agent:main:pcm-load-${randomUUID()}`,
                mode: "stt-tts",
                transport: "gateway-relay",
                brain: "agent-consult",
                provider: SPEECH,
                capabilities: ["isolated-input", "output-gate"],
              },
            );
            cleanups.push(async () => {
              closing = true;
              await operator.call("talk.session.close", { sessionId: created.sessionId });
            });
            await operator.call("talk.session.acknowledgeMark", {
              sessionId: created.sessionId,
              markName: created.readyMark,
            });
            const warmText = "PCM_WARM: Please reply briefly. ";
            const warm = Buffer.from(warmText + (Buffer.byteLength(warmText) % 2 ? " " : ""));
            const beforeWarm = model.requests.length;
            await operator.call("talk.session.appendAudio", {
              sessionId: created.sessionId,
              audioBase64: warm.toString("base64"),
              endOfInput: true,
            });
            await withinTest(completed, signal);
            expect(outputFrames).toBeGreaterThan(0);
            expect(
              model.requests
                .slice(beforeWarm)
                .filter((request) => JSON.stringify(request.input).includes("PCM_WARM")),
            ).toHaveLength(1);
            expect(failure).toBeUndefined();
            const requests = model.requests.length;
            const sample = async <T extends Record<string, number>>(
              phase: string,
              work: () => Promise<T>,
            ) => {
              meter.take();
              const frames = acceptedFrames,
                bytes = acceptedBytes;
              const processStart = await cpuTicks(pid),
                mainStart = await cpuTicks(pid, true);
              const start = performance.now();
              let observed: Record<string, number> = {};
              let succeeded = false;
              const metrics = await runQaGatewayFixture(
                async () => {
                  const measured = await work();
                  observed = measured;
                  expect(gateway.child?.pid).toBe(pid);
                  expect(failure).toBeUndefined();
                  expect(model.requests).toHaveLength(requests);
                  expect(model.errors).toEqual([]);
                  succeeded = true;
                  return measured;
                },
                async () => {
                  console.log(
                    JSON.stringify({
                      kind: "native-gateway-pcm-load",
                      mode,
                      repetition,
                      phase,
                      outcome: succeeded ? "completed" : "failed",
                      elapsedMs: performance.now() - start,
                      processCpuTicks: (await cpuTicks(pid)) - processStart,
                      mainCpuTicks: (await cpuTicks(pid, true)) - mainStart,
                      acceptedFrames: acceptedFrames - frames,
                      acceptedBytes: acceptedBytes - bytes,
                      modelRequests: model.requests.length - requests,
                      ...observed,
                      ...meter.take(),
                      boundary: "signed-talk-speech-relay",
                      hardwareVadOrAecMeasured: false,
                    }),
                  );
                },
              );
              return {
                ...metrics,
                acceptedFrames: acceptedFrames - frames,
                acceptedBytes: acceptedBytes - bytes,
              };
            };
            await sample("quiet-before-input", async () => {
              await measureWindow(10_000, undefined, { signal });
              return {};
            });
            const streamed = await sample("paced-silent-input", async () => {
              const frame = Buffer.alloc(640).toString("base64"),
                captureId = randomUUID();
              const latency: number[] = [];
              const start = performance.now(),
                end = start + 10_000;
              let due = start,
                skippedSlots = 0,
                maxLatenessMs = 0;
              while (due < end) {
                signal.throwIfAborted();
                const delay = due - performance.now();
                if (delay > 0) {
                  await measureWindow(delay, undefined, { signal });
                }
                const sent = performance.now();
                maxLatenessMs = Math.max(maxLatenessMs, sent - due);
                await operator.call("talk.session.appendAudio", {
                  sessionId: created.sessionId,
                  audioBase64: frame,
                  captureId,
                });
                latency.push(performance.now() - sent);
                due += 20;
                // Skip expired slots rather than fabricating a burst after a slow RPC.
                if (due < performance.now()) {
                  const missed = Math.ceil((performance.now() - due) / 20);
                  skippedSlots += missed;
                  due += missed * 20;
                }
              }
              latency.sort((left, right) => left - right);
              expect(latency.length).toBeGreaterThan(0);
              return {
                sentFrames: latency.length,
                sentBytes: latency.length * 640,
                targetHz: 50,
                skippedSlots,
                maxLatenessMs,
                appendP50Ms: latency[Math.floor(latency.length * 0.5)]!,
                appendP95Ms: latency[Math.floor(latency.length * 0.95)]!,
                appendMaxMs: latency.at(-1)!,
              };
            });
            expect(streamed.acceptedFrames).toBe(streamed.sentFrames);
            expect(streamed.acceptedBytes).toBe(streamed.sentBytes);
            await sample("quiet-after-input", async () => {
              await measureWindow(5_000, undefined, { signal });
              return {};
            });
          },
          () => runCleanups(cleanups, "PCM Gateway cleanup failed"),
        );
      }
    }
  },
  600_000,
);
