import { describe, expect, it } from "vitest";
import {
  renderAssistantRequestFailureCopy,
  renderRuntimeCoordinationFailureCopy,
} from "../agents/failover/assistant-request-failure-copy.js";
import {
  formatRealtimeVoiceAgentQueueRejection,
  formatRealtimeVoiceAgentStatus,
} from "../talk/agent-run-control-shared.js";
import { resolveUserMessages } from "./user-messages.js";

describe("native localized user presentations", () => {
  it("localizes status and rejection copy while retaining technical tool identifiers", () => {
    expect(
      formatRealtimeVoiceAgentStatus({
        active: true,
        language: "de-DE",
        activity: { activeToolName: "example_tool" },
      }),
    ).toBe("OpenClaw führt example_tool aus.");
    expect(formatRealtimeVoiceAgentQueueRejection("followup", "compacting", "de-DE")).toContain(
      "Kontext",
    );
    expect(formatRealtimeVoiceAgentStatus({ active: false, language: "fr-FR" })).toBe(
      "I'm not working on an active request right now.",
    );
  });

  it("renders already classified common failures without changing their facts or disclosing raw errors", () => {
    const facts = { language: "de-DE", storageFailure: "transcript_writer_fenced" as const };
    expect(renderAssistantRequestFailureCopy(facts)).toContain("Unterhaltung hat sich geändert");
    expect(facts.storageFailure).toBe("transcript_writer_fenced");
    expect(renderAssistantRequestFailureCopy({ language: "de-DE", reason: "timeout" })).toContain(
      "bereits abgeschlossene Arbeiten",
    );
    expect(renderRuntimeCoordinationFailureCopy("runner-offline", "de-DE")).toContain(
      "Worker ist offline",
    );
    expect(renderRuntimeCoordinationFailureCopy("unknown-code", "de-DE")).toBeUndefined();
  });

  it("uses the English catalog for unsupported and absent languages", () => {
    expect(resolveUserMessages("fr-FR")).toBe(resolveUserMessages());
    expect(resolveUserMessages("de-DE").replyStalled).toContain("unterbrochen");
  });
});
