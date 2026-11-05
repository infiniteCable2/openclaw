import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { changeCanonicalUserChannelIdentity } from "../state/user-channel-identity-operations.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { prepareGatewayOperatorSourceCustody } from "./operator-source-custody.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

const identity = {
  channelId: "gateway",
  accountId: "paired-device",
  senderId: "personal-device",
};

async function createSource(stateDir: string) {
  const profile = ensureProfileForEmail("source-custody@example.test");
  const scopes = ["operator.read", "operator.talk", "operator.write"];
  const fixture = await createOperatorRecoveryFixture({
    stateDir,
    context: createContext(),
    profileId: profile.id,
    config: {},
    pairedPerson: true,
    scopes,
    device: {
      deviceId: identity.senderId,
      publicKey: "fixture-public-key",
      roles: ["operator"],
      approvedScopes: scopes,
      tokens: {
        operator: {
          token: "fixture-device-token",
          role: "operator",
          scopes,
          createdAtMs: 1,
        },
      },
      createdAtMs: 1,
      approvedAtMs: 1,
    },
  });
  return {
    fixture,
    profile,
    snapshot: expectDefined(fixture.entry.restartRecoveryOperatorSource, "native source").snapshot,
  };
}

describe("native operator source custody", () => {
  it("prepares only a principal proof without requiring or restoring a run claim", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { fixture, profile, snapshot } = await createSource(state.stateDir);
      fixture.retire();
      await expect(fixture.restore()).rejects.toThrow("Recovery claim retired");
      const held = await prepareGatewayOperatorSourceCustody({
        snapshot,
        context: fixture.context,
        assertCurrent: () => {},
      });
      const release = held.retain();
      try {
        expect(Object.keys(held).toSorted()).toEqual([
          "assertCurrent",
          "profileId",
          "release",
          "retain",
          "signal",
        ]);
        expect(held.profileId).toBe(profile.id);
        held.release();
        expect(held.assertCurrent).not.toThrow();
      } finally {
        held.release();
        release();
      }
      expect(held.assertCurrent).toThrow("no longer active");
    });
  });

  it.each(["before preparation", "while retained", "unlink and relink"] as const)(
    "refuses the original person authorization %s",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { fixture, profile, snapshot } = await createSource(state.stateDir);
        const prepare = () =>
          prepareGatewayOperatorSourceCustody({
            snapshot,
            context: fixture.context,
            assertCurrent: () => {},
          });
        const held = change === "while retained" ? await prepare() : undefined;
        try {
          await changeCanonicalUserChannelIdentity("unlink", profile.id, identity);
          if (change === "unlink and relink") {
            await changeCanonicalUserChannelIdentity("link", profile.id, identity);
          }
          if (held) {
            expect(held.signal.aborted).toBe(true);
            expect(held.assertCurrent).toThrow("operator authority changed");
          } else {
            await expect(prepare()).rejects.toThrow("binding changed");
          }
        } finally {
          held?.release();
        }
      });
    },
  );

  it("retires on its caller lifetime without following a later preparation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { fixture, snapshot } = await createSource(state.stateDir);
      const abort = new AbortController();
      const held = await prepareGatewayOperatorSourceCustody({
        snapshot,
        context: fixture.context,
        assertCurrent: () => {},
        signal: abort.signal,
      });
      try {
        abort.abort();
        expect(held.signal.aborted).toBe(true);
        expect(held.assertCurrent).toThrow("operator authority changed");
        expect(held.retain).toThrow("operator authority changed");
      } finally {
        held.release();
      }
      await expect(
        prepareGatewayOperatorSourceCustody({
          snapshot,
          context: fixture.context,
          assertCurrent: () => {},
          signal: abort.signal,
        }),
      ).rejects.toThrow();
    });
  });
});
