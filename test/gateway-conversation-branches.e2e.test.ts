import { randomUUID } from "node:crypto";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { describe, expect, it, vi } from "vitest";
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
type Description = { session: { sessionId: string; visibility: string; sharingRole: string } };
const WAIT = { timeout: 30_000, interval: 50 } as const;
const CODE_ONE = "SYNTHETIC_SHARED_COBALT_73";
const CODE_TWO = "SYNTHETIC_SHARED_AMBER_94";
const PRIVATE_CODE = "SYNTHETIC_OTHER_PERSON_MAUVE_16";

function config(mode: "native" | "branches", model: Model): OpenClawConfig {
  const provider = buildMockOpenAiResponsesProvider(model.baseUrl, "conversation-proof");
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
    tools: { deny: ["*"] },
    models: {
      mode: "replace",
      providers: {
        [provider.providerId]: {
          ...provider.config,
          request: { allowPrivateNetwork: true },
          models: provider.config.models.map((entry) => ({ ...entry, input: [...entry.input] })),
        },
      },
    },
    skills: { workshop: { autonomous: { mode: "off" } } },
    plugins: { slots: { memory: "none" } },
    messages: { queue: { mode: "steer", debounceMsByChannel: { webchat: 0 } } },
  };
}

/** Observe the actual background owner; never invoke publication/catch-up from the test. */
function settledPreparations(gateway: OpenClawTestInstance, sessionId: string) {
  const recipient = redactIdentifier(sessionId);
  return gateway
    .logs()
    .split("\n")
    .filter(
      (line) =>
        line.includes("Related-history source preparation settled") && line.includes(recipient),
    ).length;
}

describe("isolated full Gateway conversation continuity", () => {
  it.each(["native", "branches"] as const)(
    "%s: real input, background preparation, private recipients and restart",
    async (mode, context) => {
      let gateway: OpenClawTestInstance | undefined;
      let model: Model | undefined;
      const clients: Operator[] = [];
      context.onTestFailed(() => console.error(gateway?.logs()));
      await runQaGatewayTestFixture(
        context,
        async ({ signal, verifyCleanup }) => {
          model = await startConversationModel(signal);
          gateway = await createOpenClawTestInstance({
            name: `conversation-continuity-${mode}`,
            signal,
            verifyCleanup,
            config: config(mode, model),
            env: {
              OPENCLAW_SKIP_PROVIDERS: undefined,
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
              OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
              OPENCLAW_LOG_LEVEL: "debug",
            },
          });
          isolateConversationGatewayEnvironment(gateway);
          await gateway.startGateway();
          const connect = async (email: string) => {
            const client = await connectConversationOperator(gateway!, email, signal);
            clients.push(client);
            return client;
          };
          let owner = await connect("alex@example.test");
          const other = await connect("blair@example.test");
          const ownerProfile = await owner.call<{ profile: { id: string } }>("users.self", {});
          const otherProfile = await other.call<{ profile: { id: string } }>("users.self", {});
          expect(ownerProfile.profile.id).not.toBe(otherProfile.profile.id);
          const alpha = `agent:main:proof-alpha-${randomUUID()}`;
          const beta = `agent:main:proof-beta-${randomUUID()}`;
          const gamma = `agent:main:proof-gamma-${randomUUID()}`;
          const privateBranch = `agent:main:proof-private-${randomUUID()}`;
          const send = async (client: Operator, key: string, message: string) => {
            const before = model!.requests.length;
            const started = await client.call<{ runId: string; status: string }>("chat.send", {
              sessionKey: key,
              message,
              deliver: false,
              idempotencyKey: randomUUID(),
            });
            expect(started.status).toBe("started");
            expect(
              await client.call("agent.wait", { runId: started.runId, timeoutMs: 30_000 }),
            ).toMatchObject({ status: "ok" });
            expect(model!.errors).toEqual([]);
            // No unrequested model work or silent retries may hide behind a successful turn.
            expect(model!.requests).toHaveLength(before + 1);
            return JSON.stringify(model!.requests[before]);
          };
          const describeSession = (key: string) =>
            owner.call<Description>("sessions.describe", { key });
          await send(owner, beta, "RECIPIENT_LOCAL_HISTORY_21");
          const recipient = await describeSession(beta);
          expect(recipient.session).toMatchObject({ visibility: "draft", sharingRole: "owner" });
          if (mode === "branches") {
            // Finish initial registration before measuring a source-triggered idle cycle.
            await vi.waitFor(() => {
              expect(settledPreparations(gateway!, recipient.session.sessionId)).toBeGreaterThan(0);
            }, WAIT);
          }
          const beforeSource = settledPreparations(gateway, recipient.session.sessionId);
          await send(owner, alpha, `Remember this exact code: ${CODE_ONE}`);
          if (mode === "branches") {
            const requestCount = model.requests.length;
            await vi.waitFor(() => {
              expect(settledPreparations(gateway!, recipient.session.sessionId)).toBeGreaterThan(
                beforeSource,
              );
            }, WAIT);
            expect(model.requests).toHaveLength(requestCount);
          }
          const reusedInput = await send(owner, beta, "REUSED_RECIPIENT_PROBE_31");
          expect(reusedInput).toContain("RECIPIENT_LOCAL_HISTORY_21");
          expect(reusedInput.split(CODE_ONE).length - 1).toBe(mode === "branches" ? 1 : 0);

          const beforeSecondSource = settledPreparations(gateway, recipient.session.sessionId);
          await send(owner, alpha, `A second exact code: ${CODE_TWO}`);
          if (mode === "branches") {
            const requestCount = model.requests.length;
            await vi.waitFor(() => {
              expect(settledPreparations(gateway!, recipient.session.sessionId)).toBeGreaterThan(
                beforeSecondSource,
              );
            }, WAIT);
            expect(model.requests).toHaveLength(requestCount);
          }
          const newInput = await send(owner, gamma, "NEW_RECIPIENT_PROBE_41");
          for (const marker of [CODE_ONE, CODE_TWO]) {
            expect(newInput.split(marker).length - 1).toBe(mode === "branches" ? 1 : 0);
          }
          await send(other, privateBranch, `My private code is ${PRIVATE_CODE}`);
          const privateInput = await send(owner, beta, "PRIVATE_RECIPIENT_PROBE_51");
          expect(privateInput).not.toContain(PRIVATE_CODE);
          // Another authenticated human must not gain the owner's private session itself either.
          await expect(other.call("sessions.describe", { key: beta })).rejects.toThrow();

          for (const client of clients.splice(0)) {
            await client.close();
          }
          await gateway.stopGateway();
          await gateway.startGateway();
          owner = await connect("alex@example.test");
          expect((await owner.call<{ profile: { id: string } }>("users.self", {})).profile.id).toBe(
            ownerProfile.profile.id,
          );
          expect((await describeSession(beta)).session.sessionId).toBe(recipient.session.sessionId);
          const restartedInput = await send(owner, beta, "RESTART_RECIPIENT_PROBE_61");
          expect(restartedInput).toContain("RECIPIENT_LOCAL_HISTORY_21");
          expect(restartedInput).not.toContain(PRIVATE_CODE);
          for (const marker of [CODE_ONE, CODE_TWO]) {
            expect(restartedInput.split(marker).length - 1).toBe(mode === "branches" ? 1 : 0);
          }
        },
        async () => {
          const outcomes = await Promise.allSettled(
            clients.splice(0).map((client) => client.close()),
          );
          const failures = outcomes.flatMap((outcome) =>
            outcome.status === "rejected" ? [outcome.reason] : [],
          );
          if (failures.length) {
            throw new AggregateError(failures, "Conversation clients did not close");
          }
        },
        () => gateway?.cleanup(),
        () => model?.stop(),
      );
    },
    240_000,
  );
});
