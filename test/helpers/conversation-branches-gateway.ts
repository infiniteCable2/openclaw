import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocket } from "ws";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.js";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.js";
import type { ResponseFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../../src/infra/device-identity.js";
import { acquireTestPortBlock } from "../../src/test-utils/port-claims.js";
import { VERSION } from "../../src/version.js";
import { acquireGatewayTestWebSocket, closeGatewayTestWebSocket } from "./gateway-websocket.js";
import { writeOpenAiResponsesText } from "./openai-responses-sse.js";
import type { OpenClawTestInstance } from "./openclaw-test-instance.js";
import { createDeferred } from "./promise.js";

export const BRANCH_GATEWAY_ORIGIN = "https://conversation.example.test";
export const BRANCH_GATEWAY_SCOPES = ["operator.read", "operator.write"];

/** Real provider transport; only the model itself is deterministic. No OpenClaw hooks are replaced. */
export async function startConversationModel(
  signal: AbortSignal,
  respond: (request: Record<string, unknown>, index: number) => string = (_request, index) =>
    `FIXTURE_REPLY_${index}`,
) {
  const claim = await acquireTestPortBlock({ offsets: [0], signal });
  const requests: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  const gates = new Set<{
    matches: (request: Record<string, unknown>) => boolean;
    entered: ReturnType<typeof createDeferred<Record<string, unknown>>>;
    released: ReturnType<typeof createDeferred<void>>;
    claimed: boolean;
  }>();
  const releaseGates = () => {
    for (const gate of gates) {
      gate.released.resolve();
    }
  };
  signal.addEventListener("abort", releaseGates, { once: true });
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        throw new Error(`Unexpected provider route: ${request.method} ${request.url}`);
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > 2 * 1024 * 1024) {
          throw new Error("Synthetic provider prompt unexpectedly exceeded 2 MiB");
        }
        chunks.push(data);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(input);
      const index = requests.length;
      const gate = [...gates].find((entry) => !entry.claimed && entry.matches(input));
      if (gate) {
        gate.claimed = true;
        gate.entered.resolve(input);
        await gate.released.promise;
        gates.delete(gate);
      }
      signal.throwIfAborted();
      writeOpenAiResponsesText(response, {
        text: respond(input, index),
        messageId: `msg_branch_${index}`,
        responseId: `resp_branch_${index}`,
      });
    })().catch((error: unknown) => {
      errors.push(error);
      response.writeHead(500).end("Synthetic provider failure");
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(claim.port, "127.0.0.1", resolve);
    });
  } catch (error) {
    signal.removeEventListener("abort", releaseGates);
    await claim.release();
    throw error;
  }
  return {
    baseUrl: `http://127.0.0.1:${claim.port}/v1`,
    requests,
    errors,
    holdNext(matches: (request: Record<string, unknown>) => boolean) {
      const gate = {
        matches,
        entered: createDeferred<Record<string, unknown>>(),
        released: createDeferred<void>(),
        claimed: false,
      };
      gates.add(gate);
      return { entered: gate.entered.promise, release: () => gate.released.resolve() };
    },
    async stop() {
      signal.removeEventListener("abort", releaseGates);
      releaseGates();
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } finally {
        await claim.release();
      }
    },
  };
}

/** Ordinary trusted-proxy login and signed device pairing, entirely inside the isolated fixture. */
export async function connectConversationOperator(
  gateway: OpenClawTestInstance,
  email: string,
  signal: AbortSignal,
) {
  const identity = loadOrCreateDeviceIdentity({
    path: gateway.state.statePath("conversation-test-devices", `${email}.sqlite`),
  });
  const socket = new WebSocket(gateway.url, {
    headers: {
      origin: BRANCH_GATEWAY_ORIGIN,
      "x-forwarded-user": email,
      "x-forwarded-proto": "https",
      "x-forwarded-for": "198.51.100.40",
    },
  });
  const challenge = createDeferred<string>();
  void challenge.promise.catch(() => {});
  const pending = new Map<string, ReturnType<typeof createDeferred<ResponseFrame>>>();
  const fail = (error: Error) => {
    challenge.reject(error);
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };
  const abort = () => fail(new Error("Conversation fixture canceled"));
  signal.addEventListener("abort", abort, { once: true });
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Conversation fixture connection closed")));
  socket.on("message", (data) => {
    try {
      const frame = JSON.parse(rawDataToString(data)) as
        | ResponseFrame
        | { type: "event"; event: string; payload?: { nonce?: string } };
      if (frame.type === "event" && frame.event === "connect.challenge" && frame.payload?.nonce) {
        challenge.resolve(frame.payload.nonce);
      } else if (frame.type === "res") {
        pending.get(frame.id)?.resolve(frame);
        pending.delete(frame.id);
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const call = async <T = unknown>(
    method: string,
    params: unknown,
    options?: { timeoutMs: number },
  ): Promise<T> => {
    signal.throwIfAborted();
    const id = randomUUID();
    const result = createDeferred<ResponseFrame>();
    pending.set(id, result);
    const timer = setTimeout(
      () => result.reject(new Error(`${method}: fixture RPC timeout`)),
      options?.timeoutMs ?? 30_000,
    );
    try {
      socket.send(JSON.stringify({ type: "req", id, method, params }));
      const frame = await result.promise;
      if (!frame.ok) {
        throw new Error(`${method}: ${JSON.stringify(frame.error)}`);
      }
      return frame.payload as T;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
  const close = async () => {
    signal.removeEventListener("abort", abort);
    await closeGatewayTestWebSocket(socket);
  };
  try {
    await acquireGatewayTestWebSocket(socket, 30_000, async () => {
      const nonce = await challenge.promise;
      const signedAt = Date.now();
      const client = {
        id: "openclaw-control-ui",
        version: VERSION,
        platform: "web",
        mode: "webchat",
      };
      const payload = buildDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        platform: client.platform,
        role: "operator",
        scopes: BRANCH_GATEWAY_SCOPES,
        token: null,
        nonce,
        signedAtMs: signedAt,
      });
      await call("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role: "operator",
        scopes: BRANCH_GATEWAY_SCOPES,
        device: {
          id: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
          signature: signDevicePayload(identity.privateKeyPem, payload),
          signedAt,
          nonce,
        },
      });
    });
    return { call, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Remove inherited provider/auth/SSH configuration, rather than relying only on model selection. */
export function isolateConversationGatewayEnvironment(gateway: OpenClawTestInstance) {
  const allowed = new Set([
    ...Object.keys(gateway.state.envVars),
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
    "PATHEXT",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "VITEST",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_SKIP_CHANNELS",
    "OPENCLAW_SKIP_GMAIL_WATCHER",
    "OPENCLAW_SKIP_CRON",
    "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
    "OPENCLAW_SKIP_CANVAS_HOST",
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
    "OPENCLAW_AGENT_HARNESS_FALLBACK",
    "OPENCLAW_LOG_LEVEL",
  ]);
  for (const key of Object.keys(gateway.env)) {
    if (!allowed.has(key)) {
      delete gateway.env[key];
    }
  }
  gateway.env.HOME = gateway.homeDir;
  gateway.env.USERPROFILE = gateway.homeDir;
  gateway.env.CODEX_HOME = path.join(gateway.homeDir, "empty-codex-home");
}
