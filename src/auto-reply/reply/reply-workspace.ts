import fs from "node:fs/promises";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { assertReplyPreprocessingActive } from "./reply-preprocessing-abort.js";

type ProvisioningInput = Parameters<
  typeof import("../../agents/acp-workspace-provisioning.js").resolveAcpAgentWorkspaceProvisioningForTurn
>[0];

export async function prepareReplyWorkspace(params: {
  dir: string;
  ensureBootstrapFiles: boolean;
  skipOptionalBootstrapFiles?: string[];
  useFastTestBootstrap: boolean;
  provisioningInput: ProvisioningInput;
  abortSignal?: AbortSignal;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  assertSourceCurrent?: SessionSourceAssertion;
}): Promise<Awaited<ReturnType<typeof ensureAgentWorkspace>>> {
  const { operatorAuthority } = params;
  const options = {
    dir: params.dir,
    ensureBootstrapFiles: params.ensureBootstrapFiles,
    skipOptionalBootstrapFiles: params.skipOptionalBootstrapFiles && [
      ...params.skipOptionalBootstrapFiles,
    ],
  };
  const assertCurrent = () => {
    assertReplyPreprocessingActive(params);
    operatorAuthority?.assertCurrent();
  };
  assertCurrent();
  if (params.useFastTestBootstrap) {
    await fs.mkdir(options.dir, { recursive: true });
    assertCurrent();
    return { dir: options.dir };
  }
  const { resolveAcpAgentWorkspaceProvisioningForTurn } =
    await import("../../agents/acp-workspace-provisioning.js");
  const provisioning = await resolveAcpAgentWorkspaceProvisioningForTurn(params.provisioningInput);
  assertCurrent();
  const workspace = await ensureAgentWorkspace({
    ...options,
    provisioning,
    guard: { assertHost: assertCurrent },
  });
  assertCurrent();
  return workspace;
}
