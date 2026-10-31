import { randomUUID } from "node:crypto";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../src/config/sessions/paths.js";
import { loadTranscriptEvents } from "../src/config/sessions/session-transcript-events.js";
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
const FACT_C = "BIDIRECTIONAL_GAMMA_TEAL_28";
const IDLE_FACT = "IDLE_DELIVERY_WITHOUT_RECIPIENT_INPUT_62";

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
        maxConcurrent: 3,
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

it("synchronizes active and idle reusable branches without blocking a third conversation", async (context) => {
  let gateway: OpenClawTestInstance | undefined;
  let model: Model | undefined;
  let owner: Operator | undefined;
  const gates: Array<{ release(): void }> = [];
  const phases: Array<Record<string, unknown>> = [];
  let phase = "startup";
  const mark = (next: string, facts: Record<string, unknown> = {}) => {
    phase = next;
    phases.push({ phase, observedAt: performance.now(), ...facts });
  };
  context.onTestFailed(() =>
    console.error(JSON.stringify({ fixture: "branch-activity-transitions", phase, phases })),
  );
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
      gateway.state.applyEnv();
      await gateway.startGateway();
      owner = await connectConversationOperator(gateway, "alex@example.test", signal);
      const a = `agent:main:duplex-alpha-${randomUUID()}`;
      const b = `agent:main:duplex-beta-${randomUUID()}`;
      const c = `agent:main:duplex-gamma-${randomUUID()}`;
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
      const storePath = resolveSessionStorePathCore(undefined, {
        agentId: "main",
        env: gateway.state.env,
      });
      const retained = (sessionKey: string, sessionId: string) =>
        loadTranscriptEvents({
          agentId: "main",
          storePath,
          sessionKey,
          sessionId,
          env: gateway!.state.env,
        });
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
      await send(c, "GAMMA_LOCAL_HISTORY_35");
      mark("three-ordinary-native-runs-completed");
      const [alpha, beta] = await Promise.all([describe(a), describe(b)]);
      for (const description of [alpha, beta]) {
        expect(description.session).toMatchObject({ visibility: "draft", sharingRole: "owner" });
      }
      // Prove the observer can read originals before any background-delivery wait.
      const [aBeforeIdle, bBeforeIdle] = await Promise.all([
        retained(a, alpha.session.sessionId),
        retained(b, beta.session.sessionId),
      ]);
      expect(JSON.stringify(aBeforeIdle)).toContain("ALPHA_LOCAL_HISTORY_21");
      expect(JSON.stringify(bBeforeIdle)).toContain("BETA_LOCAL_HISTORY_31");
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
      const turnA = await start(a, `Remember this short alpha fact: ${FACT_A}`);
      await heldOne.entered;
      const turnB = await start(b, `Remember this short beta fact: ${FACT_B}`);
      await heldTwo.entered;
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
      // These are three generic conversation endpoints, not three physical media
      // transports. Two real provider calls remain held while the third proceeds.
      mark("two-provider-responses-held");
      const healthStarted = performance.now();
      await owner.call("health", {});
      const healthMs = performance.now() - healthStarted;
      const third = await send(c, `Remember this independent gamma fact: ${FACT_C}`);
      expect(third.input).toContain(FACT_C);
      expect(model.requests).toHaveLength(before + 3);
      mark("third-conversation-finished-while-two-held", {
        healthMs,
        thirdDispatchMs: third.acceptedAt - third.callStartedAt,
      });
      const containsPacket = async (key: string, id: string, marker: string) =>
        (await retained(key, id))
          .map(asOptionalRecord)
          .some(
            (row) =>
              row?.type === "custom_message" &&
              row.customType === "openclaw.conversation-knowledge-context.v1" &&
              typeof row.content === "string" &&
              row.content.includes(marker),
          );
      heldOne.release();
      await finish(turnA);
      await vi.waitFor(async () => {
        expect(await containsPacket(a, alpha.session.sessionId, FACT_C)).toBe(true);
        expect(model!.requests).toHaveLength(before + 3);
      }, WAIT);
      // B still has its original model call in flight. Background maintenance
      // must wait for B, independently of A's completed delivery and C's response.
      expect(await containsPacket(b, beta.session.sessionId, FACT_C)).toBe(false);
      mark("one-recipient-settled-other-still-active");
      heldTwo.release();
      await finish(turnB);
      await vi.waitFor(async () => {
        expect(await containsPacket(b, beta.session.sessionId, FACT_C)).toBe(true);
        expect(model!.requests).toHaveLength(before + 3);
      }, WAIT);
      expect(model.requests).toHaveLength(before + 3);

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
      // A real completed run retains its native writer fence. Do not manufacture
      // idleness by clearing that field in a fixture, or send another target turn
      // to make foreground catch-up hide a broken background admission.
      mark("publishing-to-settled-recipients");
      const idleSource = await send(c, IDLE_FACT);
      const idleRequests = model.requests.length;
      let deliveries = { alpha: 0, beta: 0 };
      let idleObservedAt: number | undefined;
      try {
        await vi.waitFor(async () => {
          // chat.history intentionally hides display:false knowledge packets.
          // Read only this fixture's canonical ledger through the native worker API.
          const [aHistory, bHistory] = await Promise.all([
            retained(a, alpha.session.sessionId),
            retained(b, beta.session.sessionId),
          ]);
          const count = (events: typeof aHistory) =>
            events
              .map(asOptionalRecord)
              .filter(
                (row) =>
                  row?.type === "custom_message" &&
                  row.customType === "openclaw.conversation-knowledge-context.v1" &&
                  typeof row.content === "string" &&
                  row.content.includes(IDLE_FACT),
              ).length;
          deliveries = { alpha: count(aHistory), beta: count(bHistory) };
          expect(model!.requests).toHaveLength(idleRequests);
          expect(deliveries).toEqual({ alpha: 1, beta: 1 });
          idleObservedAt = performance.now();
        }, WAIT);
      } finally {
        mark("idle-durable-delivery", {
          ...deliveries,
          elapsedMs: performance.now() - idleSource.callStartedAt,
          unexpectedModelRequests: model.requests.length - idleRequests,
          busyRefusals:
            gateway.logs().split("Idle conversation recipient has an active owner").length - 1,
          observation: "durable history read, no recipient input or forced catch-up",
        });
      }
      expect(idleObservedAt).toBeDefined();
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
          activityTransitions: phases,
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
