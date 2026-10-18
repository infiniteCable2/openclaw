import { expect, it } from "vitest";
import { getCommandOwnerAuthority } from "../../auto-reply/command-owner-authority.js";
import { getRequesterProfile } from "../../auto-reply/requester-profile.js";
import { unlinkUserChannelIdentity } from "../../state/user-channel-identities.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  prepareConversationReplyContext,
} from "../../talk/conversation-input-admission.js";
import type { ConversationInputScopeV1 } from "../../talk/conversation-input.types.js";
import type { ChannelIngressAdmissionScope } from "./admission-evidence-scope-key.js";
import { withAdminIngress } from "./operator-authority.test-support.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

it("retains the real linked requester and operator, then refuses the retired identity grant", async () => {
  await withAdminIngress(
    async ({ admins, gateway }) => {
      const { identity, profile } = admins[0]!;
      const owner = {
        channelId: identity.channelId,
        isLive: () => true,
        resolveGatewayContext: () => gateway,
      };
      const runtime = createHostChannelIngressRuntime(owner);
      const scope = {
        channelId: identity.channelId,
        accountId: identity.accountId,
        rawPrincipalRef: identity.senderId,
        conversation: { kind: "direct", id: "example-conversation" },
        binding: {
          agentId: "main",
          sessionKey: "agent:main:conversation:example-call",
          inboundEventKind: "user_request",
        },
      } satisfies ChannelIngressAdmissionScope;
      const input: ConversationInputScopeV1 = {
        agentId: "main",
        conversationId: "example-call",
        inputId: "original-utterance",
        purpose: "user",
      };
      const resolve = async (inputId: string) => {
        const admittedSource = { ...scope, binding: { ...scope.binding, messageId: inputId } };
        const ingress = await runtime.resolveStable({
          channelId: scope.channelId,
          accountId: scope.accountId,
          identity: { authentication: "verified" },
          subject: { stableId: identity.senderId },
          conversation: scope.conversation,
          contextBinding: admittedSource.binding,
          dmPolicy: "open",
          allowFrom: ["*"],
          useDefaultPairingStore: false,
        });
        const admittedScope = { ...input, inputId };
        return consumeConversationInputAdmission(
          runtime.conversation.admitInput({
            input: admittedScope,
            ingress,
            scope: admittedSource,
            assertCurrent() {},
            context: {
              channel: scope.channelId,
              accountId: scope.accountId,
              from: `${scope.channelId}:${identity.senderId}`,
              sender: { id: identity.senderId },
              conversation: scope.conversation,
              route: { agentId: input.agentId, routeSessionKey: scope.binding.sessionKey },
              reply: { to: "example-conversation" },
            },
          }),
          admittedScope,
        );
      };
      const original = await resolve(input.inputId);
      expect(original.principal).toEqual(identity);
      expect(original.requesterProfile?.id).toBe(profile.id);
      expect(original.operatorAuthority?.profileId).toBe(profile.id);
      expect(original.operatorAuthority?.scopes).toEqual(["operator.admin"]);
      claimConversationInputExecution(original);
      const context = await prepareConversationReplyContext(original, { text: "My request" });
      expect(context.SessionKey).toBe(scope.binding.sessionKey);
      expect(getRequesterProfile(context)?.id).toBe(profile.id);
      expect(getCommandOwnerAuthority(context)?.operatorAuthority?.profileId).toBe(profile.id);

      const pending = await resolve("later-utterance");
      claimConversationInputExecution(pending);
      unlinkUserChannelIdentity(profile.id, identity);
      expect(() => original.assertCurrent()).toThrow();
      expect(() => pending.operatorAuthority?.assertCurrent()).toThrow();
      expect(getRequesterProfile(context)).toBeUndefined();
      await expect(
        prepareConversationReplyContext(pending, { text: "Do not adopt revoked input" }),
      ).rejects.toThrow();
    },
    "role",
    "slack",
  );
});
