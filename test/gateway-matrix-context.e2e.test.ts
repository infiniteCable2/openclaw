import { createServer } from "node:http";
import { json as readJson } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import {
  formatAgentEnvelopeTimestamp,
  resolveEnvelopeFormatOptions,
} from "../src/auto-reply/envelope.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { acquireTestPortBlock } from "../src/test-utils/port-claims.js";
import {
  BRANCH_GATEWAY_ORIGIN,
  BRANCH_GATEWAY_SCOPES,
  isolateConversationGatewayEnvironment,
  startConversationModel,
} from "./helpers/conversation-branches-gateway.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "./helpers/qa-gateway-test-lifetime.js";

type Model = Awaited<ReturnType<typeof startConversationModel>>;

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

const ROOM = "!synthetic-context:example.test";
const BOT = "@assistant:example.test";
const HUMAN = "@alex:example.test";

async function homeserver(signal: AbortSignal) {
  const claim = await acquireTestPortBlock({ offsets: [0], signal });
  const pending = new Set<import("node:http").ServerResponse>();
  const events: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const sends: string[] = [];
  const errors: string[] = [];
  let syncCount = 0;
  const state = [BOT, HUMAN].map((user) => ({
    type: "m.room.member",
    state_key: user,
    sender: user,
    content: { membership: "join", displayname: user === BOT ? "Assistant" : "Alex" },
    event_id: "$member-" + user,
    origin_server_ts: Date.now(),
  }));
  const sync = (response: import("node:http").ServerResponse, first: boolean) => {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        next_batch: "batch-" + ++syncCount,
        rooms: {
          join: {
            [ROOM]: {
              state: { events: first ? state : [] },
              timeline: { events: events.splice(0), limited: false, prev_batch: "before" },
              account_data: { events: [] },
              ephemeral: { events: [] },
              summary: { "m.joined_member_count": 2, "m.invited_member_count": 0 },
            },
          },
        },
        account_data: { events: [] },
        presence: { events: [] },
        to_device: { events: [] },
      }),
    );
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      const path = decodeURIComponent(url.pathname);
      requests.push((request.method ?? "") + " " + path);
      if (path.endsWith("/sync")) {
        if (syncCount === 0 || events.length) {
          sync(response, syncCount === 0);
        } else {
          pending.add(response);
          response.on("close", () => pending.delete(response));
        }
        return;
      }
      let body: unknown = {};
      if (path.endsWith("/versions")) {
        body = { versions: ["v1.11"], unstable_features: {} };
      } else if (path.endsWith("/account/whoami")) {
        body = { user_id: BOT, device_id: "SYNTHETIC" };
      } else if (path.endsWith("/joined_rooms")) {
        body = { joined_rooms: [ROOM] };
      } else if (path.endsWith("/joined_members")) {
        body = {
          joined: Object.fromEntries([BOT, HUMAN].map((user) => [user, { display_name: user }])),
        };
      } else if (path.endsWith("/members")) {
        body = { chunk: state };
      } else if (path.endsWith("/state")) {
        body = state;
      } else if (path.includes("/state/m.room.name")) {
        body = { name: "Synthetic context room" };
      } else if (path.includes("/state/m.room.power_levels")) {
        body = { users: { [BOT]: 100, [HUMAN]: 100 } };
      } else if (path.includes("/state/m.room.encryption")) {
        response
          .writeHead(404, { "content-type": "application/json" })
          .end(JSON.stringify({ errcode: "M_NOT_FOUND", error: "Unencrypted fixture" }));
        return;
      } else if (path.endsWith("/filter") && request.method === "POST") {
        body = { filter_id: "fixture-filter" };
      } else if (path.includes("/send/")) {
        const content = (await readJson(request)) as { body?: string };
        if (path.includes("/send/m.room.message/") && content.body) {
          sends.push(content.body);
        }
        body = { event_id: "$fixture-output-" + sends.length };
      } else if (
        path.includes("/account_data/") ||
        path.includes("/presence/") ||
        path.includes("/typing/") ||
        path.includes("/receipt/") ||
        path.endsWith("/read_markers") ||
        path.includes("/profile/") ||
        path.endsWith("/capabilities") ||
        path.endsWith("/pushrules/") ||
        path.endsWith("/devices")
      ) {
        body = path.endsWith("/devices") ? { devices: [] } : {};
      } else {
        errors.push((request.method ?? "") + " " + path);
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    })().catch((error: unknown) => {
      errors.push(String(error));
      response.writeHead(500).end();
    });
  });
  const abort = () => {
    for (const response of pending) {
      response.destroy();
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(claim.port, "127.0.0.1", resolve);
    });
  } catch (error) {
    signal.removeEventListener("abort", abort);
    await claim.release();
    throw error;
  }
  return {
    url: "http://127.0.0.1:" + claim.port,
    sends,
    errors,
    requests,
    get syncCount() {
      return syncCount;
    },
    push(marker: string, index: number) {
      const timestamp = Date.now();
      const id = "$synthetic-input-" + index;
      events.push({
        type: "m.room.message",
        sender: HUMAN,
        event_id: id,
        origin_server_ts: timestamp,
        content: { msgtype: "m.text", body: marker },
      });
      for (const response of pending) {
        pending.delete(response);
        sync(response, false);
      }
      return { id, timestamp };
    },
    async stop() {
      signal.removeEventListener("abort", abort);
      abort();
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } finally {
        await claim.release();
      }
    },
  };
}

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(strings);
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

it("observes real Matrix ingress and the provider-bound current request without a text copy", async (context) => {
  let gateway: OpenClawTestInstance | undefined;
  let model: Model | undefined;
  let matrix: Awaited<ReturnType<typeof homeserver>> | undefined;
  context.onTestFailed(() => {
    console.error(
      JSON.stringify({
        fixture: "matrix-context-diagnostics",
        matrixRequests: matrix?.requests,
        matrixErrors: matrix?.errors,
        gateway: gateway?.logs(),
      }),
    );
  });
  await runQaGatewayTestFixture(
    context,
    async ({ signal, verifyCleanup }) => {
      model = await startConversationModel(signal);
      matrix = await homeserver(signal);
      const selected = config(model);
      selected.channels = {
        matrix: {
          enabled: true,
          homeserver: matrix.url,
          network: { dangerouslyAllowPrivateNetwork: true },
          userId: BOT,
          accessToken: "synthetic-matrix-token",
          deviceId: "SYNTHETIC",
          encryption: false,
          startupVerification: "off",
          autoJoin: "off",
          joinIntro: false,
          groupPolicy: "allowlist",
          groupAllowFrom: [HUMAN],
          historyLimit: 20,
          rooms: { [ROOM]: { requireMention: false, users: [HUMAN] } },
          streaming: { mode: "off" },
          rtc: { enabled: false },
        },
      };
      selected.plugins = { slots: { memory: "none" }, entries: { matrix: { enabled: true } } };
      gateway = await createOpenClawTestInstance({
        name: "matrix-current-context",
        signal,
        verifyCleanup,
        config: selected,
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_SKIP_CHANNELS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
          OPENCLAW_LOG_LEVEL: "debug",
        },
      });
      isolateConversationGatewayEnvironment(gateway);
      await gateway.startGateway();
      await vi.waitFor(() => expect(matrix!.syncCount).toBeGreaterThan(0), {
        timeout: 30_000,
        interval: 50,
      });
      const reports = [];
      for (const index of [1, 2]) {
        const marker = "CURRENT_MATRIX_FULL_PAYLOAD_" + index;
        const before = model.requests.length;
        const event = matrix.push(marker, index);
        await vi.waitFor(() => expect(model!.requests).toHaveLength(before + 1), {
          timeout: 40_000,
          interval: 50,
        });
        await vi.waitFor(() => expect(matrix!.sends.length).toBe(index), {
          timeout: 30_000,
          interval: 50,
        });
        expect(matrix.sends[index - 1]).toContain("FIXTURE_REPLY_" + (before + 1));
        const input = model.requests[before]!;
        const text = strings([input.instructions, input.input]).join("\n");
        const runtime = Array.from(
          text.matchAll(/OpenClaw runtime context:\n([\s\S]*?)End OpenClaw runtime context\./gu),
          (match) => match[1] ?? "",
        ).join("\n");
        const eventTimestamp = formatAgentEnvelopeTimestamp(
          event.timestamp,
          resolveEnvelopeFormatOptions(selected),
        );
        if (!eventTimestamp) {
          throw new Error("Missing native event timestamp projection");
        }
        reports.push({
          index,
          currentCopies: text.split(marker).length - 1,
          currentCopiesInRuntime: runtime.split(marker).length - 1,
          currentMessageIdCopies: text.split(event.id).length - 1,
          runtimeBlocks: text.split("OpenClaw runtime context:").length - 1,
          currentTimestampInRuntime: runtime.includes(eventTimestamp),
          eventTimestamp,
          providerChars: text.length,
        });
      }
      console.info(
        JSON.stringify({
          fixture: "matrix-current-request-context",
          reports,
          homeserverErrors: matrix.errors,
          providerErrors: model.errors.length,
        }),
      );
      expect(matrix.errors).toEqual([]);
      expect(model.errors).toEqual([]);
      for (const report of reports) {
        expect(report.runtimeBlocks).toBeGreaterThan(0);
        expect(report.currentTimestampInRuntime).toBe(true);
        expect(report.currentCopies).toBe(1);
        expect(report.currentCopiesInRuntime).toBe(0);
      }
    },
    () => gateway?.cleanup(),
    () => matrix?.stop(),
    () => model?.stop(),
  );
}, 180_000);
