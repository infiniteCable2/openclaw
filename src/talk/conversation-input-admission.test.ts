import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  createConversationInputAdmission,
  prepareConversationReplyContext,
  releaseConversationInputAdmission,
  type AdmittedConversationInput,
} from "./conversation-input-admission.js";
import type {
  ConversationInputAdmissionV1,
  ConversationInputScopeV1,
} from "./conversation-input.types.js";

const scope: ConversationInputScopeV1 = {
  agentId: "researcher",
  conversationId: "call-alpha",
  inputId: "utterance-alpha",
  purpose: "user",
};

function prepareInput(prepareContext?: AdmittedConversationInput["prepareContext"]) {
  let transportCurrent = true;
  let sourceCurrent = true;
  const input = {
    scope: { ...scope },
    prepareContext,
    source: {
      channelId: "example",
      accountId: "primary",
      sessionKey: "agent:researcher:example:peer",
    },
    assertInputCurrent: () => {
      if (!transportCurrent) {
        throw new Error("Input transport closed");
      }
    },
    assertCurrent: () => {
      if (!sourceCurrent) {
        throw new Error("Original authority revoked");
      }
    },
  };
  const admission = createConversationInputAdmission(input);
  return {
    input,
    admission,
    closeTransport: () => {
      transportCurrent = false;
    },
    revokeSource: () => {
      sourceCurrent = false;
    },
  };
}

describe("native conversation input handoff", () => {
  it.for([false, true])("releases only unconsumed admissions, transferred=%s", (transferred) => {
    const prepared = prepareInput();
    const release = vi.fn();
    const admission = createConversationInputAdmission({ ...prepared.input, release });
    const accepted = transferred ? consumeConversationInputAdmission(admission, scope) : undefined;
    releaseConversationInputAdmission(admission);
    releaseConversationInputAdmission(admission);
    expect(release).toHaveBeenCalledTimes(transferred ? 0 : 1);
    expect(() => consumeConversationInputAdmission(admission, scope)).toThrow("unavailable");
    accepted?.release?.();
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses an unknown input purpose at the host issuer", () => {
    const fixture = prepareInput();
    const invalid = { ...fixture.input, scope: { ...scope } };
    Reflect.set(invalid.scope, "purpose", "task");
    expect(() => createConversationInputAdmission(invalid)).toThrow("unavailable");
  });

  it("consumes an exact input once without granting owner, task, or context-read rights", () => {
    const { admission } = prepareInput();
    const accepted = consumeConversationInputAdmission(admission, scope);
    expect(accepted.scope).toEqual(scope);
    expect(accepted.source.sessionKey).toBe("agent:researcher:example:peer");
    expect(accepted.operatorAuthority).toBeUndefined();
    expect(accepted.assertOwnerCurrent).toBeUndefined();
    expect(accepted).not.toHaveProperty("spawnedBy");
    expect(accepted).not.toHaveProperty("readSource");
    expect(() => consumeConversationInputAdmission(admission, scope)).toThrow("unavailable");
  });

  it.each([
    { agentId: "other-agent" },
    { conversationId: "other-call" },
    { inputId: "other-utterance" },
    { purpose: "greeting" as const },
  ])(
    "consumes and refuses a mismatched scope $agentId $conversationId $inputId $purpose",
    (other) => {
      const { admission } = prepareInput();
      expect(() => consumeConversationInputAdmission(admission, { ...scope, ...other })).toThrow(
        "unavailable",
      );
      expect(() => consumeConversationInputAdmission(admission, scope)).toThrow("unavailable");
    },
  );

  it("does not turn serialized or copied metadata into an input capability", () => {
    const { admission } = prepareInput();
    const forged: ConversationInputAdmissionV1 = {
      version: 1,
      kind: "conversation-input-admission",
    };
    for (const copy of [forged, { ...admission }, structuredClone(admission)]) {
      expect(() => consumeConversationInputAdmission(copy, scope)).toThrow("unavailable");
    }
    expect(consumeConversationInputAdmission(admission, scope).scope).toEqual(scope);
  });

  it("pins routing and input identity rather than retaining mutable caller options", () => {
    const prepared = prepareInput();
    prepared.input.scope.conversationId = "replacement-call";
    prepared.input.source.sessionKey = "agent:researcher:replacement";
    prepared.input.assertCurrent = () => {
      throw new Error("Replacement callback");
    };
    const accepted = consumeConversationInputAdmission(prepared.admission, scope);
    expect(accepted.source.sessionKey).toBe("agent:researcher:example:peer");
    expect(() => accepted.assertCurrent()).not.toThrow();
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.scope)).toBe(true);
  });

  it("refuses a transport that closes before input acceptance", () => {
    const prepared = prepareInput();
    prepared.closeTransport();
    expect(() => consumeConversationInputAdmission(prepared.admission, scope)).toThrow(
      "Input transport closed",
    );
    expect(() => consumeConversationInputAdmission(prepared.admission, scope)).toThrow(
      "unavailable",
    );
  });

  it("allows accepted work to outlive audio while retaining original authorization", () => {
    const prepared = prepareInput();
    const accepted = consumeConversationInputAdmission(prepared.admission, scope);
    prepared.closeTransport();
    expect(() => accepted.assertInputCurrent()).toThrow("Input transport closed");
    expect(() => accepted.assertCurrent()).not.toThrow();
    prepared.revokeSource();
    expect(() => accepted.assertCurrent()).toThrow("Original authority revoked");
  });

  it("checks the original authorization even while the transport remains live", () => {
    const prepared = prepareInput();
    prepared.revokeSource();
    expect(() => consumeConversationInputAdmission(prepared.admission, scope)).toThrow(
      "Original authority revoked",
    );
  });

  it("transfers one accepted input to native execution exactly once", () => {
    const { admission } = prepareInput();
    const accepted = consumeConversationInputAdmission(admission, scope);
    expect(() => claimConversationInputExecution(accepted)).not.toThrow();
    expect(() => claimConversationInputExecution(accepted)).toThrow("unavailable");
  });

  it("rejects copies of accepted facts as execution handoffs", () => {
    const { admission } = prepareInput();
    const accepted = consumeConversationInputAdmission(admission, scope);
    expect(() => claimConversationInputExecution({ ...accepted })).toThrow("unavailable");
    expect(() => claimConversationInputExecution(accepted)).not.toThrow();
  });

  it("allows execution transfer after audio closes without accepting revoked authority", () => {
    const prepared = prepareInput();
    const accepted = consumeConversationInputAdmission(prepared.admission, scope);
    prepared.closeTransport();
    expect(() => claimConversationInputExecution(accepted)).not.toThrow();

    const revoked = prepareInput();
    const revokedInput = consumeConversationInputAdmission(revoked.admission, scope);
    revoked.revokeSource();
    expect(() => claimConversationInputExecution(revokedInput)).toThrow(
      "Original authority revoked",
    );
    expect(() => claimConversationInputExecution(revokedInput)).toThrow("unavailable");
  });

  it("does not project an admitted input without its original host context owner", async () => {
    const prepared = prepareInput();
    const input = consumeConversationInputAdmission(prepared.admission, scope);
    claimConversationInputExecution(input);
    await expect(prepareConversationReplyContext(input, { text: "Speech" })).rejects.toThrow(
      "unavailable",
    );
  });

  it("rechecks original authority after awaited context projection and refuses replay", async () => {
    const gate = createDeferred();
    const entered = createDeferred();
    const prepared = prepareInput(async (text) => {
      entered.resolve();
      await gate.promise;
      return { AgentId: scope.agentId, SessionKey: "agent:researcher:example:peer", Body: text };
    });
    const input = consumeConversationInputAdmission(prepared.admission, scope);
    claimConversationInputExecution(input);
    const pending = prepareConversationReplyContext(input, { text: "Speech" });
    await entered.promise;
    prepared.revokeSource();
    gate.resolve();
    await expect(pending).rejects.toThrow("Original authority revoked");
    await expect(prepareConversationReplyContext(input, { text: "Replay" })).rejects.toThrow(
      "unavailable",
    );
  });

  it("refuses a host projection that changes the original agent or dispatch target", async () => {
    const prepared = prepareInput((text) => ({
      AgentId: scope.agentId,
      SessionKey: "agent:other:private",
      Body: text,
    }));
    const input = consumeConversationInputAdmission(prepared.admission, scope);
    claimConversationInputExecution(input);
    await expect(prepareConversationReplyContext(input, { text: "Speech" })).rejects.toThrow(
      "unavailable",
    );
    await expect(prepareConversationReplyContext(input, { text: "Replay" })).rejects.toThrow(
      "unavailable",
    );
  });
});
