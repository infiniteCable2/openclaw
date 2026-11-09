import { randomUUID } from "node:crypto";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { OperatorScope } from "../src/gateway/operator-scopes.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { workshopPluginConfig } from "../src/skills/test-support/workshop-config.test-support.js";
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
import { withinTest } from "./helpers/promise.js";
import { runQaGatewayTestFixture } from "./helpers/qa-gateway-test-lifetime.js";

type Operator = Awaited<ReturnType<typeof connectConversationOperator>>;
type Model = Awaited<ReturnType<typeof startConversationModel>>;
type Turn = { runId: string; callStartedAt: number; acknowledgedAt: number };
type Description = { session: { sessionId: string; visibility: string; sharingRole: string } };

function config(model: Model, scopes: OperatorScope[] = BRANCH_GATEWAY_SCOPES): OpenClawConfig {
  const provider = buildMockOpenAiResponsesProvider(model.baseUrl, "bidirectional-proof");
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
            deviceAutoApprove: { enabled: true, scopes },
          },
        },
        controlUi: { enabled: false, allowedOrigins: [BRANCH_GATEWAY_ORIGIN] },
        roles: {
          default: "limited",
          definitions: {
            limited: { sessions: { others: "view" }, agents: "*", scopes },
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
      plugins: { slots: { memory: "none" } },
      messages: { queue: { mode: "steer", debounceMsByChannel: { webchat: 0 } } },
    },
  );
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
      (_unused, n) =>
        "Archive-" + id + "-" + n + " records a synthetic cobalt item at shelf " + n + ".",
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
      const lastSequence = history.messages.findLast((row) => row.role === "assistant")?.[
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

it("compacts a warm recipient across a config reload and imports every pending turn without recipient input", async (context) => {
  let gateway: OpenClawTestInstance | undefined;
  let model: Model | undefined;
  let owner: Operator | undefined;
  context.onTestFailed(() => console.error(gateway?.logs()));
  await runQaGatewayTestFixture(
    context,
    async ({ signal, verifyCleanup }) => {
      const padding = "Synthetic local archive padding records cobalt storage items. "
        .repeat(280)
        .slice(0, 16_000);
      const isSummary = (request: Record<string, unknown>) =>
        JSON.stringify(request).includes("You are a context summarization assistant.");
      let nextOrdinaryReply: string | undefined;
      model = await startConversationModel(signal, (request, index) => {
        if (isSummary(request)) {
          const facts = [
            ...new Set(
              JSON.stringify(request).match(
                /PRESSURE_LOCAL_FACT_\d+_281|PRESSURE_FOREIGN_(?:INITIAL|LATE)_281/gu,
              ) ?? [],
            ),
          ];
          return `## Decisions\nNATIVE_PRESSURE_SUMMARY_281\n${facts.join("\n")}\n## Open tasks\nNone.`;
        }
        if (nextOrdinaryReply !== undefined) {
          const reply = nextOrdinaryReply;
          nextOrdinaryReply = undefined;
          return reply;
        }
        return `PRESSURE_REPLY_${index}`;
      });
      const scopes = [...BRANCH_GATEWAY_SCOPES, "operator.admin" as const];
      const selected = config(model, scopes);
      selected.agents!.defaults!.compaction = {
        enabled: true,
        notifyUser: false,
        keepRecentTokens: 1_024,
        recentTurnsPreserve: 0,
        qualityGuard: { enabled: false },
        memoryFlush: { enabled: false },
      };
      for (const provider of Object.values(selected.models!.providers!)) {
        provider.models = provider.models.map((entry) =>
          Object.assign({}, entry, { contextWindow: 32_768 }),
        );
      }
      gateway = await createOpenClawTestInstance({
        name: "warm-recipient-idle-pressure",
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
      const donor = `agent:main:pressure-donor-${randomUUID()}`;
      const recipient = `agent:main:pressure-recipient-${randomUUID()}`;
      let recipientOutputs = 0;
      let lastFinalOutputRun: string | undefined;
      let lastRecipientRun: string | undefined;
      owner = await connectConversationOperator(gateway, "alex@example.test", signal, {
        scopes,
        onEvent(event, payload) {
          const row = asOptionalRecord(payload);
          if (
            event === "chat" &&
            row?.sessionKey === recipient &&
            typeof row.runId === "string" &&
            (row.state === "final" || row.state === "delta") &&
            row.message
          ) {
            recipientOutputs++;
            if (row.state === "final") {
              lastFinalOutputRun = row.runId;
            }
          }
        },
      });
      const normalRequests = () => model!.requests.filter((request) => !isSummary(request));
      const send = async (key: string, message: string) => {
        const before = model!.requests.length;
        const started = await owner!.call<{ runId: string; status: string }>("chat.send", {
          sessionKey: key,
          message,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(started.status).toBe("started");
        if (key === recipient) {
          lastRecipientRun = started.runId;
        }
        expect(
          await owner!.call(
            "agent.wait",
            { runId: started.runId, timeoutMs: 60_000 },
            { timeoutMs: 61_000 },
          ),
        ).toMatchObject({ status: "ok" });
        const calls = model!.requests
          .slice(before)
          .filter((request) => !isSummary(request) && JSON.stringify(request).includes(message));
        expect(calls).toHaveLength(1);
        expect(model!.errors).toEqual([]);
        return calls[0]!;
      };
      // Ignore incomplete rolling-log fragments, including after a process restart.
      const logs = () =>
        gateway!
          .logs()
          .split("\n")
          .flatMap((line) => {
            try {
              return asOptionalRecord(JSON.parse(line)) ? [line.replaceAll('\\"', '"')] : [];
            } catch {
              return [];
            }
          });
      const frontier = (line: string, sessionId: string) =>
        Number(
          new RegExp(
            `"sourceHash"\\s*:\\s*"${redactIdentifier(sessionId)}"[^}\\]]*"throughSeq"\\s*:\\s*(\\d+)`,
            "u",
          ).exec(line)?.[1] ?? -1,
        );
      const donorHistory = () =>
        owner!.call<{
          messages: Array<{
            role: string;
            content: unknown;
            __openclaw?: { transcriptPosition?: { rawSeq?: number } };
          }>;
        }>("chat.history", { sessionKey: donor, limit: 100 });
      await send(donor, "PRESSURE_FOREIGN_INITIAL_281");
      const donorDescription = await owner.call<Description>("sessions.describe", { key: donor });
      const initialSeq = (await donorHistory()).messages.findLast(
        (item) => item.role === "assistant",
      )?.["__openclaw"]?.transcriptPosition?.rawSeq;
      expect(initialSeq).toBeTypeOf("number");
      await vi.waitFor(
        () => {
          expect(
            logs().some(
              (line) =>
                line.includes("Related-history root projection ready") &&
                frontier(line, donorDescription.session.sessionId) >= initialSeq!,
            ),
          ).toBe(true);
        },
        { timeout: 60_000, interval: 50 },
      );
      const localFacts: string[] = [];
      let renderedChars = 0;
      // At most eight ordinary turns. Size the fixture from the real provider
      // prompt, not a guessed fixed system-prompt footprint. Each reply remains
      // below this provider's configured 4096-token output allowance.
      for (let index = 0; index < 8 && renderedChars + padding.length < 84_000; index++) {
        const fact = `PRESSURE_LOCAL_FACT_${index}_281`;
        localFacts.push(fact);
        // Runtime context can be a later user-role carrier. Select this fixture's
        // reply at its known input boundary, not by guessing the provider's last user.
        nextOrdinaryReply = padding;
        const request = await send(recipient, fact);
        expect(nextOrdinaryReply).toBeUndefined();
        const text = textLeaves([request.instructions, request.input]).join("\n");
        expect(text.split("PRESSURE_FOREIGN_INITIAL_281")).toHaveLength(2);
        renderedChars = text.length;
      }
      expect(renderedChars + padding.length).toBeGreaterThanOrEqual(84_000);
      const original = await owner.call<Description>("sessions.describe", { key: recipient });
      // Establish that the observer saw real output before testing a quiet window.
      expect(lastRecipientRun).toBeDefined();
      await vi.waitFor(() => expect(lastFinalOutputRun).toBe(lastRecipientRun));
      const outputsBeforePressure = recipientOutputs;
      const beforePressure = new Set(logs());
      const warmInput = normalRequests().at(-1);
      const normalBeforePressure = normalRequests().length;
      const summaryBeforePressure = model.requests.filter(isSummary).length;
      // The donor's user input and assistant reply are distinct publications.
      // No user turn may preempt idle maintenance from the held summary onward.
      // Root checkpoints summarize quoted source observations as user messages.
      // Only this recipient has the padding as an actual assistant response.
      const summary = model.holdNext(
        (request) =>
          isSummary(request) &&
          textLeaves(request.input).some((part) =>
            part.includes(
              "[Assistant]: Synthetic local archive padding records cobalt storage items.",
            ),
          ),
      );
      try {
        nextOrdinaryReply = `PRESSURE_FOREIGN_DONOR_REPLY_281 ${padding}`.slice(0, padding.length);
        await send(donor, "PRESSURE_FOREIGN_LATE_281");
        await withinTest(summary.entered, signal);
        const beforeConfig = await owner.call<{ hash: string }>("config.get", {});
        const pid = gateway.child!.pid;
        await expect(
          owner.call("config.patch", {
            baseHash: beforeConfig.hash,
            raw: JSON.stringify({ agents: { defaults: { compaction: { notifyUser: true } } } }),
          }),
        ).resolves.toMatchObject({
          ok: true,
          changedPaths: ["agents.defaults.compaction.notifyUser"],
        });
        const applied = await owner.call<{ appliedConfigHash: string; configRevisionHash: string }>(
          "config.get",
          {},
        );
        expect(applied.configRevisionHash).toBeTypeOf("string");
        expect(applied.appliedConfigHash).toBe(applied.configRevisionHash);
        expect(gateway.child!.pid).toBe(pid);
      } finally {
        summary.release();
      }
      const releasedAt = performance.now();
      const originalDonor = await donorHistory();
      expect(
        originalDonor.messages.filter(
          (item) =>
            item.role === "user" &&
            JSON.stringify(item.content).includes("PRESSURE_FOREIGN_LATE_281"),
        ),
      ).toHaveLength(1);
      const donorReplies = originalDonor.messages.filter(
        (item) =>
          item.role === "assistant" &&
          textLeaves(item.content).some((text) =>
            text.startsWith("PRESSURE_FOREIGN_DONOR_REPLY_281"),
          ),
      );
      expect(donorReplies).toHaveLength(1);
      const latestSeq = donorReplies[0]?.["__openclaw"]?.transcriptPosition?.rawSeq;
      expect(latestSeq).toBeTypeOf("number");
      const recipientHash = redactIdentifier(original.session.sessionId);
      const recipientLine = (line: string) =>
        new RegExp(`"recipientHash"\\s*:\\s*"${recipientHash}"`, "u").test(line);
      const recipientCompacted = (line: string) =>
        line.includes("Conversation knowledge idle maintenance") &&
        recipientLine(line) &&
        /"outcome"\s*:\s*"compacted"/u.test(line);
      await vi
        .waitFor(
          () => {
            const fresh = logs().filter((line) => !beforePressure.has(line));
            expect(fresh.some(recipientCompacted)).toBe(true);
            expect(
              fresh.some(
                (line) =>
                  line.includes("Conversation knowledge transfer outcome") &&
                  recipientLine(line) &&
                  /"cause"\s*:\s*"native-transcript-commit"/u.test(line) &&
                  frontier(line, donorDescription.session.sessionId) >= latestSeq!,
              ),
            ).toBe(true);
          },
          { timeout: 60_000, interval: 50 },
        )
        .catch((error: unknown) => {
          const fresh = logs().filter((line) => !beforePressure.has(line));
          const status = fresh.filter(recipientLine);
          const observed = (field: string) =>
            status.flatMap((line) =>
              [...line.matchAll(new RegExp(`"${field}"\\s*:\\s*([0-9]+)`, "gu"))].map((match) =>
                Number(match[1]),
              ),
            );
          const markers = (requests: Record<string, unknown>[]) => {
            const input = requests.map((request) =>
              textLeaves([request.instructions, request.input]).join("\n"),
            );
            return {
              initialForeign: input.some((text) => text.includes("PRESSURE_FOREIGN_INITIAL_281")),
              lateForeign: input.some((text) => text.includes("PRESSURE_FOREIGN_LATE_281")),
              localPadding: input.some((text) => text.includes("Synthetic local archive padding")),
            };
          };
          console.error(
            JSON.stringify({
              fixture: "warm-recipient-idle-pressure-timeout",
              recipientHash,
              renderedChars,
              localFacts: localFacts.length,
              summaryCalls: model!.requests.filter(isSummary).length,
              summaryCallsBeforePressure: summaryBeforePressure,
              ordinaryCallsSincePressure: normalRequests().length - normalBeforePressure,
              recipientStatusRecords: status.length,
              deferredStatusRecords: status.filter((line) =>
                /deferred|unavailable|refused/u.test(line),
              ).length,
              causes: [
                ...new Set(
                  status.flatMap((line) =>
                    [
                      ...line.matchAll(
                        /"(?:cause|reason|pending|errorCode|failureClass)"\s*:\s*"([A-Za-z][A-Za-z0-9_-]{0,63})"/gu,
                      ),
                    ].map((match) => match[1]),
                  ),
                ),
              ].slice(0, 24),
              capacityChecksMaxPerRecord: Math.max(0, ...observed("capacityChecks")),
              capacityRefusalsMaxPerRecord: Math.max(0, ...observed("capacityRefusals")),
              preparedPacketsMaxPerRecord: Math.max(0, ...observed("preparedPackets")),
              recipientModelMarkers: markers(warmInput ? [warmInput] : []),
              allModelMarkers: markers(model!.requests),
              summaryModelMarkers: markers(model!.requests.filter(isSummary)),
              recipientCompactions: fresh.filter(recipientCompacted).length,
            }),
          );
          throw error;
        });
      // Only the genuine donor turn may start an ordinary model request.
      // Native idle compaction and admission completed before any recipient probe.
      expect(normalRequests()).toHaveLength(normalBeforePressure + 1);
      expect(recipientOutputs).toBe(outputsBeforePressure);
      expect(model.requests.filter(isSummary).length).toBeGreaterThan(summaryBeforePressure);
      console.info(
        JSON.stringify({
          fixture: "idle-recipient-after-hot-reload",
          observedDrainMs: Math.round(performance.now() - releasedAt),
          ordinaryProviderRequests: normalRequests().length - normalBeforePressure,
          summaryProviderRequests: model.requests.filter(isSummary).length - summaryBeforePressure,
          recipientOutputs: recipientOutputs - outputsBeforePressure,
          donorThroughSeq: latestSeq,
        }),
      );
      const verify = (request: Record<string, unknown>, current: string) => {
        const messages = [
          request.instructions,
          ...(Array.isArray(request.input) ? request.input : [request.input]),
        ].map((message) => textLeaves(message).join("\n"));
        const text = messages.join("\n");
        expect(text).toContain("NATIVE_PRESSURE_SUMMARY_281");
        expect(text).not.toContain("Summary of related conversations");
        for (const fact of [...localFacts, "PRESSURE_FOREIGN_INITIAL_281"]) {
          // A single native summary can combine the history and split-turn
          // summaries. Repeated prose inside it is not a second imported packet.
          const carrying = messages.filter((message) => message.includes(fact));
          expect(carrying.length, fact).toBeGreaterThan(0);
          const summaries = carrying.filter((message) =>
            message.includes("NATIVE_PRESSURE_SUMMARY_281"),
          );
          expect(summaries.length, fact).toBeLessThanOrEqual(1);
          expect(carrying.length - summaries.length, fact).toBeLessThanOrEqual(1);
          for (const message of carrying.filter((item) => !summaries.includes(item))) {
            expect(message.split(fact).length - 1, fact).toBe(1);
          }
        }
        // The late observation was still pending at compaction. It must have
        // precisely one carrier, as must this turn's actual input.
        for (const fact of [
          "PRESSURE_FOREIGN_LATE_281",
          "PRESSURE_FOREIGN_DONOR_REPLY_281",
          current,
        ]) {
          expect(text.split(fact).length - 1, fact).toBe(1);
        }
        if (current === "PRESSURE_WARM_PROBE_281") {
          expect(
            messages.some(
              (message) =>
                message.includes("NATIVE_PRESSURE_SUMMARY_281") &&
                message.includes("PRESSURE_FOREIGN_LATE_281"),
            ),
          ).toBe(false);
        }
      };
      verify(await send(recipient, "PRESSURE_WARM_PROBE_281"), "PRESSURE_WARM_PROBE_281");
      await owner.close();
      owner = undefined;
      await gateway.stopGateway();
      await gateway.startGateway();
      owner = await connectConversationOperator(gateway, "alex@example.test", signal);
      expect(
        (await owner.call<Description>("sessions.describe", { key: recipient })).session.sessionId,
      ).toBe(original.session.sessionId);
      verify(await send(recipient, "PRESSURE_RESTART_PROBE_281"), "PRESSURE_RESTART_PROBE_281");
      expect(model.errors).toEqual([]);
    },
    () => owner?.close(),
    () => gateway?.cleanup(),
    () => model?.stop(),
  );
}, 300_000);
