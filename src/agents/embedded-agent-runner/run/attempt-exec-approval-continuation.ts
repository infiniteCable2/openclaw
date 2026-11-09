import type { Model } from "../../../llm/types.js";
import { resizeExecApprovalContinuationPrompt } from "../../bash-tools.exec-approval-output.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { resolveLiveToolResultMaxChars } from "../../tool-result-limits.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";

/** Resize the execution result and its transcript mirror against the selected model budget. */
export function prepareAttemptExecApprovalContinuation(
  params: RunEmbeddedAgentInternalParams,
  prompt: string,
  model: Model,
  contextTokenBudget: number | undefined,
) {
  const prepared = { prompt, transcriptPrompt: params.transcriptPrompt };
  const promptRange = params.execApprovalContinuationPromptRange;
  if (promptRange) {
    const contextWindowTokens = Math.max(
      1,
      Math.floor(
        contextTokenBudget ?? model.contextWindow ?? model.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
      ),
    );
    const maxOutputUtf16Units = resolveLiveToolResultMaxChars({ contextWindowTokens });
    const resize = (outputPrompt: string, range = promptRange) =>
      resizeExecApprovalContinuationPrompt({ prompt: outputPrompt, range, maxOutputUtf16Units });
    prepared.prompt = resize(prompt);
    prepared.transcriptPrompt =
      params.transcriptPrompt === undefined
        ? undefined
        : resize(
            params.transcriptPrompt,
            params.execApprovalContinuationTranscriptPromptRange ?? promptRange,
          );
    params.userTurnTranscriptRecorder?.replaceTextBeforePersistence?.(
      prepared.transcriptPrompt ?? prepared.prompt,
    );
  }
  return prepared;
}
