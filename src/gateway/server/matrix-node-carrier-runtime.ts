import { createChannelRuntimeContextRegistry } from "../../plugins/runtime/channel-runtime-contexts.js";
import type { PluginRuntimeChannel } from "../../plugins/runtime/types-channel.js";
import type { attachMatrixNodeCarrier, MatrixNodeCarrierOwner } from "./matrix-node-carrier.js";

export type AttachMatrixNodeCarrier = (
  owner: MatrixNodeCarrierOwner & { accountId: string },
) => ReturnType<typeof attachMatrixNodeCarrier>;

export function withMatrixNodeCarrierRuntime(params: {
  runtime: PluginRuntimeChannel;
  accountId: string;
  accountSignal: AbortSignal;
  assertAccountCurrent: () => void;
  attach: AttachMatrixNodeCarrier;
}): PluginRuntimeChannel {
  const { runtime, accountId, accountSignal, assertAccountCurrent, attach } = params;
  const assertAccount = () => {
    accountSignal.throwIfAborted();
    assertAccountCurrent();
  };
  const capability = "matrix.node-carrier";
  const context = {
    attachGateway(owner: MatrixNodeCarrierOwner) {
      assertAccount();
      return attach({
        ...owner,
        accountId,
        peerKey: `${accountId}:${owner.peerKey}`,
        signal: AbortSignal.any([accountSignal, owner.signal]),
        assertCurrent: () => {
          assertAccount();
          owner.assertCurrent();
        },
      });
    },
  };
  // This capability belongs to this Account start context. Registration in the
  // shared registry would let other plugin runtimes look it up by channel ID.
  const privateContexts = createChannelRuntimeContextRegistry();
  privateContexts.register({
    channelId: "matrix",
    accountId,
    capability,
    context,
    abortSignal: accountSignal,
  });
  return {
    ...runtime,
    runtimeContexts: {
      ...runtime.runtimeContexts,
      get: (key) =>
        key.capability === capability ? privateContexts.get(key) : runtime.runtimeContexts.get(key),
    },
  };
}
