import { once } from "node:events";
import { createServer } from "node:http";
import { json as readJson } from "node:stream/consumers";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  formatAgentEnvelopeTimestamp,
  resolveEnvelopeFormatOptions,
} from "../src/auto-reply/envelope.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { RUNTIME_CONTEXT_FOOTER, RUNTIME_CONTEXT_HEADER } from "../src/llm/types.js";
import { workshopPluginConfig } from "../src/skills/test-support/workshop-config.test-support.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../src/state/openclaw-state-db.paths.js";
import { setUserProfileRole } from "../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../src/state/user-profiles.js";
import { acquireTestPortBlock } from "../src/test-utils/port-claims.js";
import {
  BRANCH_GATEWAY_ORIGIN,
  BRANCH_GATEWAY_SCOPES,
  connectConversationOperator,
  isolateConversationGatewayEnvironment,
  startConversationModel,
  waitForConversationTransfer,
} from "./helpers/conversation-branches-gateway.js";
import { playMatrixConversation } from "./helpers/matrix-conversation-play.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "./helpers/qa-gateway-test-lifetime.js";

type Model = Awaited<ReturnType<typeof startConversationModel>>;
type Operator = Awaited<ReturnType<typeof connectConversationOperator>>;

function config(model: Model, mode: "native" | "branches" = "native"): OpenClawConfig {
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
        entries: { main: { conversationMode: mode, skills: [] } },
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

const ROOM = "!synthetic-context:example.test";
const BOT = "@assistant:example.test";
const HUMAN = "@alex:example.test";
const PERSON_EMAIL = "matrix-person@example.test";
const SIBLING_CODE = "SYNTHETIC_MATRIX_SIBLING_COBALT_47";
const MATRIX_KEY = `agent:main:matrix:channel:${ROOM}`;

async function homeserver(signal: AbortSignal) {
  const claim = await acquireTestPortBlock({ offsets: [0], signal });
  const pending = new Set<import("node:http").ServerResponse>();
  const events: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const sends: string[] = [];
  const errors: string[] = [];
  let syncCount = 0;
  let firstSync = true;
  const state = [BOT, HUMAN].map((user) => ({
    type: "m.room.member",
    state_key: user,
    sender: user,
    content: {
      membership: "join",
      displayname: user === BOT ? "Assistant" : "Alex",
      ...(user === BOT ? { is_direct: true } : {}),
    },
    event_id: "$member-" + user,
    origin_server_ts: Date.now(),
  }));
  const sync = (response: import("node:http").ServerResponse, first: boolean) => {
    firstSync = false;
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
        if (firstSync || events.length) {
          sync(response, firstSync);
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
      } else if (path.endsWith("/rtc/transports")) {
        body = { rtc_transports: [] };
      } else if (path.includes("/state/m.room.member/")) {
        body = state.find((entry) => path.endsWith(entry.state_key))?.content ?? {};
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
      } else if (
        request.method === "GET" &&
        (path.endsWith(`/rooms/${ROOM}/state/m.room.canonical_alias/`) ||
          path.endsWith(`/rooms/${ROOM}/state/m.room.canonical_alias`))
      ) {
        body = { alt_aliases: [] };
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
          server.emit("fixture-send", content.body);
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
    beginConnection() {
      firstSync = true;
    },
    sends,
    nextSend: () => once(server, "fixture-send", { signal }).then(([text]) => String(text)),
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

function preparedFrameOwners(gateway: OpenClawTestInstance) {
  return new Set(
    gateway
      .logs()
      .split("\n")
      .flatMap((line) => {
        const pid = line.includes("Related-history root initial frame ready")
          ? line.match(/"ownerPid"\s*:\s*(\d+)/)?.[1]
          : undefined;
        return pid ? [pid] : [];
      }),
  );
}

async function diagnoseMatrixStartupRow(gateway: OpenClawTestInstance, signal: AbortSignal) {
  const operator = await connectConversationOperator(
    gateway,
    "matrix-inspection@example.test",
    signal,
  );
  try {
    const reply = asOptionalRecord(
      await operator.call("sessions.describe", {
        key: `agent:main:matrix:channel:${ROOM}`,
        agentId: "main",
      }),
    );
    const row = asOptionalRecord(reply?.session);
    const identity = (value: unknown) => {
      const original = asOptionalRecord(asOptionalRecord(value)?.identity);
      return Object.fromEntries(
        ["type", "id", "domain", "idKind", "pluginId", "accountId", "senderKind"].flatMap((key) => {
          const field = original?.[key];
          return typeof field === "string" || field === null ? [[key, field]] : [];
        }),
      );
    };
    const participants = row?.expandedParticipants ?? row?.participants;
    const topology = asOptionalRecord(row?.conversationTopology);
    process.stderr.write(
      JSON.stringify({
        fixture: "matrix-startup-native-row",
        visible: row !== undefined,
        visibility: row?.visibility,
        sharingRole: row?.sharingRole,
        chatType: row?.chatType,
        participantCount: row?.participantCount,
        participants: Array.isArray(participants) ? participants.slice(0, 16).map(identity) : null,
        owner: identity(asOptionalRecord(row?.owner)?.actor),
        creator: identity(row?.createdActor),
        rosterProjection: "public-summary-excludes-owner",
        incognito: row?.incognito,
        archivedAt: row?.archivedAt,
        publicShareExposed: row ? Object.hasOwn(row, "publicShare") : false,
        publicSharePresent: row?.publicShare !== undefined,
        topologyExposed: row ? Object.hasOwn(row, "conversationTopology") : false,
        topology: topology
          ? {
              version: topology.version,
              role: topology.role,
              rootSessionKey: topology.rootSessionKey,
              rootSessionId: topology.rootSessionId,
              rootSessionLifecycleRevision: topology.rootSessionLifecycleRevision,
            }
          : null,
      }) + "\n",
    );
  } finally {
    await operator.close();
  }
}

it.for(["native", "branches"] as const)(
  "preserves real Matrix context exactly once from %s ingress across restart",
  { timeout: 240_000 },
  async (initialMode, context) => {
    let gateway: OpenClawTestInstance | undefined;
    let model: Model | undefined;
    let matrix: Awaited<ReturnType<typeof homeserver>> | undefined;
    let sibling: Operator | undefined;
    const reportFailure = (error: unknown): never => {
      process.stderr.write(
        JSON.stringify({
          fixture: "matrix-context-diagnostics",
          matrixRequests: matrix?.requests.slice(-100),
          matrixErrors: matrix?.errors.slice(-30),
          gateway: gateway?.logs(),
        }) + "\n",
      );
      throw error;
    };
    await runQaGatewayTestFixture(
      context,
      async ({ signal, verifyCleanup }) => {
        model = await startConversationModel(signal);
        matrix = await homeserver(signal);
        const selected = config(model, initialMode);
        if (initialMode === "branches") {
          selected.tools = { allow: ["sessions_list"], codeMode: false, toolSearch: false };
          selected.gateway!.roles!.definitions.provisioner = {
            sessions: { others: "view" },
            agents: "*",
            scopes: [...BRANCH_GATEWAY_SCOPES, "operator.admin"],
          };
          selected.gateway!.auth!.trustedProxy!.deviceAutoApprove!.scopes = [
            ...BRANCH_GATEWAY_SCOPES,
            "operator.admin",
          ];
        }
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
        let personId: string | undefined;
        if (initialMode === "branches") {
          // Native isolated-state bootstrap gives only this synthetic profile
          // administration rights; the actual sibling uses read/write only.
          const person = ensureProfileForEmail(PERSON_EMAIL, { env: gateway.env });
          personId = person.id;
          setUserProfileRole(person.id, "provisioner", { env: gateway.env });
          await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(gateway.env));
        }
        await gateway.startGateway();
        await vi.waitFor(() => expect(matrix!.syncCount).toBeGreaterThan(0), {
          timeout: 30_000,
          interval: 50,
        });
        if (personId) {
          sibling = await connectConversationOperator(gateway, PERSON_EMAIL, signal);
          expect(await sibling.call("users.self", {})).toMatchObject({ profile: { id: personId } });
        }
        const reports = [];
        for (const index of [1, 2, 3, 4]) {
          if (index === 2 && sibling) {
            // The first real Matrix turn predates linking. The same existing
            // branch and remote roster must adopt current native person access.
            const provisioner = await connectConversationOperator(gateway, PERSON_EMAIL, signal, {
              scopes: [...BRANCH_GATEWAY_SCOPES, "operator.admin"],
            });
            try {
              await provisioner.call("users.linkChannelIdentity", {
                profileId: personId,
                identity: { channelId: "matrix", accountId: "default", senderId: HUMAN },
              });
            } finally {
              await provisioner.close();
            }
            const requestCount = model.requests.length;
            const started = performance.now();
            const sourceKey = "agent:main:matrix-linked-sibling";
            const run = await sibling.call<{ runId: string }>("chat.send", {
              sessionKey: sourceKey,
              message: `Remember the exact shared code ${SIBLING_CODE}.`,
              deliver: false,
              idempotencyKey: "matrix-linked-sibling-first",
            });
            expect(
              await sibling.call("agent.wait", { runId: run.runId, timeoutMs: 30_000 }),
            ).toMatchObject({
              status: "ok",
            });
            expect(model.requests).toHaveLength(requestCount + 1);
            // Channel-owned draft rows need the isolated admin observer; this
            // does not grant the sibling broader read or send authority.
            const observer = await connectConversationOperator(gateway, PERSON_EMAIL, signal, {
              scopes: [...BRANCH_GATEWAY_SCOPES, "operator.admin"],
            });
            let recipient: { session: { sessionId: string } | null };
            try {
              recipient = await observer.call("sessions.describe", {
                key: MATRIX_KEY,
              });
            } finally {
              await observer.close();
            }
            expect(recipient.session).not.toBeNull();
            const source = await sibling.call<{ session: { sessionId: string } }>(
              "sessions.describe",
              { key: sourceKey },
            );
            const history = await sibling.call<{
              messages: Array<{
                role: string;
                content: unknown;
                __openclaw?: { transcriptPosition?: { rawSeq?: number } };
              }>;
            }>("chat.history", { sessionKey: sourceKey, limit: 100 });
            const sequence = history.messages.find(
              (message) =>
                message.role === "user" &&
                strings(message.content).join("\n").includes(SIBLING_CODE),
            )?.["__openclaw"]?.transcriptPosition?.rawSeq;
            if (typeof sequence !== "number") {
              throw new Error("Native sibling source sequence is unavailable");
            }
            await waitForConversationTransfer(gateway, signal, {
              recipientId: recipient.session!.sessionId,
              sourceId: source.session.sessionId,
              sequence,
            });
            expect(model.requests).toHaveLength(requestCount + 1);
            console.info(
              JSON.stringify({
                fixture: "matrix-linked-idle-admission",
                elapsedMs: Math.round(performance.now() - started),
              }),
            );
          }
          if (index === 3) {
            if (initialMode === "branches") {
              await vi.waitFor(
                () => expect(preparedFrameOwners(gateway!).size).toBeGreaterThan(0),
                {
                  timeout: 30_000,
                  interval: 50,
                },
              );
            }
            const readyOwners = preparedFrameOwners(gateway);
            const modelRequests = model.requests.length;
            await sibling?.close();
            sibling = undefined;
            await gateway.stopGateway();
            selected.agents!.entries!.main!.conversationMode = "branches";
            await gateway.state.writeConfig(selected);
            const previousSyncs = matrix.syncCount;
            matrix.beginConnection();
            await gateway.startGateway();
            if (personId) {
              sibling = await connectConversationOperator(gateway, PERSON_EMAIL, signal);
            }
            await vi.waitFor(() => expect(matrix!.syncCount).toBeGreaterThan(previousSyncs), {
              timeout: 30_000,
              interval: 50,
            });
            if (initialMode === "branches") {
              // The real account must restore prepared custody before any new
              // user input; a sync connection alone does not prove readiness.
              await vi
                .waitFor(
                  () =>
                    expect(
                      [...preparedFrameOwners(gateway!)].some((pid) => !readyOwners.has(pid)),
                    ).toBe(true),
                  { timeout: 30_000, interval: 50 },
                )
                .catch(async (error: unknown) => {
                  try {
                    await diagnoseMatrixStartupRow(gateway!, signal);
                  } catch {
                    process.stderr.write(
                      JSON.stringify({
                        fixture: "matrix-startup-native-row",
                        status: "read-unavailable",
                      }) + "\n",
                    );
                  }
                  throw error;
                });
              expect(model.requests).toHaveLength(modelRequests);
            }
          }
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
          if (initialMode === "branches" && index >= 2) {
            expect(text.split(SIBLING_CODE)).toHaveLength(2);
          }
          const items = Array.isArray(input.input) ? input.input : [];
          const carriers = items.filter((item) => {
            // Compatible Responses endpoints retain the user-role carrier.
            // Its owned envelope distinguishes it from ordinary Conversation info.
            const message = asOptionalRecord(item);
            if (!message || !["user", "system", "developer"].includes(String(message.role))) {
              return false;
            }
            const projected = (Array.isArray(message.content) ? message.content : [])
              .map(asOptionalRecord)
              .filter((block) => block?.type === "input_text" && typeof block.text === "string")
              .map((block) => block?.text)
              .join("\n");
            return (
              projected.startsWith(`${RUNTIME_CONTEXT_HEADER}\n`) &&
              projected.endsWith(`\n${RUNTIME_CONTEXT_FOOTER}`)
            );
          });
          const runtime = strings(carriers).join("\n");
          const eventTimestamp = formatAgentEnvelopeTimestamp(
            event.timestamp,
            resolveEnvelopeFormatOptions(selected),
          );
          if (!eventTimestamp) {
            throw new Error("Missing native event timestamp projection");
          }
          reports.push({
            index,
            mode: index < 3 ? initialMode : "branches",
            currentCopies: text.split(marker).length - 1,
            currentCopiesInRuntime: runtime.split(marker).length - 1,
            previousCopies: Array.from(
              { length: index - 1 },
              (_, prior) => text.split("CURRENT_MATRIX_FULL_PAYLOAD_" + (prior + 1)).length - 1,
            ),
            currentMessageIdCopies: text.split(event.id).length - 1,
            runtimeBlocks: text.split("OpenClaw runtime context:").length - 1,
            runtimeCarriers: carriers.length,
            runtimeText: runtime,
            markerLocations: items
              .map((value, position) => {
                const item = value as Record<string, unknown>;
                const part = strings(item).join("\n");
                return {
                  position,
                  role: item.role,
                  chars: part.length,
                  currentCopies: part.split(marker).length - 1,
                  priorNativeCopies: part.split("CURRENT_MATRIX_FULL_PAYLOAD_2").length - 1,
                  conversationInfo: part.includes("Conversation info:"),
                  quotedHistory: part.includes("Quoted conversation history"),
                };
              })
              .filter(
                (item) => item.currentCopies || item.priorNativeCopies || item.conversationInfo,
              ),
            currentTimestampInRuntime: runtime.includes(eventTimestamp),
            eventTimestamp,
            providerChars: text.length,
          });
        }
        if (sibling) {
          await playMatrixConversation({
            gateway,
            model,
            sibling,
            matrix,
            signal,
            matrixKey: MATRIX_KEY,
            personEmail: PERSON_EMAIL,
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
          expect(report.runtimeCarriers).toBeGreaterThan(0);
          expect(report.currentTimestampInRuntime).toBe(true);
          expect(report.currentCopies).toBe(1);
          expect(report.currentMessageIdCopies).toBe(1);
          expect(report.currentCopiesInRuntime).toBe(0);
          expect(report.previousCopies).toEqual(Array(report.index - 1).fill(1));
        }
      },
      () => sibling?.close(),
      () => gateway?.cleanup(),
      () => matrix?.stop(),
      () => model?.stop(),
    ).catch(reportFailure);
  },
);
