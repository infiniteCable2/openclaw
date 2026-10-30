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

const PART_COUNT = 48;
const PARTS = Array.from({ length: PART_COUNT }, (_, index) => {
  const id = String(index).padStart(3, "0");
  return (
    "FOREIGN_BEGIN_" +
    id +
    " " +
    Array.from(
      { length: 32 },
      (_, n) => "Archive-" + id + "-" + n + " records a synthetic cobalt item at shelf " + n + ".",
    ).join(" ") +
    " FOREIGN_MIDDLE_" +
    id +
    " All details belong to synthetic part " +
    id +
    ". FOREIGN_END_" +
    id
  );
});

function textLeaves(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(textLeaves);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const item = value as Record<string, unknown>;
  return [
    ...(typeof item.text === "string" ? [item.text] : []),
    ...Object.entries(item).flatMap(([key, nested]) => (key === "text" ? [] : textLeaves(nested))),
  ];
}

function inspectInput(request: Record<string, unknown>, current: string) {
  const text = textLeaves([request.instructions, request.input]).join("\n");
  const counts = PARTS.map((part, index) => ({
    index,
    begin: text.split("FOREIGN_BEGIN_" + String(index).padStart(3, "0")).length - 1,
    middle: text.split("FOREIGN_MIDDLE_" + String(index).padStart(3, "0")).length - 1,
    end: text.split("FOREIGN_END_" + String(index).padStart(3, "0")).length - 1,
    full: text.split(part).length - 1,
  }));
  return {
    chars: text.length,
    currentRequestCopies: text.split(current).length - 1,
    completeParts: counts.filter((part) => part.full === 1).length,
    missing: counts.filter(
      (part) => part.full === 0 || part.begin === 0 || part.middle === 0 || part.end === 0,
    ),
    duplicated: counts.filter(
      (part) => part.full > 1 || part.begin > 1 || part.middle > 1 || part.end > 1,
    ),
    checkpoint: text.includes("Summary of related conversations"),
  };
}

it("delivers every already prepared foreign part in the first safe request without repeating current input", async (context) => {
  let gateway: OpenClawTestInstance | undefined;
  let model: Model | undefined;
  let owner: Operator | undefined;
  context.onTestFailed(() => console.error(gateway?.logs()));
  await runQaGatewayTestFixture(
    context,
    async ({ signal, verifyCleanup }) => {
      model = await startConversationModel(signal);
      const selected = config(model);
      for (const provider of Object.values(selected.models!.providers!)) {
        provider.models = provider.models.map((entry) =>
          Object.assign({}, entry, { contextWindow: 262_144 }),
        );
      }
      gateway = await createOpenClawTestInstance({
        name: "foreign-context-fullness",
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
      const source = "agent:main:bulk-source-" + randomUUID();
      const reusable = "agent:main:bulk-reusable-" + randomUUID();
      const cold = "agent:main:bulk-cold-" + randomUUID();
      const start = async (key: string, message: string): Promise<Turn> => {
        const callStartedAt = performance.now();
        const result = await owner!.call<{ runId: string; status: string }>("chat.send", {
          sessionKey: key,
          message,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(result.status).toBe("started");
        return { runId: result.runId, callStartedAt, acknowledgedAt: performance.now() };
      };
      const send = async (key: string, message: string) => {
        const before = model!.requests.length;
        const turn = await start(key, message);
        expect(
          await owner!.call(
            "agent.wait",
            { runId: turn.runId, timeoutMs: 60_000 },
            { timeoutMs: 61_000 },
          ),
        ).toMatchObject({ status: "ok" });
        expect(model!.errors).toEqual([]);
        expect(model!.requests).toHaveLength(before + 1);
        return {
          input: model!.requests[before]!,
          dispatchMs: Number((model!.requestTimes[before]! - turn.callStartedAt).toFixed(3)),
        };
      };
      const describe = (key: string) => owner!.call<Description>("sessions.describe", { key });
      await send(reusable, "RECIPIENT_LOCAL_HISTORY_119");
      const initial = await describe(reusable);
      const sourceStarted = performance.now();
      for (const part of PARTS) {
        await send(source, part);
      }
      const sourcesFinished = performance.now();
      const donor = await describe(source);
      const history = await owner.call<{
        messages: Array<{
          role: string;
          content: unknown;
          __openclaw?: { transcriptPosition?: { rawSeq?: number } };
        }>;
      }>("chat.history", { sessionKey: source, limit: 200 });
      const originals = history.messages.filter(
        (row) => row.role === "user" && JSON.stringify(row.content).includes("FOREIGN_BEGIN_"),
      );
      expect(originals).toHaveLength(PART_COUNT);
      const lastSequence = history.messages.filter((row) => row.role === "assistant").at(-1)?.[
        "__openclaw"
      ]?.transcriptPosition?.rawSeq;
      expect(Number.isSafeInteger(lastSequence)).toBe(true);
      if (typeof lastSequence !== "number") {
        throw new Error("Original raw frontier unavailable");
      }
      await vi.waitFor(
        () => {
          expect(
            sourceReady(gateway!, initial.session.sessionId, donor.session.sessionId, lastSequence),
          ).toBe(true);
          const lines = gateway!
            .logs()
            .split("\n")
            .filter((line) => line.includes("Related-history root projection ready"));
          expect(
            lines.some((line) => {
              const normalized = line.replaceAll('\\"', '"');
              const count = /"preparedTailCount"\s*:\s*(\d+)/u.exec(normalized)?.[1];
              return (
                Number(count) === PART_COUNT * 2 + 2 &&
                normalized.includes(redactIdentifier(donor.session.sessionId)) &&
                Array.from(
                  normalized.matchAll(
                    /"sourceHash"\s*:\s*"([^"]+)"\s*,\s*"throughSeq"\s*:\s*(\d+)/gu,
                  ),
                ).some(
                  (match) =>
                    match[1] === redactIdentifier(donor.session.sessionId) &&
                    Number(match[2]) >= lastSequence,
                )
              );
            }),
          ).toBe(true);
        },
        { timeout: 60_000, interval: 50 },
      );
      const readyAt = performance.now();
      const probes = [];
      for (const [label, key, marker] of [
        ["reusable-first", reusable, "CURRENT_REUSABLE_FIRST_119"],
        ["reusable-repeat", reusable, "CURRENT_REUSABLE_REPEAT_119"],
        ["cold-first", cold, "CURRENT_COLD_FIRST_119"],
      ]) {
        const result = await send(key!, marker!);
        probes.push({
          label,
          dispatchMs: result.dispatchMs,
          ...inspectInput(result.input, marker!),
        });
      }
      expect((await describe(reusable)).session.sessionId).toBe(initial.session.sessionId);
      console.info(
        JSON.stringify({
          fixture: "prepared-foreign-context-fullness",
          runtime: "full-isolated-gateway-native-workers-http-provider",
          parts: PART_COUNT,
          originalChars: PARTS.reduce((sum, part) => sum + part.length, 0),
          sourceProductionMs: Number((sourcesFinished - sourceStarted).toFixed(3)),
          readyObservedAfterLastSourceMs: Number((readyAt - sourcesFinished).toFixed(3)),
          observation: "readiness upper bound includes native log delivery and observer polling",
          probes,
        }),
      );
      for (const probe of probes) {
        expect(probe.checkpoint, probe.label).toBe(false);
        expect(probe.currentRequestCopies, probe.label).toBe(1);
        expect(probe.missing, probe.label).toEqual([]);
        expect(probe.duplicated, probe.label).toEqual([]);
        expect(probe.completeParts, probe.label).toBe(PART_COUNT);
      }
    },
    () => owner?.close(),
    () => gateway?.cleanup(),
    () => model?.stop(),
  );
}, 300_000);
