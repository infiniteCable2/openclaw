import { describe, expect, it, vi } from "vitest";
import { createChannelRuntimeContextRegistry } from "../../plugins/runtime/channel-runtime-contexts.js";
import type { PluginRuntimeChannel } from "../../plugins/runtime/types-channel.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import {
  assertMatrixNodeCarrierDispatch,
  captureMatrixNodeCarrierDispatch,
  restrictMatrixNodeCarrierDispatch,
  type MatrixNodeCarrierBinding,
} from "./matrix-node-carrier-authority.js";
import {
  withMatrixNodeCarrierRuntime,
  type AttachMatrixNodeCarrier,
} from "./matrix-node-carrier-runtime.js";
import type { MatrixNodeCarrierOwner } from "./matrix-node-carrier.js";

const resolveProfile = vi.hoisted(() => vi.fn());

vi.mock("../../state/user-channel-identity-operations.js", () => ({
  prepareUserChannelIdentityAuthority: resolveProfile,
}));

describe("Matrix Node access outside an Assistant Voice call", () => {
  it("prepares the owner in the exact Matrix account before attaching a shared link", async () => {
    const account = new AbortController();
    let ownerCurrent = true;
    const attach = vi.fn<AttachMatrixNodeCarrier>(() => ({
      assertCurrent: () => {},
      receive: () => {},
      close: () => {},
    }));
    const runtime = withMatrixNodeCarrierRuntime({
      runtime: { runtimeContexts: createChannelRuntimeContextRegistry() } as PluginRuntimeChannel,
      accountId: "secondary",
      accountSignal: account.signal,
      assertAccountCurrent: () => {},
      attach,
    });
    const channel = runtime.runtimeContexts.get<{
      attachGateway(owner: MatrixNodeCarrierOwner): unknown;
    }>({ channelId: "matrix", accountId: "secondary", capability: "matrix.node-carrier" });
    expect(channel).toBeDefined();
    const owner: MatrixNodeCarrierOwner = {
      agentId: "example",
      roomId: "!room:example.org",
      peerKey: "peer",
      expectedNodeId: "a".repeat(64),
      signal: new AbortController().signal,
      assertCurrent: () => {},
      assertInvokeSession: () => {},
      sendFrame: () => {},
      onClose: () => {},
    };
    channel?.attachGateway(owner);
    expect(resolveProfile).not.toHaveBeenCalled();
    const requestedOwner = { ...owner, crossChannelSenderId: "@owner:example.org" };
    resolveProfile.mockResolvedValueOnce(undefined);
    await expect(channel?.attachGateway(requestedOwner)).rejects.toThrow("no current verified");
    expect(attach).toHaveBeenCalledTimes(1);
    resolveProfile.mockResolvedValueOnce({
      linked: { profileId: "owner" },
      isCurrent: () => ownerCurrent,
    });
    await channel?.attachGateway(requestedOwner);
    expect(resolveProfile).toHaveBeenLastCalledWith({
      channelId: "matrix",
      accountId: "secondary",
      senderId: "@owner:example.org",
    });
    expect(attach).toHaveBeenCalledTimes(2);
    const requester = attach.mock.lastCall?.[0].privateRequester;
    expect(requester?.profileId).toBe("owner");
    expect(requester?.isCurrent()).toBe(true);
    ownerCurrent = false;
    expect(requester?.isCurrent()).toBe(false);
    account.abort();
  });

  it("requires the opted-in live Node and a current, exact private requester", () => {
    let profileId: string | undefined = "owner";
    let live = true;
    let requestCurrent = true;
    const operationalRunInstance = { instanceId: "instance", runId: "run" };
    const identity: AgentRuntimeIdentity = {
      kind: "agentRuntime",
      agentId: "example",
      sessionKey: "session",
      operationalRunInstance,
      delegatedAuthority: {
        kind: "local",
        operationalRunInstance,
        lifecycleGeneration: "generation",
        claimId: "claim",
      },
    };
    const binding: MatrixNodeCarrierBinding = {
      agentId: identity.agentId,
      roomId: "!room:example.org",
      accountId: "default",
      expectedNodeId: "node",
      privateRequesterProfileId: "owner",
      isCurrent: () => live,
    };
    const attempt = {
      binding,
      identity,
      validate: () => true,
      nodeId: "node",
      command: "maps.search",
      isPrivateRequesterProfile: (requested: string) => requested === profileId,
      isRequestCurrent: () => requestCurrent,
    };
    const capture = (overrides: Partial<typeof attempt> = {}) =>
      captureMatrixNodeCarrierDispatch({ ...attempt, ...overrides });

    expect(
      capture({ binding: { ...binding, privateRequesterProfileId: undefined } }),
    ).toBeUndefined();
    expect(capture({ isPrivateRequesterProfile: () => false })).toBeUndefined();
    expect(capture({ identity: { ...identity, agentId: "another-agent" } })).toBeUndefined();
    expect(capture({ nodeId: "another-node" })).toBeUndefined();
    expect(
      captureMatrixNodeCarrierDispatch({ ...attempt, sessionKey: "another-session" }),
    ).toBeUndefined();
    expect(capture({ validate: () => false })).toBeUndefined();

    const guard = capture();
    expect(guard).toBeDefined();
    expect(() =>
      assertMatrixNodeCarrierDispatch(binding, "node", attempt.command, guard),
    ).not.toThrow();
    expect(() => assertMatrixNodeCarrierDispatch(binding, "node", "maps.navigate", guard)).toThrow(
      "authority closed",
    );
    let pluginAllows = true;
    const narrowed = restrictMatrixNodeCarrierDispatch(guard!, () => pluginAllows);
    expect(() =>
      assertMatrixNodeCarrierDispatch(binding, "node", attempt.command, narrowed),
    ).not.toThrow();
    pluginAllows = false;
    expect(narrowed()).toBe(false);
    pluginAllows = true;
    profileId = undefined;
    expect(guard?.()).toBe(false);
    expect(narrowed()).toBe(false);
    expect(capture()).toBeUndefined();
    profileId = "owner";
    requestCurrent = false;
    expect(guard?.()).toBe(false);
    requestCurrent = true;
    live = false;
    expect(guard?.()).toBe(false);
    expect(capture()).toBeUndefined();
  });
});
