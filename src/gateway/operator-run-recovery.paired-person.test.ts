import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { changeCanonicalUserChannelIdentity } from "../state/user-channel-identity-operations.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

describe("restart recovery paired person authority", () => {
  it.each(["before restore", "while retained", "unlink and relink"] as const)(
    "retains the original person link %s",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const profile = ensureProfileForEmail("person@example.test");
        const fixture = await createOperatorRecoveryFixture({
          stateDir: state.stateDir,
          context: createContext(),
          profileId: profile.id,
          config: {},
          pairedPerson: true,
          scopes: ["operator.read", "operator.talk", "operator.write"],
          device: {
            deviceId: "personal-device",
            publicKey: "fixture-public-key",
            roles: ["operator"],
            approvedScopes: ["operator.read", "operator.talk", "operator.write"],
            tokens: {
              operator: {
                token: "fixture-device-token",
                role: "operator",
                scopes: ["operator.read", "operator.talk", "operator.write"],
                createdAtMs: 1,
              },
            },
            createdAtMs: 1,
            approvedAtMs: 1,
          },
        });
        expect(fixture.snapshot.devicePerson).toEqual({
          version: 1,
          id: expect.any(String),
        });
        const restored =
          change === "while retained"
            ? expectDefined(await fixture.restore(), "original person")
            : undefined;
        try {
          restored?.authority.assertCurrent();
          const identity = {
            channelId: "gateway",
            accountId: "paired-device",
            senderId: "personal-device",
          };
          await changeCanonicalUserChannelIdentity("unlink", profile.id, identity);
          if (change === "unlink and relink") {
            await changeCanonicalUserChannelIdentity("link", profile.id, identity);
          }
          if (restored) {
            expect(restored.authority.signal?.aborted).toBe(true);
            expect(restored.authority.assertCurrent).toThrow(/operator authority changed/);
            expect(restored.authority.signal?.reason).toMatchObject({
              cause: expect.objectContaining({ message: expect.stringMatching(/binding changed/) }),
            });
          } else {
            await expect(fixture.restore()).rejects.toThrow(/binding changed/);
          }
        } finally {
          restored?.release();
        }
      });
    },
  );
});
