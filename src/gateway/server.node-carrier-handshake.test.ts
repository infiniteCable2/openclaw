import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.js";
import { PROTOCOL_VERSION, type ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import { writeConfigFile } from "../config/io.js";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import { useAuthIdentityFixture } from "./server.auth.identity-fixture.test-support.js";
import {
  withMatrixNodeCarrierRuntime,
  type AttachMatrixNodeCarrier,
} from "./server/matrix-node-carrier-runtime.js";
import { attachMatrixNodeCarrier } from "./server/matrix-node-carrier.js";
import * as wsIngress from "./server/ws-connection.js";
import { installGatewayTestHooks, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const makeIdentityPath = useAuthIdentityFixture();
const maps = ["maps.search", "maps.directions", "maps.navigate"];
const client = { id: "node-host", version: "1.0.0", platform: "android", mode: "node" } as const;

type NativeFrame = {
  type: string;
  event?: string;
  id?: string;
  ok?: boolean;
  payload?: {
    nonce?: string;
    id?: string;
    nodeId?: string;
    command?: string;
    auth?: { method: string; role: string; scopes: string[]; deviceToken?: string };
    tools?: { command: string }[];
  };
};

test("bounds the Matrix carrier's native admission, hello, Maps RPCs and owner lifetime", async () => {
  let options: wsIngress.AttachGatewayWsConnectionHandlerParams | undefined;
  const nativeWsIngress = wsIngress.attachGatewayWsConnectionHandler;
  const capture = vi
    .spyOn(wsIngress, "attachGatewayWsConnectionHandler")
    .mockImplementation((params) => {
      options = params;
      nativeWsIngress(params);
    });
  const identity = loadOrCreateDeviceIdentity({ path: makeIdentityPath("matrix-carrier-node") });
  const active = new Set<ReturnType<typeof attachMatrixNodeCarrier>>();
  let checkpoint = "setup";
  function open(afterClose?: () => void) {
    if (!options) throw new Error("native gateway options unavailable");
    const lifetime = new AbortController();
    const events = new EventEmitter();
    const sent: NativeFrame[] = [];
    const invokeDeadlines = new Map<string, number>();
    const onClose = vi.fn(() => {
      events.emit("retired");
      afterClose?.();
    });
    const link = attachMatrixNodeCarrier(options, {
      peerKey: "fixture-peer",
      signal: lifetime.signal,
      assertCurrent: () => lifetime.signal.throwIfAborted(),
      sendFrame: (json, invoke) => {
        const frame: NativeFrame = JSON.parse(json);
        if (invoke && frame.payload?.id) invokeDeadlines.set(frame.payload.id, invoke.deadlineAtMs);
        sent.push(frame);
        events.emit("frame", frame);
      },
      onClose,
    });
    active.add(link);
    const next = (match: (frame: NativeFrame) => boolean) =>
      new Promise<NativeFrame>((resolve) => {
        const handler = (frame: NativeFrame) => {
          if (match(frame)) {
            events.off("frame", handler);
            resolve(frame);
          }
        };
        events.on("frame", handler);
      });
    const request = (method: string, params: object) => {
      const id = `${method}-${sent.length}`;
      const response = next((frame) => frame.type === "res" && frame.id === id);
      link.receive(JSON.stringify({ type: "req", id, method, params }));
      return response;
    };
    function connect(
      auth: NonNullable<ConnectParams["auth"]>,
      overrides: Partial<ConnectParams> = {},
    ) {
      const nonce = sent[0]?.payload?.nonce;
      if (!nonce) throw new Error("native carrier challenge unavailable");
      const signedAt = Date.now();
      const role = overrides.role ?? "node";
      const scopes = overrides.scopes ?? [];
      const signature = signDevicePayload(
        identity.privateKeyPem,
        buildDeviceAuthPayloadV3({
          deviceId: identity.deviceId,
          clientId: client.id,
          clientMode: client.mode,
          role,
          scopes,
          signedAtMs: signedAt,
          token: auth.bootstrapToken ?? auth.deviceToken ?? auth.token ?? null,
          nonce,
          platform: client.platform,
        }),
      );
      return request("connect", {
        client,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        role,
        scopes,
        commands: maps,
        auth,
        ...overrides,
        device: {
          id: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
          signature,
          signedAt,
          nonce,
        },
      });
    }
    return {
      connect,
      request,
      next,
      lifetime,
      onClose,
      sent,
      invokeDeadlines,
      link,
      retired: () => new Promise<void>((resolve) => events.once("retired", resolve)),
    };
  }

  try {
    // Keep existing command approvals in force, even when the carrier narrows them further.
    await writeConfigFile({ gateway: { nodes: { commands: { allow: maps } } } });
    await withGatewayServer(async () => {
      checkpoint = "owner-close";
      const brokenOwner = open(() => {
        throw new Error("synthetic owner cleanup failure");
      });
      expect(() => brokenOwner.link.close()).not.toThrow();
      expect(brokenOwner.onClose).toHaveBeenCalledOnce();

      checkpoint = "reject-shared";
      const shared = open();
      expect((await shared.connect({ token: "secret" })).ok).toBe(false);
      const bootstrap = await issueDeviceBootstrapToken({
        profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      });
      checkpoint = "reject-scopes";
      expect(
        (await open().connect({ bootstrapToken: bootstrap.token }, { scopes: ["operator.read"] }))
          .ok,
      ).toBe(false);
      checkpoint = "reject-command";
      expect(
        (await open().connect({ bootstrapToken: bootstrap.token }, { commands: ["system.run"] }))
          .ok,
      ).toBe(false);

      checkpoint = "bootstrap";
      const first = open();
      const hello = await first.connect({ bootstrapToken: bootstrap.token });
      expect(hello.ok).toBe(true);
      expect(hello.payload).toMatchObject({
        type: "hello-ok",
        auth: { method: "bootstrap-token", role: "node", scopes: [] },
        features: {
          methods: ["node.invoke.result", "node.pluginTools.update"],
          events: ["node.invoke.request"],
        },
        snapshot: { presence: [], health: {} },
      });
      expect(Object.keys(hello.payload ?? {})).toEqual([
        "type",
        "protocol",
        "server",
        "features",
        "snapshot",
        "auth",
        "policy",
      ]);
      const helloBytes = Buffer.byteLength(JSON.stringify(hello));
      expect(helloBytes).toBeLessThan(12 * 1024);
      process.stdout.write(`carrier-hello-bytes:${helloBytes}\n`);
      const deviceToken = hello.payload?.auth?.deviceToken;
      if (!deviceToken) throw new Error("native device token unavailable");
      first.link.close();

      checkpoint = "reconnect";
      expect((await open().connect({ deviceToken: "invalid-device-credential" })).ok).toBe(false);
      const current = open();
      const reconnected = await current.connect({ deviceToken });
      expect(reconnected.ok).toBe(true);
      expect(reconnected.payload?.auth?.method).toBe("device-token");
      const tools = maps.map((command) => ({
        pluginId: "fixture-maps",
        name: command.replace(".", "_"),
        description: "Synthetic Maps descriptor",
        command,
      }));
      checkpoint = "catalog";
      const updated = await current.request("node.pluginTools.update", { tools });
      expect(updated.ok).toBe(true);
      expect(updated.payload?.tools?.map((tool) => tool.command).sort()).toEqual([...maps].sort());
      expect(
        (
          await current.request("node.invoke.result", {
            id: "outside",
            nodeId: "outside",
            ok: true,
          })
        ).ok,
      ).toBe(false);
      const registry = options?.buildRequestContext().nodeRegistry;
      if (!registry) throw new Error("native node registry unavailable");
      const invoke = (deadlineAtMs = performance.now() + 3_000) =>
        registry.invoke({
          nodeId: identity.deviceId,
          command: "maps.search",
          params: { query: "fixture" },
          timeoutMs: 30_000,
          deadlineAtMs,
        });
      checkpoint = "invoke";
      expect(
        registry.sendEvent(identity.deviceId, "node.invoke.request", { command: "maps.search" }),
      ).toBe(false);
      const transport = registry.get(identity.deviceId)?.client.socket;
      if (!transport?.sendNodeInvoke) throw new Error("native Matrix transport unavailable");
      const sentBeforeExpiredInvoke = current.sent.length;
      const expiredFrame = Buffer.from(
        JSON.stringify({
          type: "event",
          event: "node.invoke.request",
          payload: { command: "maps.search" },
        }),
      );
      expect(() => transport.sendNodeInvoke?.(expiredFrame, performance.now() - 1)).toThrow(
        "Matrix node invoke deadline elapsed",
      );
      expect(current.sent).toHaveLength(sentBeforeExpiredInvoke);
      const dispatched = current.next((frame) => frame.event === "node.invoke.request");
      const nativeDeadline = performance.now() + 3_000;
      const result = invoke(nativeDeadline);
      const frame = await Promise.race([dispatched, result.then(() => undefined)]);
      if (!frame?.payload?.id) throw new Error("native Maps invoke not delivered");
      expect(frame.payload.command).toBe("maps.search");
      expect(current.invokeDeadlines.get(frame.payload.id)).toBe(nativeDeadline);
      expect(nativeDeadline).toBeGreaterThan(performance.now());
      expect(frame.payload).not.toHaveProperty("expires_at_ms");
      expect(frame.payload).not.toHaveProperty("deadlineAtMs");
      expect(
        (
          await current.request("node.invoke.result", {
            id: frame.payload.id,
            nodeId: identity.deviceId,
            ok: true,
            payload: { delivered: true },
          })
        ).ok,
      ).toBe(true);
      expect(await result).toMatchObject({ ok: true, payload: { delivered: true } });

      checkpoint = "revoke";
      const afterDispatch = current.next((frame) => frame.event === "node.invoke.request");
      const pending = invoke();
      const secondFrame = await Promise.race([afterDispatch, pending.then(() => undefined)]);
      if (!secondFrame?.payload?.id) throw new Error("native pending Maps invoke not delivered");
      current.lifetime.abort();
      expect(current.onClose).toHaveBeenCalledOnce();
      current.link.receive(
        JSON.stringify({
          type: "req",
          id: "late",
          method: "node.invoke.result",
          params: { id: secondFrame.payload.id, nodeId: identity.deviceId, ok: true },
        }),
      );
      expect((await pending).ok).toBe(false);
      expect(current.sent.some((frame) => frame.id === "late")).toBe(false);

      checkpoint = "bad-catalog";
      const bad = open();
      expect((await bad.connect({ deviceToken })).ok).toBe(true);
      const closed = bad.retired();
      bad.link.receive(
        JSON.stringify({
          type: "req",
          id: "bad",
          method: "node.pluginTools.update",
          params: { tools: [{ ...tools[0], command: "system.run" }] },
        }),
      );
      await closed;
      expect(bad.sent.some((frame) => frame.id === "bad" && frame.ok)).toBe(false);
      checkpoint = "passed";
    });
  } finally {
    process.stdout.write(`carrier-checkpoint:${checkpoint}\n`);
    for (const link of active) link.close();
    capture.mockRestore();
  }
});

test("keeps the Matrix attachment capability private to its current account runtime", () => {
  const runtime = createPluginRuntime().channel;
  const account = new AbortController();
  const peer = new AbortController();
  const attach = vi.fn<AttachMatrixNodeCarrier>(() => ({ receive() {}, close() {} }));
  const scoped = withMatrixNodeCarrierRuntime({
    runtime,
    accountId: "fixture",
    accountSignal: account.signal,
    assertAccountCurrent() {},
    attach,
  });
  const key = { channelId: "matrix", accountId: "fixture", capability: "matrix.node-carrier" };
  expect(runtime.runtimeContexts.get(key)).toBeUndefined();
  expect(scoped.runtimeContexts.get({ ...key, accountId: "other" })).toBeUndefined();
  expect(scoped.runtimeContexts.get({ ...key, channelId: "telegram" })).toBeUndefined();
  const capability = scoped.runtimeContexts.get<{ attachGateway: AttachMatrixNodeCarrier }>(key);
  if (!capability) throw Error("scoped context unavailable");
  const owner = {
    peerKey: "synthetic",
    signal: peer.signal,
    assertCurrent() {},
    sendFrame() {},
    onClose() {},
  };
  capability.attachGateway(owner);
  expect(attach.mock.calls[0]?.[0].peerKey).toBe("fixture:synthetic");
  account.abort();
  expect(attach.mock.calls[0]?.[0].signal.aborted).toBe(true);
  expect(scoped.runtimeContexts.get(key)).toBeUndefined();
  expect(() => capability.attachGateway(owner)).toThrow();
  expect(attach).toHaveBeenCalledOnce();
});
