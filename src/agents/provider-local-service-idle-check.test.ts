import { describe, expect, it } from "vitest";
import { checkLocalServiceIdleStop } from "./provider-local-service-idle-check.js";

describe("local service idle-stop check", () => {
  it("reads a bounded decision from an external owner", async () => {
    const decision = await checkLocalServiceIdleStop({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({stop:false,validUntilEpoch:Date.now()/1000+30}))",
      ],
    });
    expect(decision.stop).toBe(false);
    expect(decision.recheckMs).toBeGreaterThan(0);
    expect(decision.recheckMs).toBeLessThanOrEqual(30_000);
  });

  it("accepts a current stop request", async () => {
    const decision = await checkLocalServiceIdleStop({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({stop:true,validUntilEpoch:Date.now()/1000+30}))",
      ],
    });
    expect(decision.stop).toBe(true);
  });

  it("rejects an unproven or expired decision", async () => {
    await expect(
      checkLocalServiceIdleStop({
        command: process.execPath,
        args: ["-e", 'process.stdout.write(JSON.stringify({stop:"true",validUntilEpoch:0}))'],
      }),
    ).rejects.toThrow("expired decision");
  });
});
