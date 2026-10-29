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
const CODE_DURING_RUN = "SYNTHETIC_SHARED_TEAL_28";
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
      roles: {
        default: "limited",
        definitions: {
          limited: {
            sessions: { others: "view" },
            agents: "*",
            scopes: BRANCH_GATEWAY_SCOPES,
          },
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

function preparedSourceReached(
  gateway: OpenClawTestInstance,
  recipientId: string,
  sourceId: string,
  sequence: number,
) {
  const recipient = redactIdentifier(recipientId);
  return gateway
    .logs()
    .split("\n")
    .some((line) => {
      if (
        !line.includes("Related-history source preparation settled") ||
        !line.includes(recipient)
      ) {
        return false;
      }
      return sourceFrontierReached(line, sourceId, sequence);
    });
}

function sourceFrontierReached(line: string, sourceId: string, sequence: number) {
  // Console JSON can contain an escaped structured-log payload.
  const normalized = line.replaceAll('\\"', '"');
  return [
    ...normalized.matchAll(/"sourceHash"\s*:\s*"([^"]+)"\s*,\s*"throughSeq"\s*:\s*(\d+)/gu),
  ].some((match) => match[1] === redactIdentifier(sourceId) && Number(match[2]) >= sequence);
}

function preparedRootOriginals(gateway: OpenClawTestInstance) {
  // This fixture has one private audience until the later privacy probe.
  // Observe completion of the separate root lane, not merely a recipient quantum.
  return gateway
    .logs()
    .split("\n")
    .reduce((maximum, line) => {
      if (!line.includes("Related-history root projection ready")) {
        return maximum;
      }
      const count = /preparedTailCount\\?"\s*:\s*(\d+)/u.exec(line)?.[1];
      return count ? Math.max(maximum, Number(count)) : maximum;
    }, 0);
}

describe("isolated full Gateway conversation continuity", () => {
  it("uses a native root checkpoint for a new branch and preserves the original history", async (context) => {
    let gateway: OpenClawTestInstance | undefined;
    let model: Model | undefined;
    let owner: Operator | undefined;
    context.onTestFailed(() => console.error(gateway?.logs()));
    const markers = Array.from({ length: 8 }, (_, index) => `SUMMARY_FACT_${index}_73`);
    await runQaGatewayTestFixture(
      context,
      async ({ signal, verifyCleanup }) => {
        model = await startConversationModel(signal, (request, index) => {
          const serialized = JSON.stringify(request);
          if (serialized.includes("You are a context summarization assistant.")) {
            const facts = [
              ...new Set(serialized.match(/SUMMARY_FACT_\d+_73|REUSABLE_LOCAL_HISTORY_73/gu) ?? []),
            ];
            return `## Decisions\nSynthetic facts retained: ${facts.join(", ")}\n## Open tasks\nNone.`;
          }
          return `FIXTURE_REPLY_${index}`;
        });
        const selected = config("branches", model);
        selected.agents!.defaults!.compaction = {
          enabled: true,
          keepRecentTokens: 1_024,
          recentTurnsPreserve: 0,
          qualityGuard: { enabled: false },
        };
        for (const provider of Object.values(selected.models!.providers!)) {
          provider.models = provider.models.map((entry) =>
            Object.assign({}, entry, { contextWindow: 32_768 }),
          );
        }
        gateway = await createOpenClawTestInstance({
          name: "conversation-checkpoint-pressure",
          signal,
          verifyCleanup,
          config: selected,
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
        const source = `agent:main:checkpoint-source-${randomUUID()}`;
        const destination = `agent:main:checkpoint-new-${randomUUID()}`;
        const reusable = `agent:main:checkpoint-reusable-${randomUUID()}`;
        const send = async (key: string, message: string) => {
          const started = await owner!.call<{ runId: string; status: string }>("chat.send", {
            sessionKey: key,
            message,
            deliver: false,
            idempotencyKey: randomUUID(),
          });
          expect(started.status).toBe("started");
          expect(
            await owner!.call(
              "agent.wait",
              { runId: started.runId, timeoutMs: 60_000 },
              { timeoutMs: 61_000 }, // Allow the server's bounded wait to return over the socket.
            ),
          ).toMatchObject({ status: "ok" });
          const requests = model!.requests.filter((request) => {
            const serialized = JSON.stringify(request);
            return (
              serialized.includes(message) &&
              !serialized.includes("You are a context summarization assistant.")
            );
          });
          expect(requests.length).toBeGreaterThan(0);
          return requests.at(-1)!;
        };
        // Enough original text to cross the model's actual native token budget.
        // No root write, forced publication or synthetic checkpoint is injected.
        const filler = "Synthetic archived detail for this controlled test. ".repeat(350);
        await send(reusable, "REUSABLE_LOCAL_HISTORY_73");
        const reusableDescription = await owner.call<Description>("sessions.describe", {
          key: reusable,
        });
        await send(source, `${markers[0]}. ${filler}`);
        const sourceDescription = await owner.call<Description>("sessions.describe", {
          key: source,
        });
        const firstHistory = await owner.call<{
          messages: Array<{ role: string; content: unknown; __openclaw?: { seq?: number } }>;
        }>("chat.history", { sessionKey: source, limit: 100 });
        const firstSequence = firstHistory.messages.find(
          (message) =>
            message.role === "user" && JSON.stringify(message.content).includes(markers[0]!),
        )?.["__openclaw"]?.seq;
        if (typeof firstSequence !== "number") {
          throw new Error("Native source sequence is missing");
        }
        await vi.waitFor(() => {
          expect(
            preparedSourceReached(
              gateway!,
              reusableDescription.session.sessionId,
              sourceDescription.session.sessionId,
              firstSequence,
            ),
          ).toBe(true);
        }, WAIT);
        const initialReuse = JSON.stringify(await send(reusable, "REUSABLE_FIRST_IMPORT_PROBE_73"));
        expect(initialReuse.split(markers[0]!).length - 1).toBe(1);
        expect(initialReuse).not.toContain("Summary of related conversations");
        for (const marker of markers.slice(1)) {
          await send(source, `${marker}. ${filler}`);
        }
        const history = await owner.call<{
          messages: Array<{ role: string; content: unknown; __openclaw?: { seq?: number } }>;
        }>("chat.history", { sessionKey: source, limit: 100 });
        const originalInputs = history.messages.filter((message) => message.role === "user");
        const lastOriginal = originalInputs.find((message) =>
          JSON.stringify(message.content).includes(markers.at(-1)!),
        );
        const lastSequence = lastOriginal?.["__openclaw"]?.seq;
        if (typeof lastSequence !== "number") {
          throw new Error("Native source sequence is missing");
        }
        await vi.waitFor(
          () => {
            expect(gateway!.logs()).toContain("Related-history checkpoint prepared");
            expect(
              gateway!
                .logs()
                .split("\n")
                .some(
                  (line) =>
                    line.includes("Related-history root projection ready") &&
                    sourceFrontierReached(line, sourceDescription.session.sessionId, lastSequence),
                ),
            ).toBe(true);
          },
          { timeout: 60_000, interval: 100 },
        );
        await send(destination, "CHECKPOINT_COLD_BRANCH_PROBE_73");
        const requests = model.requests.filter((request) => {
          const serialized = JSON.stringify(request);
          return (
            serialized.includes("CHECKPOINT_COLD_BRANCH_PROBE_73") &&
            !serialized.includes("You are a context summarization assistant.")
          );
        });
        expect(requests).toHaveLength(1);
        const input = JSON.stringify(requests[0]);
        expect(input).toContain("Summary of related conversations");
        for (const marker of markers) {
          expect(input.split(marker).length - 1).toBe(1);
        }
        for (const marker of markers) {
          expect(
            originalInputs.filter((message) => JSON.stringify(message.content).includes(marker)),
          ).toHaveLength(1);
        }
        // This branch already imported originals before the root checkpoint. It
        // must continue its own window, not replace it with the new root summary.
        await vi.waitFor(() => {
          expect(
            preparedSourceReached(
              gateway!,
              reusableDescription.session.sessionId,
              sourceDescription.session.sessionId,
              lastSequence,
            ),
          ).toBe(true);
        }, WAIT);
        const reused = JSON.stringify(await send(reusable, "REUSABLE_AFTER_ROOT_CHECKPOINT_73"));
        expect(reused).toContain("REUSABLE_LOCAL_HISTORY_73");
        expect(reused).not.toContain("Summary of related conversations");
        for (const marker of markers.slice(0, 2)) {
          expect(reused.split(marker).length - 1).toBe(1);
        }

        // Restart must recover the imported immutable checkpoint receipt and
        // coverage, rather than replaying every summarized source original.
        const destinationDescription = await owner.call<Description>("sessions.describe", {
          key: destination,
        });
        await owner.close();
        owner = undefined;
        await gateway.stopGateway();
        await gateway.startGateway();
        owner = await connectConversationOperator(gateway, "alex@example.test", signal);
        expect(
          (await owner.call<Description>("sessions.describe", { key: destination })).session
            .sessionId,
        ).toBe(destinationDescription.session.sessionId);
        const restarted = JSON.stringify(await send(destination, "CHECKPOINT_RESTART_PROBE_73"));
        expect(restarted).toContain("Summary of related conversations");
        for (const marker of markers) {
          expect(restarted.split(marker).length - 1).toBe(1);
        }
        expect(model.errors).toEqual([]);
      },
      () => owner?.close(),
      () => gateway?.cleanup(),
      () => model?.stop(),
    );
  }, 300_000);

  it.for(["native", "branches"] as const)(
    "%s: real input, background preparation, private recipients and restart",
    { timeout: 240_000 },
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
              await client.call(
                "agent.wait",
                { runId: started.runId, timeoutMs: 30_000 },
                { timeoutMs: 31_000 },
              ),
            ).toMatchObject({ status: "ok" });
            expect(model!.errors).toEqual([]);
            // No unrequested model work or silent retries may hide behind a successful turn.
            expect(model!.requests).toHaveLength(before + 1);
            return JSON.stringify(model!.requests[before]);
          };
          const describeSession = (key: string) =>
            owner.call<Description>("sessions.describe", { key });
          const waitForSource = async (recipientId: string, sourceKey: string, marker: string) => {
            const source = await describeSession(sourceKey);
            const history = await owner.call<{
              messages: Array<{ role: string; content: unknown; __openclaw?: { seq?: number } }>;
            }>("chat.history", { sessionKey: sourceKey, limit: 100 });
            const originals = history.messages.filter(
              (message) =>
                message.role === "user" && JSON.stringify(message.content).includes(marker),
            );
            expect(originals).toHaveLength(1);
            const sequence = originals[0]?.["__openclaw"]?.seq;
            expect(Number.isSafeInteger(sequence)).toBe(true);
            if (typeof sequence !== "number") {
              throw new Error("Native source sequence is missing");
            }
            const requestCount = model!.requests.length;
            await vi.waitFor(() => {
              expect(
                preparedSourceReached(gateway!, recipientId, source.session.sessionId, sequence),
              ).toBe(true);
            }, WAIT);
            expect(model!.requests).toHaveLength(requestCount);
          };
          await send(owner, beta, "RECIPIENT_LOCAL_HISTORY_21");
          const recipient = await describeSession(beta);
          expect(recipient.session).toMatchObject({ visibility: "draft", sharingRole: "owner" });
          if (mode === "branches") {
            // Finish initial registration before measuring a source-triggered idle cycle.
            await vi.waitFor(() => {
              expect(settledPreparations(gateway!, recipient.session.sessionId)).toBeGreaterThan(0);
            }, WAIT);
          }
          await send(owner, alpha, `Remember this exact code: ${CODE_ONE}`);
          if (mode === "branches") {
            await waitForSource(recipient.session.sessionId, alpha, CODE_ONE);
          }
          const reusedInput = await send(owner, beta, "REUSED_RECIPIENT_PROBE_31");
          expect(reusedInput).toContain("RECIPIENT_LOCAL_HISTORY_21");
          expect(reusedInput.split(CODE_ONE).length - 1).toBe(mode === "branches" ? 1 : 0);

          await send(owner, alpha, `A second exact code: ${CODE_TWO}`);
          if (mode === "branches") {
            await waitForSource(recipient.session.sessionId, alpha, CODE_TWO);
          }
          if (mode === "branches") {
            const requestCount = model.requests.length;
            // Four completed ordinary turns each publish a user and an assistant original.
            await vi.waitFor(() => {
              expect(preparedRootOriginals(gateway!)).toBeGreaterThanOrEqual(8);
            }, WAIT);
            expect(model.requests).toHaveLength(requestCount);
          }
          const newInput = await send(owner, gamma, "NEW_RECIPIENT_PROBE_41");
          for (const marker of [CODE_ONE, CODE_TWO]) {
            expect(newInput.split(marker).length - 1).toBe(mode === "branches" ? 1 : 0);
          }

          // Hold only the provider response. The real Gateway must still serve a sibling,
          // retain the new contribution and deliver it after the recipient's safe boundary.
          const held = model.holdNext((request) =>
            JSON.stringify(request).includes("HELD_RECIPIENT_PROBE_45"),
          );
          try {
            const running = await owner.call<{ runId: string; status: string }>("chat.send", {
              sessionKey: beta,
              message: "HELD_RECIPIENT_PROBE_45",
              deliver: false,
              idempotencyKey: randomUUID(),
            });
            expect(running.status).toBe("started");
            await vi.waitFor(() => {
              expect(
                model!.requests.some((request) =>
                  JSON.stringify(request).includes("HELD_RECIPIENT_PROBE_45"),
                ),
              ).toBe(true);
            }, WAIT);
            const heldInput = await held.entered;
            expect(JSON.stringify(heldInput)).not.toContain(CODE_DURING_RUN);
            await send(owner, alpha, `A code published during another run: ${CODE_DURING_RUN}`);
            held.release();
            expect(
              await owner.call(
                "agent.wait",
                { runId: running.runId, timeoutMs: 30_000 },
                { timeoutMs: 31_000 },
              ),
            ).toMatchObject({ status: "ok" });
            if (mode === "branches") {
              await waitForSource(recipient.session.sessionId, alpha, CODE_DURING_RUN);
            }
            const afterConcurrentInput = await send(owner, beta, "AFTER_HELD_RECIPIENT_PROBE_46");
            expect(afterConcurrentInput.split(CODE_DURING_RUN).length - 1).toBe(
              mode === "branches" ? 1 : 0,
            );
          } finally {
            held.release();
          }
          await send(other, privateBranch, `My private code is ${PRIVATE_CODE}`);
          if (mode === "branches") {
            // Prove the forbidden source is ready before asserting non-disclosure.
            // Resolve it through its own authenticated owner, not the recipient.
            const privateSource = await other.call<Description>("sessions.describe", {
              key: privateBranch,
            });
            const privateHistory = await other.call<{
              messages: Array<{ role: string; content: unknown; __openclaw?: { seq?: number } }>;
            }>("chat.history", { sessionKey: privateBranch, limit: 100 });
            const originals = privateHistory.messages.filter(
              (message) =>
                message.role === "user" && JSON.stringify(message.content).includes(PRIVATE_CODE),
            );
            expect(originals).toHaveLength(1);
            const privateSequence = originals[0]?.["__openclaw"]?.seq;
            if (typeof privateSequence !== "number" || !Number.isSafeInteger(privateSequence)) {
              throw new Error("Native private source sequence is missing");
            }
            const requestCount = model.requests.length;
            await vi.waitFor(() => {
              expect(
                gateway!
                  .logs()
                  .split("\n")
                  .some(
                    (line) =>
                      line.includes("Related-history root projection ready") &&
                      sourceFrontierReached(line, privateSource.session.sessionId, privateSequence),
                  ),
              ).toBe(true);
            }, WAIT);
            expect(model.requests).toHaveLength(requestCount);
          }
          const privateInput = await send(owner, beta, "PRIVATE_RECIPIENT_PROBE_51");
          expect(privateInput).not.toContain(PRIVATE_CODE);
          // Native role-bound draft reads hide the target with an empty success response.
          expect(await other.call("sessions.describe", { key: beta })).toMatchObject({
            session: null,
          });
          expect(await other.call("sessions.get", { key: beta })).toMatchObject({ messages: [] });

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
          for (const marker of [CODE_ONE, CODE_TWO, CODE_DURING_RUN]) {
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
  );
});
