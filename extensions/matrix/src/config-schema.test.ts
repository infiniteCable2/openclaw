import { describe, expect, it } from "vitest";
import { MatrixChannelConfigSchema } from "./config-schema.js";

const MatrixConfigSchema = MatrixChannelConfigSchema.runtime;
if (!MatrixConfigSchema) {
  throw new Error("expected Matrix runtime config schema");
}

describe("MatrixConfigSchema SecretInput", () => {
  it("accepts an opt-in list for durable DM commentary without enabling streaming", () => {
    const result = MatrixConfigSchema.safeParse({ commentaryAgentIds: ["assistant"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ commentaryAgentIds: ["assistant"] });
      expect(result.data).not.toHaveProperty("streaming");
    }
  });

  it("accepts strict MatrixRTC room, user, and agent admissions", () => {
    const result = MatrixConfigSchema.safeParse({
      rtc: {
        enabled: true,
        authServiceUrl: "https://matrix.example.org/livekit/jwt",
        mediaBridgeCommand: "/opt/openclaw/bin/openclaw-matrix-rtc-media",
        transcriptionProvider: "local-media",
        providers: {
          "local-media": { baseUrl: "http://127.0.0.1:8010/v1" },
        },
        toolPolicy: "owner",
        agentProfiles: {
          example_owner: { agentThinkingLevel: "off", speakCommentary: true },
          example_other: { agentThinkingLevel: "off", speakCommentary: true },
        },
        responseStreaming: "sentence",
        waitingAudio: {
          path: "/opt/openclaw/share/waiting.wav",
          startDelayMs: 1200,
          volume: 0.14,
        },
        admissions: [
          {
            roomId: "!private:example.org",
            userId: "@owner:example.org",
            agentId: "example_owner",
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        rtc: {
          agentProfiles: { example_owner: { agentThinkingLevel: "off", speakCommentary: true } },
        },
      });
    }
  });

  it("rejects retired call-wide thinking and commentary settings", () => {
    expect(MatrixConfigSchema.safeParse({ rtc: { agentThinkingLevel: "off" } }).success).toBe(
      false,
    );
    expect(MatrixConfigSchema.safeParse({ rtc: { speakCommentary: true } }).success).toBe(false);
    expect(
      MatrixConfigSchema.safeParse({ accounts: { work: { rtc: { speakCommentary: true } } } })
        .success,
    ).toBe(false);
  });

  it("rejects incomplete or open-ended MatrixRTC admissions", () => {
    const result = MatrixConfigSchema.safeParse({
      rtc: {
        enabled: true,
        admissions: [{ roomId: "!private:example.org", userId: "*" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("preserves root and account join-introduction overrides without materializing defaults", () => {
    const input = {
      joinIntro: false,
      accounts: {
        work: { joinIntro: true, streaming: { mode: "progress" }, customField: 1 },
        inherited: {},
      },
    };
    const result = MatrixConfigSchema.safeParse(input);
    expect(result).toMatchObject({ success: true, data: input });
    if (result.success) {
      expect(result.data).not.toHaveProperty("accounts.inherited.joinIntro");
    }
  });

  it("publishes account credential SecretInput leaves for Control UI redaction hints", () => {
    for (const key of ["accessToken", "password", "joinIntro"]) {
      expect(MatrixChannelConfigSchema.schema).toHaveProperty(
        `properties.accounts.additionalProperties.properties.${key}`,
      );
    }
  });

  it("rejects retired account streaming input with a doctor pointer", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      accounts: { work: { streamMode: "progress" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.issues)).toContain("doctor --fix");
    }
  });
});

describe("MatrixConfigSchema exec approvals", () => {
  it.each([true, false, "auto"] as const)("accepts the shipped enabled mode %s", (enabled) => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      execApprovals: {
        enabled,
        approvers: ["@owner:example.org"],
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ execApprovals: { enabled } });
    }
  });

  it("preserves omitted approval enablement without introducing a default", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      execApprovals: { approvers: ["@owner:example.org"] },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        execApprovals: { approvers: ["@owner:example.org"] },
      });
      expect(result.data).not.toMatchObject({
        execApprovals: { enabled: expect.anything() },
      });
    }
  });

  it("preserves the existing non-strict approval object", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      execApprovals: {
        enabled: "auto",
        approvers: ["@owner:example.org"],
        unknownApprovalField: true,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        execApprovals: { enabled: "auto", approvers: ["@owner:example.org"] },
      });
      expect(result.data).not.toMatchObject({
        execApprovals: { unknownApprovalField: true },
      });
    }
  });

  it.each(["AUTO", 1, null])("rejects the invalid enabled mode %s", (enabled) => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      execApprovals: { enabled, approvers: ["@owner:example.org"] },
    });

    expect(result.success).toBe(false);
  });
});
