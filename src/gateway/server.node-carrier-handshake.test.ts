import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.js";
import { PROTOCOL_VERSION, type ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import * as runState from "../agents/embedded-agent-runner/run-state.js";
import { writeConfigFile } from "../config/io.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  createConversationInputAdmission,
} from "../talk/conversation-input-admission.js";
import {
  bindMatrixConversationInputOrigin,
  retainMatrixConversationRunOrigin,
} from "../talk/matrix-conversation-run-origin.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import { nodeInvokeHandlers } from "./server-methods/nodes.invoke.js";
import { useAuthIdentityFixture } from "./server.auth.identity-fixture.test-support.js";
import {
  withMatrixNodeCarrierRuntime,
  type AttachMatrixNodeCarrier,
} from "./server/matrix-node-carrier-runtime.js";
import {
  attachMatrixNodeCarrier,
  type MatrixNodeCarrierOwner,
} from "./server/matrix-node-carrier.js";
import * as wsIngress from "./server/ws-connection.js";
import { installGatewayTestHooks, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const makeIdentityPath = useAuthIdentityFixture();
const goV2 = "network.device.read.v2";
const goLegacy = "network.device.read";
const goHistory = "network.device.history.v1";
const goStop = "network.device.stop.v1";
const initialToolbox = [
  "maps.search",
  "maps.directions",
  "maps.navigate",
  "maps.navigation_status",
  "location.get",
  goLegacy,
  goV2,
  goHistory,
  goStop,
];
const upgradedToolbox = [
  "android.notifications.read",
  "calendar.event.draft",
  "calendar.events.list",
  "clock.alarm.dismiss",
  "clock.alarm.set",
  "clock.alarm.show",
  "clock.alarm.snooze",
  "clock.timer.dismiss",
  "clock.timer.set",
  "clock.timer.show",
  "device.sensors.read",
  "device.status",
  ...initialToolbox,
  "maps.show",
  "maps.street_view",
  "maps.shortlist",
  "media.item.open",
  "media.playback.next",
  "media.playback.pause",
  "media.playback.play",
  "media.playback.previous",
  "media.playback.status",
  "messages.email.draft",
  "messages.sms.draft",
  "phone.dial",
];
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
    paramsJSON?: string;
    auth?: { method: string; role: string; scopes: string[]; deviceToken?: string };
    tools?: { command: string }[];
  };
};

test("bounds the Matrix carrier's native admission, hello, Toolbox upgrade and owner lifetime", async () => {
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
  const releaseRunOrigins: (() => void)[] = [];
  let checkpoint = "setup";
  const roomId = "!fixture:example.invalid";
  const sessionKey = "agent:main:matrix:group:fixture";
  let activeSessionKey = sessionKey;
  function open(
    overrides: Partial<MatrixNodeCarrierOwner> & {
      privateRequester?: { profileId: string; isCurrent(): boolean };
    } = {},
  ) {
    if (!options) {
      throw new Error("native gateway options unavailable");
    }
    const lifetime = new AbortController();
    const events = new EventEmitter();
    const sent: NativeFrame[] = [];
    const invocations = new Map<
      string,
      NonNullable<Parameters<MatrixNodeCarrierOwner["sendFrame"]>[1]>
    >();
    const onClose = vi.fn(() => {
      events.emit("retired");
      overrides.onClose?.();
    });
    const link = attachMatrixNodeCarrier(options, {
      peerKey: "fixture-peer",
      accountId: "fixture",
      agentId: "main",
      roomId,
      expectedNodeId: identity.deviceId,
      assertInvokeSession(key) {
        if (key !== activeSessionKey) {
          throw new Error("fixture RTC session retired");
        }
      },
      ...overrides,
      signal: lifetime.signal,
      assertCurrent: () => lifetime.signal.throwIfAborted(),
      sendFrame: (json, invoke) => {
        const frame: NativeFrame = JSON.parse(json);
        if (invoke && frame.payload?.id) {
          invocations.set(frame.payload.id, invoke);
        }
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
      connectOverrides: Partial<ConnectParams> = {},
    ) {
      const nonce = sent[0]?.payload?.nonce;
      if (!nonce) {
        throw new Error("native carrier challenge unavailable");
      }
      const signedAt = Date.now();
      const role = connectOverrides.role ?? "node";
      const scopes = connectOverrides.scopes ?? [];
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
        commands: initialToolbox,
        auth,
        ...connectOverrides,
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
      invocations,
      link,
      retired: () =>
        new Promise<void>((resolve) => {
          events.once("retired", resolve);
        }),
    };
  }

  try {
    // Keep existing command approvals in force, even when the carrier narrows them further.
    await writeConfigFile({ gateway: { nodes: { commands: { allow: upgradedToolbox } } } });
    await withGatewayServer(async () => {
      checkpoint = "owner-close";
      const brokenOwner = open({
        onClose() {
          throw new Error("synthetic owner cleanup failure");
        },
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
      for (const command of ["system.run", "notifications.list"]) {
        expect(
          (await open().connect({ bootstrapToken: bootstrap.token }, { commands: [command] })).ok,
        ).toBe(false);
      }

      checkpoint = "bootstrap";
      const first = open({ expectedNodeId: undefined, assertInvokeSession: undefined });
      const hello = await first.connect({ bootstrapToken: bootstrap.token });
      expect(hello.ok).toBe(true);
      expect(hello.payload).toMatchObject({
        type: "hello-ok",
        auth: { method: "bootstrap-token", role: "node", scopes: [] },
        features: { methods: [], events: [] },
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
      const deviceToken = hello.payload?.auth?.deviceToken;
      if (!deviceToken) {
        throw new Error("native device token unavailable");
      }
      const context = options?.buildRequestContext();
      if (!context) {
        throw new Error("native Gateway context unavailable");
      }
      const registry = context.nodeRegistry;
      expect(
        (
          await registry.invoke({
            nodeId: identity.deviceId,
            command: "maps.search",
            isDispatchAuthorized: () => true,
          })
        ).ok,
      ).toBe(false);
      const bootstrapClosed = first.retired();
      first.link.receive(
        JSON.stringify({
          type: "req",
          id: "unpinned-tools",
          method: "node.pluginTools.update",
          params: { tools: [] },
        }),
      );
      await bootstrapClosed;
      expect(first.sent.some((frame) => frame.id === "unpinned-tools" && frame.ok)).toBe(false);

      checkpoint = "reconnect";
      expect((await open({ expectedNodeId: undefined }).connect({ deviceToken })).ok).toBe(false);
      expect((await open({ expectedNodeId: "0".repeat(64) }).connect({ deviceToken })).ok).toBe(
        false,
      );
      expect((await open().connect({ deviceToken: "invalid-device-credential" })).ok).toBe(false);
      const legacy = open();
      expect((await legacy.connect({ deviceToken })).ok).toBe(true);
      expect(registry.get(identity.deviceId)?.commands.toSorted()).toEqual(
        [...initialToolbox].toSorted(),
      );
      legacy.link.close();

      checkpoint = "reconnect-with-upgraded-toolbox";
      const current = open({
        privateRequester: { profileId: "fixture-owner", isCurrent: () => true },
      });
      const reconnected = await current.connect({ deviceToken }, { commands: upgradedToolbox });
      expect(reconnected.ok).toBe(true);
      expect(reconnected.payload?.auth?.method).toBe("device-token");
      expect(reconnected.payload).toMatchObject({
        features: {
          methods: ["node.invoke.result", "node.pluginTools.update"],
          events: ["node.invoke.request"],
        },
      });
      const connectedHelloBytes = Buffer.byteLength(JSON.stringify(reconnected));
      expect(connectedHelloBytes).toBeLessThan(12 * 1024);
      process.stdout.write(`carrier-hello-bytes:${connectedHelloBytes}\n`);
      const tools = upgradedToolbox.map((command) => ({
        pluginId: "fixture-toolbox",
        name: command.replaceAll(".", "_"),
        description: "Synthetic Android Toolbox descriptor",
        command,
      }));
      checkpoint = "catalog";
      const updated = await current.request("node.pluginTools.update", { tools });
      expect(updated.ok).toBe(true);
      expect(updated.payload?.tools?.map((tool) => tool.command).toSorted()).toEqual(
        initialToolbox.filter((command) => ![goV2, goHistory, goStop].includes(command)).toSorted(),
      );
      expect(registry.get(identity.deviceId)?.commands.toSorted()).toEqual(
        [...initialToolbox].toSorted(),
      );
      expect(
        (
          await current.request("node.invoke.result", {
            id: "outside",
            nodeId: "outside",
            ok: true,
          })
        ).ok,
      ).toBe(false);
      checkpoint = "invoke-authority";
      const operationalRunInstance = {
        runId: "fixture-matrix-run",
        instanceId: "fixture-matrix-instance",
      };
      let sourceCurrent = true;
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance, () => {
        if (!sourceCurrent) {
          throw new Error("fixture run retired");
        }
      });
      const runtimeIdentity: AgentRuntimeIdentity = {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey,
        operationalRunInstance,
        delegatedAuthority: { kind: "local", ...authority },
        turnSourceChannel: "matrix",
        turnSourceTo: `room:${roomId}`,
        turnSourceAccountId: "fixture",
      };
      let requestCount = 0;
      const invoke = (
        caller: AgentRuntimeIdentity | null = runtimeIdentity,
        overrides: Record<string, unknown> = {},
        guard?: () => void,
      ) => {
        const respond = vi.fn();
        const requestId = `fixture-matrix-invoke-${++requestCount}`;
        return Promise.resolve(
          nodeInvokeHandlers["node.invoke"]({
            context,
            respond,
            isWebchatConnect: () => false,
            req: { type: "req", id: requestId, method: "node.invoke" },
            client: {
              connect: {
                minProtocol: PROTOCOL_VERSION,
                maxProtocol: PROTOCOL_VERSION,
                client: {
                  id: "gateway-client",
                  version: "fixture",
                  platform: "node",
                  mode: "backend",
                },
                role: "operator",
                scopes: ["operator.write"],
              },
              ...(caller && {
                internal: { agentRuntimeIdentity: caller, ...(guard && { syntheticClient: true }) },
              }),
            },
            params: {
              nodeId: identity.deviceId,
              command: "maps.search",
              params: { query: "fixture" },
              timeoutMs: 3_000,
              idempotencyKey: requestId,
              ...overrides,
            },
            ...(guard && { sessionMutationCommitGuard: guard }),
          }),
        ).then(() => respond.mock.calls[0]);
      };
      const framesBeforeRejectedInvocations = current.sent.length;
      // A live run with the same persisted Matrix chat routing still has no native audio ingress.
      expect((await invoke())?.[0]).toBe(false);
      const sourceAudio = new AbortController();
      const retainOrigin = (instance: AgentRuntimeIdentity["operationalRunInstance"]) => {
        const scope = {
          agentId: "main",
          conversationId: "fixture-call",
          inputId: instance.runId,
          purpose: "user",
        } as const;
        const proof = createConversationInputAdmission({
          scope,
          source: {
            channelId: "matrix",
            accountId: "fixture",
            nativeChannelId: roomId,
            sessionKey,
          },
          assertCurrent() {},
          assertInputCurrent() {},
        });
        const input = consumeConversationInputAdmission(proof, scope);
        claimConversationInputExecution(input);
        const presentation = {};
        bindMatrixConversationInputOrigin(presentation, input);
        const release = retainMatrixConversationRunOrigin(presentation, instance, {
          runId: instance.runId,
          abortSignal: sourceAudio.signal,
          assertCurrent() {},
        });
        if (!release) {
          throw new Error("native RTC fixture origin unavailable");
        }
        releaseRunOrigins.push(release);
      };
      retainOrigin(operationalRunInstance);
      for (const caller of [
        null,
        { ...runtimeIdentity, agentId: "other" },
        { ...runtimeIdentity, sessionKey: "agent:main:matrix:group:other-thread" },
        {
          ...runtimeIdentity,
          operationalRunInstance: { ...operationalRunInstance, instanceId: "unbound-instance" },
        },
      ]) {
        expect(
          (
            await invoke(caller, {
              sessionKey,
              turnSourceTo: `room:${roomId}`,
              turnSourceAccountId: "fixture",
            })
          )?.[0],
        ).toBe(false);
      }
      expect(
        (
          await invoke(runtimeIdentity, { sessionKey: "agent:main:matrix:group:other-thread" })
        )?.[0],
      ).toBe(false);
      expect(
        (
          await registry.invoke({
            nodeId: identity.deviceId,
            command: "maps.search",
            isDispatchAuthorized: () => true,
          })
        ).ok,
      ).toBe(false);
      expect(
        registry.sendEvent(identity.deviceId, "node.invoke.request", { command: "maps.search" }),
      ).toBe(false);
      expect(
        (await invoke(runtimeIdentity, { command: "notifications.list", params: {} }))?.[0],
      ).toBe(false);
      expect(current.sent).toHaveLength(framesBeforeRejectedInvocations);
      const transport = registry.get(identity.deviceId)?.client.socket;
      if (!transport?.sendNodeInvoke) {
        throw new Error("native Matrix transport unavailable");
      }
      const expiredFrame = Buffer.from(
        JSON.stringify({
          type: "event",
          event: "node.invoke.request",
          payload: { nodeId: identity.deviceId, command: "location.get" },
        }),
      );
      const dispatched = current.next((frame) => frame.event === "node.invoke.request");
      const captureInvoke = vi.spyOn(registry, "invoke");
      const result = invoke(runtimeIdentity, { command: "location.get", params: {} });
      const locationFrame = await Promise.race([dispatched, result.then(() => undefined)]);
      if (!locationFrame?.payload?.id) {
        throw new Error("native location invoke not delivered");
      }
      expect(locationFrame.payload.command).toBe("location.get");
      const pendingDispatch = current.invocations.get(locationFrame.payload.id);
      const nativeDeadline = captureInvoke.mock.lastCall?.[0].deadlineAtMs;
      expect(nativeDeadline).toBeGreaterThan(performance.now());
      expect(pendingDispatch?.deadlineAtMs).toBe(nativeDeadline);
      expect(() => pendingDispatch?.assertCurrent()).not.toThrow();
      const sentBeforeExpiredInvoke = current.sent.length;
      const isDispatchAuthorized = captureInvoke.mock.lastCall?.[0].isDispatchAuthorized;
      expect(() =>
        transport.sendNodeInvoke?.(expiredFrame, performance.now() - 1, isDispatchAuthorized),
      ).toThrow("Matrix node invoke deadline elapsed");
      expect(current.sent).toHaveLength(sentBeforeExpiredInvoke);
      expect(locationFrame.payload).not.toHaveProperty("expires_at_ms");
      expect(locationFrame.payload).not.toHaveProperty("deadlineAtMs");
      expect(
        (
          await current.request("node.invoke.result", {
            id: locationFrame.payload.id,
            nodeId: identity.deviceId,
            ok: true,
            payload: { delivered: true },
          })
        ).ok,
      ).toBe(true);
      expect((await result)?.slice(0, 2)).toMatchObject([
        true,
        { ok: true, payload: { delivered: true } },
      ]);

      checkpoint = "bound-device-read";
      for (const params of [
        {},
        { plugin: "other", deviceKey: "012345" },
        { plugin: "go-e", deviceKey: 123456 },
        { plugin: "go-e", deviceKey: "１２３４５６" },
        { plugin: "go-e", deviceKey: "012345\n" },
        { plugin: "go-e", deviceKey: "012345", url: "https://example.invalid" },
      ]) {
        expect((await invoke(runtimeIdentity, { command: goV2, params }))?.[2]).toMatchObject({
          code: "INVALID_REQUEST",
        });
      }
      const target = { plugin: "go-e", deviceKey: "012345" };
      expect(
        (await invoke(runtimeIdentity, { command: goLegacy, params: target }))?.[2],
      ).toMatchObject({ code: "INVALID_REQUEST" });
      expect((await invoke(null, { command: goV2, params: target }))?.[2]).toMatchObject({
        code: "FORBIDDEN",
      });
      expect(current.sent.filter((frame) => frame.event === "node.invoke.request")).toHaveLength(1);
      for (const [command, params, payload] of [
        [goLegacy, {}, { chargingState: "idle" }],
        [goV2, target, { deviceKey: target.deviceKey, chargingState: "idle" }],
      ] as const) {
        const event = current.next((frame) => frame.event === "node.invoke.request");
        const answer = invoke(runtimeIdentity, { command, params });
        const frame = await Promise.race([event, answer.then(() => undefined)]);
        expect(frame?.payload).toMatchObject({ command, paramsJSON: JSON.stringify(params) });
        expect(
          (
            await current.request("node.invoke.result", {
              id: frame?.payload?.id,
              nodeId: identity.deviceId,
              ok: true,
              payload,
            })
          ).ok,
        ).toBe(true);
        expect((await answer)?.slice(0, 2)).toMatchObject([true, { ok: true, payload }]);
      }

      checkpoint = "private-goe-history-and-stop";
      const owner = new PluginInstance("goe");
      const other = new PluginInstance("fixture-other");
      let verified = true;
      let bound = true;
      const guard = () => {
        if (!bound) {
          throw new Error("fixture assignment revoked");
        }
      };
      const captureParticipants = vi.spyOn(
        runState,
        "captureActiveEmbeddedRunPersonalToolParticipants",
      );
      const initialCount = current.sent.filter(
        (frame) => frame.event === "node.invoke.request",
      ).length;
      try {
        captureParticipants.mockReturnValue({
          participants: {
            isPrivateRequesterProfile: (profile: string) => verified && profile === "fixture-owner",
          } as NonNullable<
            NonNullable<
              ReturnType<typeof runState.captureActiveEmbeddedRunPersonalToolParticipants>
            >["participants"]
          >,
          assertCurrent() {},
        });
        for (const [command, params] of [
          [goHistory, { ...target, limit: 0 }],
          [goHistory, { ...target, limit: 21 }],
          [goHistory, { ...target, limit: 1.5 }],
          [goHistory, { ...target, limit: "3" }],
          [goHistory, target],
          [goHistory, { ...target, limit: 1, from: 1000.5 }],
          [goHistory, { ...target, limit: 1, to: "2000" }],
          [goHistory, { ...target, limit: 1, from: 2000, to: 1000 }],
          [goHistory, { ...target, limit: 1, offset: -1 }],
          [goHistory, { ...target, limit: 1, offset: Number.MAX_SAFE_INTEGER + 1 }],
          [goHistory, { ...target, limit: 1, exportUrl: "https://example.invalid" }],
          [goStop, { ...target, limit: 1 }],
          [goStop, { ...target, confirm: true }],
        ] as const) {
          expect((await invoke(runtimeIdentity, { command, params }))?.[2]).toMatchObject({
            code: "INVALID_REQUEST",
          });
        }
        for (const [command, params] of [
          [goHistory, { ...target, limit: 3 }],
          [goStop, target],
        ] as const) {
          const args = { command, params };
          for (const rejected of [
            () => invoke(runtimeIdentity, args, guard),
            () => other.run(() => invoke(runtimeIdentity, args, guard)),
            () => owner.run(() => invoke(runtimeIdentity, args)),
            () => owner.run(() => invoke(null, args, guard)),
          ]) {
            expect((await rejected())?.[2]).toMatchObject({ code: "FORBIDDEN" });
          }
          verified = false;
          expect((await owner.run(() => invoke(runtimeIdentity, args, guard)))?.[2]).toMatchObject({
            code: "FORBIDDEN",
          });
          verified = true;
          bound = false;
          expect((await owner.run(() => invoke(runtimeIdentity, args, guard)))?.[2]).toMatchObject({
            code: "FORBIDDEN",
          });
          bound = true;
        }
        expect(current.sent.filter((frame) => frame.event === "node.invoke.request")).toHaveLength(
          initialCount,
        );
        for (const [command, params, payload] of [
          [goHistory, { ...target, limit: 1 }, { deviceKey: target.deviceKey, sessions: [] }],
          [goHistory, { ...target, limit: 20 }, { deviceKey: target.deviceKey, sessions: [] }],
          [
            goHistory,
            { ...target, limit: 3, from: 1000, to: 2000, offset: 4 },
            { deviceKey: target.deviceKey, sessions: [], hasMore: true },
          ],
          [
            goHistory,
            { ...target, limit: 3, to: 2000, offset: 0 },
            { deviceKey: target.deviceKey, sessions: [] },
          ],
          [goStop, target, { deviceKey: target.deviceKey, stopState: "stopped" }],
        ] as const) {
          const event = current.next((frame) => frame.event === "node.invoke.request");
          const answer = owner.run(() => invoke(runtimeIdentity, { command, params }, guard));
          const frame = await Promise.race([event, answer.then(() => undefined)]);
          expect(frame?.payload).toMatchObject({ command, paramsJSON: JSON.stringify(params) });
          expect(
            (
              await current.request("node.invoke.result", {
                id: frame?.payload?.id,
                nodeId: identity.deviceId,
                ok: true,
                payload,
              })
            ).ok,
          ).toBe(true);
          expect((await answer)?.slice(0, 2)).toMatchObject([true, { ok: true, payload }]);
        }
        const stopFrames = () =>
          current.sent.filter(
            (frame) => frame.event === "node.invoke.request" && frame.payload?.command === goStop,
          ).length;
        const beforeStop = stopFrames();
        const event = current.next((frame) => frame.event === "node.invoke.request");
        const answer = owner.run(() =>
          invoke(runtimeIdentity, { command: goStop, params: target }, guard),
        );
        const stoppedFrame = await Promise.race([event, answer.then(() => undefined)]);
        expect(stoppedFrame?.payload?.command).toBe(goStop);
        expect(
          (
            await current.request("node.invoke.result", {
              id: stoppedFrame?.payload?.id,
              nodeId: identity.deviceId,
              ok: false,
              error: {
                code: "NODE_NOT_READY",
                message: "Synthetic phone unavailable before confirmation",
              },
            })
          ).ok,
        ).toBe(true);
        expect((await answer)?.[2]).toMatchObject({ code: "UNAVAILABLE" });
        expect(stopFrames()).toBe(beforeStop + 1);
      } finally {
        captureParticipants.mockRestore();
        await owner.dispose();
        await other.dispose();
      }

      checkpoint = "revoke-session";
      const dispatchedBeforeSessionRetirement = current.next(
        (requestFrame) => requestFrame.event === "node.invoke.request",
      );
      const retiredSessionResult = invoke(runtimeIdentity, {
        command: "maps.navigation_status",
        params: {},
      });
      const retiredSessionFrame = await Promise.race([
        dispatchedBeforeSessionRetirement,
        retiredSessionResult.then(() => undefined),
      ]);
      if (!retiredSessionFrame?.payload?.id) {
        throw new Error("fixture retirement invoke missing");
      }
      expect(retiredSessionFrame.payload.command).toBe("maps.navigation_status");
      activeSessionKey = "agent:main:matrix:group:another-rtc";
      expect(() => pendingDispatch?.assertCurrent()).toThrow("Matrix node invoke authority closed");
      expect((await invoke())?.[0]).toBe(false);
      await current.request("node.invoke.result", {
        id: retiredSessionFrame.payload.id,
        nodeId: identity.deviceId,
        ok: true,
        payload: { stale: true },
      });
      expect((await retiredSessionResult)?.[0]).toBe(false);
      activeSessionKey = sessionKey;

      checkpoint = "revoke-run";
      sourceCurrent = false;
      expect(() => pendingDispatch?.assertCurrent()).toThrow("Matrix node invoke authority closed");
      expect((await invoke())?.[0]).toBe(false);
      releaseAgentRunDelegatedAuthority(authority);
      const successorRun = {
        runId: "fixture-successor-run",
        instanceId: "fixture-successor-instance",
      };
      const successorAuthority = claimAgentRunDelegatedAuthority(successorRun);
      retainOrigin(successorRun);
      try {
        checkpoint = "revoke";
        const afterDispatch = current.next(
          (nextFrame) => nextFrame.event === "node.invoke.request",
        );
        const pending = invoke({
          ...runtimeIdentity,
          operationalRunInstance: successorRun,
          delegatedAuthority: { kind: "local", ...successorAuthority },
        });
        const secondFrame = await Promise.race([afterDispatch, pending.then(() => undefined)]);
        if (!secondFrame?.payload?.id) {
          throw new Error("native pending Maps invoke not delivered");
        }
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
        expect((await pending)?.[0]).toBe(false);
        expect(current.sent.some((responseFrame) => responseFrame.id === "late")).toBe(false);
      } finally {
        releaseAgentRunDelegatedAuthority(successorAuthority);
        captureInvoke.mockRestore();
      }

      checkpoint = "bad-catalog";
      const bad = open();
      expect((await bad.connect({ deviceToken })).ok).toBe(true);
      const closed = bad.retired();
      bad.link.receive(
        JSON.stringify({
          type: "req",
          id: "bad",
          method: "node.pluginTools.update",
          params: { tools: [{ ...tools[0], command: "notifications.list" }] },
        }),
      );
      await closed;
      expect(bad.sent.some((responseFrame) => responseFrame.id === "bad" && responseFrame.ok)).toBe(
        false,
      );
      checkpoint = "passed";
    });
  } finally {
    process.stdout.write(`carrier-checkpoint:${checkpoint}\n`);
    for (const link of active) {
      link.close();
    }
    for (const release of releaseRunOrigins) {
      release();
    }
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
  const capability = scoped.runtimeContexts.get<{
    attachGateway: (owner: MatrixNodeCarrierOwner) => unknown;
  }>(key);
  if (!capability) {
    throw new Error("scoped context unavailable");
  }
  const owner = {
    peerKey: "synthetic",
    agentId: "main",
    roomId: "!fixture:example.invalid",
    signal: peer.signal,
    assertCurrent() {},
    sendFrame() {},
    onClose() {},
  };
  capability.attachGateway(owner);
  expect(attach.mock.calls[0]?.[0]).toMatchObject({
    peerKey: "fixture:synthetic",
    accountId: "fixture",
  });
  account.abort();
  expect(attach.mock.calls[0]?.[0].signal.aborted).toBe(true);
  expect(scoped.runtimeContexts.get(key)).toBeUndefined();
  expect(() => capability.attachGateway(owner)).toThrow();
  expect(attach).toHaveBeenCalledOnce();
});
