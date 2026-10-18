import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { projectConversationToolNames } from "../../agents/conversation-tool-policy-pipeline.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { resolveEffectiveToolFsRootExpansionAllowed } from "../../agents/tool-fs-policy.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import type { MsgContext } from "../templating.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

export function enableReplyLocalPathSelfServe(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionCtx: MsgContext;
  sessionKey?: string;
  sessionEntry: SessionEntry;
  workspaceDir: string;
  senderIsOwner?: boolean;
  modelProvider: string;
  modelId: string;
  toolsAllow: InternalGetReplyOptions["toolsAllow"];
  stagedAttachmentPaths: ReadonlyMap<number, string>;
  contexts: MsgContext[];
  enable: NonNullable<ApplyMediaUnderstandingResult["enableLocalPathSelfServe"]>;
}): void {
  const {
    cfg,
    agentId,
    sessionCtx,
    sessionKey,
    sessionEntry,
    workspaceDir,
    stagedAttachmentPaths,
  } = params;
  const policySessionKey = resolveRuntimePolicySessionKey({
    cfg,
    agentId,
    ctx: sessionCtx,
    sessionKey,
  });
  const sandboxed = resolveSandboxRuntimeStatus({
    cfg,
    agentId,
    sessionKey,
    classificationSessionKey: policySessionKey,
  }).sandboxed;
  if (
    (sandboxed && stagedAttachmentPaths.size > 0) ||
    (!sandboxed && resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId }))
  ) {
    const capabilityProfile = resolveConversationCapabilityProfile({
      config: cfg,
      sessionKey: policySessionKey,
      runSessionKey: policySessionKey === sessionKey ? undefined : sessionKey,
      agentId,
      agentAccountId: sessionCtx.AccountId,
      messageProvider: resolveOriginMessageProvider({
        originatingChannel: sessionCtx.OriginatingChannel,
        provider: sessionCtx.Provider ?? sessionCtx.Surface,
      }),
      conversationToolPolicy: sessionCtx.ConversationToolPolicy,
      groupId: resolveGroupSessionKey(sessionCtx)?.id,
      groupChannel:
        normalizeOptionalString(sessionCtx.GroupChannel) ??
        normalizeOptionalString(sessionCtx.GroupSubject),
      groupSpace: normalizeOptionalString(sessionCtx.GroupSpace),
      spawnedBy: normalizeOptionalString(sessionEntry.spawnedBy),
      senderId: normalizeOptionalString(sessionCtx.SenderId),
      senderName: normalizeOptionalString(sessionCtx.SenderName),
      senderUsername: normalizeOptionalString(sessionCtx.SenderUsername),
      senderE164: normalizeOptionalString(sessionCtx.SenderE164),
      senderIsOwner: params.senderIsOwner,
      modelProvider: params.modelProvider,
      modelId: params.modelId,
      workspaceDir,
      runtimeToolAllowlist: params.toolsAllow,
      inheritRuntimeToolAllowlist: true,
      inputProvenance: sessionCtx.InputProvenance,
    });
    if (
      projectConversationToolNames({ capabilityProfile, toolNames: ["read"], warn: () => {} })
        .length === 1
    ) {
      params.enable(
        params.contexts,
        stagedAttachmentPaths.size > 0 ? stagedAttachmentPaths : undefined,
      );
    }
  }
}
