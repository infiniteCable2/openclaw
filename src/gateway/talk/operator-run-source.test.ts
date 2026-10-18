import { beforeEach, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import type { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import type { GatewayClient, GatewayRequestContext } from "../server-methods/shared-types.js";
import { createTalkOperatorRunSource } from "./operator-run-source.js";

const mocks = vi.hoisted(() => ({
  capture: vi.fn<typeof captureGatewayOperatorRunAuthority>(),
  ambient: vi.fn<() => unknown>(),
}));

// mock-isolation: Exercise source/lifetime forwarding without profiles, SQLite or model admission.
vi.mock("../operator-run-authority.js", () => ({
  captureGatewayOperatorRunAuthority: mocks.capture,
}));
// mock-isolation: A later ambient RPC is deliberately not the original Talk principal.
vi.mock("../../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: mocks.ambient,
}));

type SourceContext = Pick<
  GatewayRequestContext,
  "getRuntimeConfig" | "getCommittedRuntimeConfig" | "resolveGatewayContext"
>;

function sourceFixture(connId: string) {
  const client: GatewayClient = {
    connId,
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      role: "operator",
      scopes: ["operator.read"],
      client: {
        id: GATEWAY_CLIENT_IDS.TEST,
        version: "1",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.TEST,
      },
    },
  };
  const context: SourceContext = { getRuntimeConfig: () => ({}) };
  return { client, context };
}

beforeEach(() => {
  mocks.capture.mockReset().mockResolvedValue(undefined);
  mocks.ambient.mockReset();
});

it("uses the original source after create finishes, not the later ambient RPC or its signal", async () => {
  const original = sourceFixture("original-talk-client");
  const createRequest = new AbortController();
  mocks.ambient.mockReturnValue({ ...original, signal: createRequest.signal });
  const source = createTalkOperatorRunSource(original);
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.ambient).not.toHaveBeenCalled();

  // Setup has returned; its request is over before the first model turn starts.
  createRequest.abort(new Error("create RPC finished"));
  const later = sourceFixture("unrelated-rpc-client");
  mocks.ambient.mockReturnValue({ ...later, signal: new AbortController().signal });
  const first = { assertCurrent: vi.fn(), signal: new AbortController().signal };
  const second = { assertCurrent: vi.fn(), signal: new AbortController().signal };
  await source(first);
  await source(second);

  expect(mocks.capture).toHaveBeenCalledTimes(2);
  for (const [index, invocation] of [first, second].entries()) {
    const call = mocks.capture.mock.calls[index]?.[0];
    expect(call).toEqual({
      client: original.client,
      context: original.context,
      invocationAuthority: invocation,
    });
    expect(call?.client).toBe(original.client);
    expect(call?.context).toBe(original.context);
    expect(call?.invocationAuthority).toBe(invocation);
  }
  expect(first.signal.aborted).toBe(false);
  expect(second.signal.aborted).toBe(false);
  expect(mocks.ambient).not.toHaveBeenCalled();
});

it("does not turn a native non-operator result into authority", async () => {
  mocks.capture.mockResolvedValue(undefined);
  const source = createTalkOperatorRunSource(sourceFixture("non-operator-source"));
  await expect(source({ assertCurrent: () => {} })).resolves.toBeUndefined();
  expect(mocks.capture).toHaveBeenCalledOnce();
});

it.each(["before loading", "during loading"] as const)(
  "does not capture after the run becomes stale %s",
  async (when) => {
    const failure = new Error("Talk run retired");
    let current = when !== "before loading";
    const source = createTalkOperatorRunSource(sourceFixture("retired-talk-client"));
    const capture = source({
      assertCurrent: () => {
        if (!current) {
          throw failure;
        }
      },
    });
    // The runtime import (including its warm-cache promise) is an actual yield.
    current = false;
    await expect(capture).rejects.toBe(failure);
    expect(mocks.capture).not.toHaveBeenCalled();
  },
);

it("preserves native source refusal without falling back to ambient authority", async () => {
  const failure = new Error("Original operator access revoked");
  mocks.capture.mockRejectedValue(failure);
  const source = createTalkOperatorRunSource(sourceFixture("revoked-talk-client"));
  await expect(source({ assertCurrent: () => {} })).rejects.toBe(failure);
  expect(mocks.capture).toHaveBeenCalledOnce();
  expect(mocks.ambient).not.toHaveBeenCalled();
});
