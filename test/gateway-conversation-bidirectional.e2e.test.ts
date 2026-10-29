import { randomUUID } from "node:crypto";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import {
  BRANCH_GATEWAY_ORIGIN,
  BRANCH_GATEWAY_SCOPES,
  connectConversationOperator,
  isolateConversationGatewayEnvironment,
  startConversationModel,
} from "./helpers/conversation-branches-gateway.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "./helpers/qa-gateway-test-lifetime.js";

type Operator = Awaited<ReturnType<typeof connectConversationOperator>>;
type Model = Awaited<ReturnType<typeof startConversationModel>>;
type Turn = { runId: string; callStartedAt: number; acknowledgedAt: number };
type Description = { session: { sessionId: string; visibility: string; sharingRole: string } };
const WAIT = { timeout: 30_000, interval: 50 } as const;
const FACT_A = "BIDIRECTIONAL_ALPHA_COBALT_73";
const FACT_B = "BIDIRECTIONAL_BETA_AMBER_94";

function config(model: Model): OpenClawConfig {
  const provider = buildMockOpenAiResponsesProvider(model.baseUrl, "bidirectional-proof");
  return {
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
          deviceAutoApprove: { enabled: true, scopes: BRANCH_GATEWAY_SCOPES },
        },
      },
      controlUi: { enabled: false, allowedOrigins: [BRANCH_GATEWAY_ORIGIN] },
      roles: {
        default: "limited",
        definitions: {
          limited: { sessions: { others: "view" }, agents: "*", scopes: BRANCH_GATEWAY_SCOPES },
        },
      },
    },
    logging: { level: "debug", consoleLevel: "debug", consoleStyle: "json" },
    agents: {
      entries: { main: { conversationMode: "branches", skills: [] } },
      defaults: {
        maxConcurrent: 2,
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
    tools: { deny: ["*"] },
    models: {
      mode: "replace",
      providers: {
        [provider.providerId]: {
          ...provider.config,
          request: { allowPrivateNetwork: true },
          models: provider.config.models.map((entry) =>
            Object.assign({}, entry, { input: [...entry.input] }),
          ),
        },
      },
    },
    skills: { workshop: { autonomous: { mode: "off" } } },
    plugins: { slots: { memory: "none" } },
    messages: { queue: { mode: "steer", debounceMsByChannel: { webchat: 0 } } },
  };
}

function sourceReady(
  gateway: OpenClawTestInstance,
  recipient: string,
  source: string,
  rawSeq: number,
) {
  return gateway
    .logs()
    .split("\n")
    .some((line) => {
      if (
        !line.includes("Related-history source preparation settled") ||
        /"recipientHash"\s*:\s*"([^"]+)"/u.exec(line.replaceAll('\\"', '"'))?.[1] !==
          redactIdentifier(recipient)
      ) {
        return false;
      }
      return Array.from(
        line
          .replaceAll('\\"', '"')
          .matchAll(/"sourceHash"\s*:\s*"([^"]+)"\s*,\s*"throughSeq"\s*:\s*(\d+)/gu),
      ).some((match) => match[1] === redactIdentifier(source) && Number(match[2]) >= rawSeq);
    });
}

it("synchronizes two simultaneously active reusable branches bidirectionally without a model wakeup", async (context) => {
  let gateway: OpenClawTestInstance | undefined;
  let model: Model | undefined;
  let owner: Operator | undefined;
  const gates: Array<{ release(): void }> = [];
  context.onTestFailed(() => console.error(gateway?.logs()));
  await runQaGatewayTestFixture(
    context,
    async ({ signal, verifyCleanup }) => {
      model = await startConversationModel(signal, (_request, index) => `FIXTURE_REPLY_${index}`);
      gateway = await createOpenClawTestInstance({
        name: "conversation-bidirectional-active",
        signal,
        verifyCleanup,
        config: config(model),
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
          OPENCLAW_LOG_LEVEL: "debug",
        },
      });
      isolateConversationGatewayEnvironment(gateway);
      await gateway.startGateway();
      owner = await connectConversationOperator(gateway, "alex@example.test", signal);
      const a = `agent:main:duplex-alpha-${randomUUID()}`;
      const b = `agent:main:duplex-beta-${randomUUID()}`;
      const start = async (key: string, message: string): Promise<Turn> => {
        const callStartedAt = performance.now();
        const result = await owner!.call<{ runId: string; status: string }>("chat.send", {
          sessionKey: key,
          message,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        const acknowledgedAt = performance.now();
        expect(result.status).toBe("started");
        return { runId: result.runId, callStartedAt, acknowledgedAt };
      };
      const finish = async (turn: Turn) => {
        expect(
          await owner!.call(
            "agent.wait",
            { runId: turn.runId, timeoutMs: 30_000 },
            { timeoutMs: 31_000 },
          ),
        ).toMatchObject({ status: "ok" });
        expect(model!.errors).toEqual([]);
      };
      const send = async (key: string, message: string) => {
        const index = model!.requests.length;
        const turn = await start(key, message);
        await finish(turn);
        expect(model!.requests).toHaveLength(index + 1);
        const acceptedAt = model!.requestTimes[index];
        expect(Number.isFinite(acceptedAt)).toBe(true);
        return { ...turn, input: JSON.stringify(model!.requests[index]), acceptedAt: acceptedAt! };
      };
      const describe = (key: string) => owner!.call<Description>("sessions.describe", { key });
      const sequence = async (key: string, marker: string) => {
        const history = await owner!.call<{
          messages: Array<{
            role: string;
            content: unknown;
            __openclaw?: { transcriptPosition?: { rawSeq?: number } };
          }>;
        }>("chat.history", { sessionKey: key, limit: 100 });
        const originals = history.messages.filter(
          (row) => row.role === "user" && JSON.stringify(row.content).includes(marker),
        );
        expect(originals).toHaveLength(1);
        const rawSeq = originals[0]?.["__openclaw"]?.transcriptPosition?.rawSeq;
        expect(Number.isSafeInteger(rawSeq)).toBe(true);
        if (typeof rawSeq !== "number") {
          throw new Error("Native original raw position unavailable");
        }
        return rawSeq;
      };
      await send(a, "ALPHA_LOCAL_HISTORY_21");
      await send(b, "BETA_LOCAL_HISTORY_31");
      const [alpha, beta] = await Promise.all([describe(a), describe(b)]);
      for (const description of [alpha, beta]) {
        expect(description.session).toMatchObject({ visibility: "draft", sharingRole: "owner" });
      }
      // Both endpoints are enrolled before measuring new source input.
      await vi.waitFor(() => {
        for (const id of [alpha.session.sessionId, beta.session.sessionId]) {
          expect(
            gateway!
              .logs()
              .split("\n")
              .some(
                (line) =>
                  line.includes("Related-history source preparation settled") &&
                  line.includes(redactIdentifier(id)),
              ),
          ).toBe(true);
        }
      }, WAIT);

      // Match any next two requests: neither gate is attributed by a fact that
      // may already be legitimately present in BOTH incoming provider prompts.
      const heldOne = model.holdNext(() => true);
      const heldTwo = model.holdNext(() => true);
      gates.push(heldOne, heldTwo);
      const before = model.requests.length;
      const [turnA, turnB] = await Promise.all([
        start(a, `Remember this short alpha fact: ${FACT_A}`),
        start(b, `Remember this short beta fact: ${FACT_B}`),
      ]);
      await vi.waitFor(() => expect(model!.requests).toHaveLength(before + 2), WAIT);
      await Promise.all([heldOne.entered, heldTwo.entered]);
      // Neither completion is released: both actual provider requests are active.
      const [seqA, seqB] = await Promise.all([sequence(a, FACT_A), sequence(b, FACT_B)]);
      const ready = async (
        direction: string,
        recipient: string,
        source: string,
        rawSeq: number,
      ) => {
        let observedAt: number | undefined;
        await vi.waitFor(() => {
          expect(model!.requests).toHaveLength(before + 2);
          expect(sourceReady(gateway!, recipient, source, rawSeq), direction).toBe(true);
          observedAt ??= performance.now();
        }, WAIT);
        return observedAt!;
      };
      const [aToBReadyAt, bToAReadyAt] = await Promise.all([
        ready("alpha to beta", beta.session.sessionId, alpha.session.sessionId, seqA),
        ready("beta to alpha", alpha.session.sessionId, beta.session.sessionId, seqB),
      ]);
      expect(model.requests).toHaveLength(before + 2); // Sync must never dispatch a model itself.
      heldOne.release();
      heldTwo.release();
      await Promise.all([finish(turnA), finish(turnB)]);
      expect(model.requests).toHaveLength(before + 2);

      const exact = (input: string) => {
        for (const marker of [FACT_A, FACT_B]) {
          expect(input.split(marker).length - 1).toBe(1);
        }
      };
      // Ordinary safe requests follow completion; no sessions_send or forced refresh.
      // Sequential probes give unambiguous captured-request attribution.
      const probeA = await send(a, "ALPHA_FIRST_SAFE_PROBE_41");
      exact(probeA.input);
      expect(probeA.input).toContain("ALPHA_LOCAL_HISTORY_21");
      const probeB = await send(b, "BETA_FIRST_SAFE_PROBE_51");
      exact(probeB.input);
      expect(probeB.input).toContain("BETA_LOCAL_HISTORY_31");
      exact((await send(a, "ALPHA_REPEAT_PROBE_61")).input);
      exact((await send(b, "BETA_REPEAT_PROBE_71")).input);
      expect((await describe(a)).session.sessionId).toBe(alpha.session.sessionId);
      expect((await describe(b)).session.sessionId).toBe(beta.session.sessionId);
      const metrics = (
        turn: Turn,
        readyAt: number,
        probe: { callStartedAt: number; acceptedAt: number },
      ) => ({
        readyObservedFromCallStartMs: Number((readyAt - turn.callStartedAt).toFixed(3)),
        readyObservedFromAckMs: Number((readyAt - turn.acknowledgedAt).toFixed(3)),
        firstSafeProbeDispatchMs: Number((probe.acceptedAt - probe.callStartedAt).toFixed(3)),
        nextProbeProviderAcceptedFromCallStartMs: Number(
          (probe.acceptedAt - turn.callStartedAt).toFixed(3),
        ),
        nextProbeProviderAcceptedFromAckMs: Number(
          (probe.acceptedAt - turn.acknowledgedAt).toFixed(3),
        ),
      });
      console.info(
        JSON.stringify({
          fixture: "two-active-reusable-branches",
          clock: "single-test-process-performance.now",
          readyObservation: "upper-bound-includes-log-delivery-history-probes-and-50ms-polling",
          providerObservation: "request-body-accepted-before-response-gate; not inference latency",
          firstSafeProbeDispatch:
            "probe RPC start to provider request acceptance; excludes earlier gate and probe scheduling waits",
          probeOrder: ["alpha", "beta"],
          probeOverhead:
            "provider times include controlled gate release, completion waits and sequential probe scheduling",
          aToB: metrics(turnA, aToBReadyAt, probeB),
          bToA: metrics(turnB, bToAReadyAt, probeA),
        }),
      );
    },
    async () => {
      for (const gate of gates) {
        gate.release();
      }
      await owner?.close();
    },
    () => gateway?.cleanup(),
    () => model?.stop(),
  );
}, 180_000);
