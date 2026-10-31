import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  createMatrixRtcConversationInputSource,
  matrixRtcRouting,
} from "../../../extensions/matrix/test-api.js";
import { withinTest } from "../../../test/helpers/promise.js";
import {
  acquirePreparedConversationKnowledgeInitialFrame,
  registerConversationKnowledgeCheckpointOwner,
} from "../../auto-reply/reply/conversation-knowledge-checkpoint-owner.js";
import * as checkpointSources from "../../auto-reply/reply/conversation-knowledge-checkpoint-source.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import * as configCloning from "../../config/resolution-facts.js";
import { captureRuntimeConfigWithSource } from "../../config/runtime-config-capture-state.js";
import { CONVERSATION_KNOWLEDGE_CONTEXT } from "../../config/sessions/conversation-knowledge-packets.js";
import { recordConversationKnowledgeTurn } from "../../config/sessions/conversation-knowledge-store.js";
import { loadSessionEntry, loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import * as initialFrames from "../../config/sessions/session-initial-context-frame.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withRegisteredChannelIngress } from "../../plugin-sdk/test-helpers/registered-channel-ingress.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { resolveAgentSpeechConversationRoute } from "../../routing/conversation-mode.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import "../../test-utils/prepare-compiled-subprocesses.js";
import type { ChannelPlugin } from "../plugins/types.plugin.js";

const roomId = "!native-call:example.test";
const replayReceipts = Number(process.env.OPENCLAW_RTC_NATIVE_REPLAY_RECEIPTS ?? 20);
// The explicit 500-receipt benchmark includes real source publication and
// off-turn frame preparation. Ordinary CI retains its existing 30-second bound.
const replayTimeoutMs = replayReceipts === 500 ? 120_000 : 30_000;
const plugin: ChannelPlugin = {
  id: "matrix",
  meta: {
    id: "matrix",
    label: "Native RTC fixture",
    selectionLabel: "Native RTC fixture",
    docsPath: "/channels/matrix",
    blurb: "Registered RTC boundary fixture",
  },
  capabilities: { chatTypes: ["direct"] },
  config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
};

// Actual adapter, host ingress, SQLite workers, creation and root-frame issuer.
// No provider, SDK network client, user turn, or connection initializer is mocked.
it(
  "measures actual Matrix connection guards across cold and prepared multi-source creation",
  async ({ signal }) => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "native-rtc-creation" },
      async (state) => {
        const fixture = await createConversationKnowledgeScenario(state);
        const requested = replayReceipts;
        if (requested !== 20 && requested !== 500) {
          throw new Error(
            "RTC native fixture supports only the bounded 20 or optional 500 receipt size",
          );
        }
        const counts = {
          config: 0,
          clone: 0,
          route: 0,
          routeSelection: 0,
          routeInclusiveMs: 0,
          sources: 0,
          frame: 0,
        };
        const measurements: Array<Record<string, number | string>> = [];
        const spies: { mockRestore(): void }[] = [];
        let registration:
          | ReturnType<typeof registerConversationKnowledgeCheckpointOwner>
          | undefined;
        let borrowed: ReturnType<typeof acquirePreparedConversationKnowledgeInitialFrame>;
        let resume: (() => void) | undefined;
        let live = true;
        let privateLive = true;
        let revokeAfterBorrow = false;
        try {
          const cfg: OpenClawConfig = {
            agents: {
              defaults: { workspace: state.workspaceDir },
              entries: { main: { conversationMode: "branches" } },
            },
            bindings: [{ agentId: "main", match: { channel: "matrix" } }],
            session: { store: fixture.root.storePath, dmScope: "per-channel-peer" },
            channels: {
              matrix: {
                enabled: true,
                accounts: { default: {} },
                dm: { enabled: true, policy: "allowlist", allowFrom: [person.id] },
                rtc: {
                  enabled: true,
                  authServiceUrl: "https://rtc.example.test",
                  mediaBridgeCommand: path.resolve("unused-native-rtc-bridge"),
                  transcriptionProvider: "unused-native-stt",
                  admissions: [{ roomId, userId: person.id, agentId: "main" }],
                },
              },
            },
          };
          await state.writeConfig(cfg);
          const donors = await Promise.all(
            ["first", "second", "third"].map((name) => fixture.branch(`rtc-${name}`)),
          );
          const owners = await Promise.all(donors.map((donor) => fixture.claim(donor)));
          for (let index = 0; index < requested; index++) {
            const donorIndex = index % donors.length;
            const terminal = await fixture.append(donors[donorIndex]!, `rtc-original-${index}`);
            expect(
              await recordConversationKnowledgeTurn({
                ...owners[donorIndex]!,
                ...terminal,
                privateAudience: { participant: person, admission: terminal.admission! },
              }),
            ).toBe(true);
          }
          const nativeClone = configCloning.cloneRuntimeConfigSnapshot;
          const nativeSources = checkpointSources.prepareConversationKnowledgeCheckpointSources;
          const nativeBorrow = initialFrames.borrowPreparedConversationKnowledgeInitialFrame;
          const nativeRoute = matrixRtcRouting.resolveMatrixInboundRoute;
          spies.push(
            vi.spyOn(matrixRtcRouting, "resolveMatrixInboundRoute").mockImplementation((input) => {
              counts.routeSelection++;
              const start = performance.now();
              try {
                return nativeRoute(input);
              } finally {
                counts.routeInclusiveMs += performance.now() - start;
              }
            }),
            vi.spyOn(configCloning, "cloneRuntimeConfigSnapshot").mockImplementation((input) => {
              counts.clone++;
              return nativeClone(input);
            }),
            vi
              .spyOn(checkpointSources, "prepareConversationKnowledgeCheckpointSources")
              .mockImplementation((input) => {
                counts.sources++;
                return nativeSources(input);
              }),
            vi
              .spyOn(initialFrames, "borrowPreparedConversationKnowledgeInitialFrame")
              .mockImplementation(async (input) => {
                counts.frame++;
                const value = await nativeBorrow(input);
                if (revokeAfterBorrow) {
                  privateLive = false;
                }
                return value;
              }),
          );
          await withRegisteredChannelIngress(
            { plugin, config: captureRuntimeConfigWithSource(cfg, cfg), setRuntime() {} },
            async (native) => {
              const route = native.channel.routing.resolveAgentRoute;
              const runtime: PluginRuntime = {
                ...native,
                config: {
                  ...native.config,
                  current: () => {
                    counts.config++;
                    return capture;
                  },
                },
                channel: {
                  ...native.channel,
                  routing: {
                    ...native.channel.routing,
                    resolveAgentRoute: (input) => {
                      counts.route++;
                      return route(input);
                    },
                  },
                },
              };
              const capture = captureRuntimeConfigWithSource(cfg, cfg);
              const sourceSessionKey = route({
                cfg: capture,
                channel: "matrix",
                accountId: "default",
                peer: { kind: "direct", id: person.id },
                parentPeer: { kind: "channel", id: roomId },
              }).sessionKey;
              const create = (conversationId: string) => {
                const dispatchSessionKey = resolveAgentSpeechConversationRoute({
                  cfg: capture,
                  agentId: "main",
                  channel: "matrix",
                  accountId: "default",
                  sourceSessionKey,
                  conversationId,
                }).sessionKey;
                const source = createMatrixRtcConversationInputSource({
                  runtime,
                  runtimeEnv: { log() {}, error() {}, exit: vi.fn() },
                  accountId: "default",
                  roomId,
                  agentId: "main",
                  conversationId,
                  sourceSessionKey,
                  dispatchSessionKey,
                  remoteMembership: {
                    userId: person.id,
                    deviceId: "NATIVEDEVICE",
                    memberId: "native-membership",
                    rtcBackendIdentity: "native-backend",
                  },
                  preparePrivateAudience: async () => ({
                    assertCurrent() {
                      if (!privateLive) {
                        throw new Error("Original native room proof revoked");
                      }
                    },
                  }),
                  assertCurrent() {
                    signal.throwIfAborted();
                    if (!live) {
                      throw new Error("Original native call ended");
                    }
                  },
                  signal,
                });
                return { source, target: { ...fixture.root, sessionKey: dispatchSessionKey } };
              };
              const measure = async (phase: string, connection: ReturnType<typeof create>) => {
                const before = { ...counts };
                const start = performance.now();
                await withinTest(connection.source.prepareConnection!({ signal }), signal);
                const entry = loadSessionEntry(connection.target);
                if (!entry?.sessionId) {
                  throw new Error("Actual RTC initializer did not create its native target");
                }
                const events = await loadTranscriptEvents({
                  ...connection.target,
                  sessionId: entry.sessionId,
                });
                const packets = events.filter(
                  (event) => event.customType === CONVERSATION_KNOWLEDGE_CONTEXT,
                );
                expect(packets).toHaveLength(requested);
                measurements.push({
                  phase,
                  elapsedMs: Math.round(performance.now() - start),
                  configCalls: counts.config - before.config,
                  configClones: counts.clone - before.clone,
                  routeCalls: counts.route - before.route,
                  routeSelections: counts.routeSelection - before.routeSelection,
                  routeInclusiveMs: Math.round(counts.routeInclusiveMs - before.routeInclusiveMs),
                  sourcePreparations: counts.sources - before.sources,
                  frameBorrows: counts.frame - before.frame,
                  packets: packets.length,
                });
              };
              if (requested === 20) {
                const cold = create("native-cold");
                expect(loadSessionEntry(cold.target)).toBeUndefined();
                await measure("cold", cold);
                expect(measurements.at(-1)?.frameBorrows).toBe(0);
                expect(measurements.at(-1)?.sourcePreparations).toBeGreaterThan(0);
              } else {
                measurements.push({
                  phase: "cold-skipped-for-prepared-scaling",
                  packets: requested,
                });
              }

              const broker = donors[0]!;
              const entry = loadSessionEntry(broker)!;
              const topology = entry.conversationTopology;
              if (topology?.role !== "branch") {
                throw new Error("Expected the actual native private broker");
              }
              const branch = {
                ...broker,
                root: {
                  sessionKey: topology.rootSessionKey,
                  sessionId: topology.rootSessionId,
                  lifecycleRevision: topology.rootSessionLifecycleRevision,
                },
              };
              const ready = createDeferredCore();
              const acceptFrame = () => {
                if (
                  !registration ||
                  borrowed ||
                  registration.projection().tail.length !== requested
                ) {
                  return;
                }
                borrowed = acquirePreparedConversationKnowledgeInitialFrame({
                  branch,
                  participant: person,
                });
                if (borrowed) {
                  resume = registration.pausePreparation();
                  ready.resolve();
                }
              };
              registration = registerConversationKnowledgeCheckpointOwner({
                branch,
                participant: person,
                env: state.env,
                getRuntimeConfig: () => capture,
                audience: {
                  agentId: broker.agentId,
                  sessionKey: broker.sessionKey,
                  channelId: "matrix",
                  accountId: "default",
                  nativeChannelId: "native-root-broker",
                  participant: person,
                  assertCurrent: owners[0]!.assertCurrent,
                },
                onReady: acceptFrame,
              });
              acceptFrame();
              await withinTest(ready.promise, signal);
              const warm = create("native-warm");
              expect(loadSessionEntry(warm.target)).toBeUndefined();
              await measure("prepared-frame", warm);
              expect(measurements.at(-1)?.frameBorrows).toBe(1);

              // Revoke the actual room proof after native borrowing yields. Neither
              // a cached frame nor expensive guards may turn it into a committed row.
              const refused = create("native-revoked");
              revokeAfterBorrow = true;
              await expect(refused.source.prepareConnection!({ signal })).rejects.toThrow(
                "revoked",
              );
              expect(loadSessionEntry(refused.target)).toBeUndefined();
              live = false;
              await expect(warm.source.prepareConnection!({ signal })).rejects.toThrow();
              expect((await fixture.receipts()).length).toBe(requested);
            },
          );
        } finally {
          console.log(
            JSON.stringify({ scenario: "native-rtc-creation", receipts: requested, measurements }),
          );
          live = false;
          privateLive = false;
          await borrowed?.release();
          await registration?.close();
          resume?.();
          for (const spy of spies.toReversed()) {
            spy.mockRestore();
          }
          await fixture.close();
        }
      },
    );
  },
  replayTimeoutMs,
);
