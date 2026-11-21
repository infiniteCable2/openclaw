import { createChannelRuntimeContextRegistry } from "../../plugins/runtime/channel-runtime-contexts.js";
import type { PluginRuntimeChannel } from "../../plugins/runtime/types-channel.js";
import type {
  attachMatrixNodeCarrier,
  MatrixNodeCarrierHostOwner,
  MatrixNodeCarrierOwner,
} from "./matrix-node-carrier.js";

export type AttachMatrixNodeCarrier = (
  owner: MatrixNodeCarrierHostOwner,
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
      const { crossChannelSenderId, ...channelOwner } = owner;
      const attachOwner = (privateRequester?: MatrixNodeCarrierHostOwner["privateRequester"]) =>
        attach({
          ...channelOwner,
          accountId,
          peerKey: `${accountId}:${owner.peerKey}`,
          signal: AbortSignal.any([accountSignal, owner.signal]),
          assertCurrent: () => {
            assertAccount();
            owner.assertCurrent();
          },
          privateRequester,
        });
      if (!crossChannelSenderId) {
        return attachOwner();
      }
      if (!owner.expectedNodeId) {
        throw new Error("Cross-channel access requires a pinned Matrix Node ID");
      }
      return import("../../state/user-channel-identity-operations.js").then(
        async ({ prepareUserChannelIdentityAuthority }) => {
          const authority = await prepareUserChannelIdentityAuthority({
            channelId: "matrix",
            accountId,
            senderId: crossChannelSenderId,
          });
          assertAccount();
          owner.signal.throwIfAborted();
          owner.assertCurrent();
          if (!authority?.isCurrent()) {
            throw new Error("Matrix Node owner has no current verified person profile");
          }
          return attachOwner({
            profileId: authority.linked.profileId,
            isCurrent: authority.isCurrent,
          });
        },
      );
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
