import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCronTool } from "./cron-tool.js";

describe("automation creation from a source without durable reply delivery", () => {
  const gateway = vi.fn();
  beforeEach(() => {
    gateway.mockReset();
    gateway.mockResolvedValue({ ok: true });
  });
  const job = {
    name: "Example reminder",
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "agentTurn", message: "Report the result" },
  };
  const tool = () =>
    createCronTool({ requireExplicitDeliveryTarget: true }, { callGatewayTool: gateway });

  it.each([undefined, { mode: "announce" }, { mode: "announce", channel: "matrix" }])(
    "asks for a durable destination before creating a job (delivery=%j)",
    async (delivery) => {
      await expect(
        tool().execute("create-example", {
          action: "add",
          job: { ...job, ...(delivery ? { delivery } : {}) },
        }),
      ).rejects.toThrow("Ask the user where future results should go");
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it.each([
    { mode: "announce", channel: "matrix", to: "!example:example.org" },
    { mode: "webhook", to: "https://example.org/completed" },
    { mode: "none" },
  ])("keeps explicit native delivery choices (delivery=%j)", async (delivery) => {
    await tool().execute("create-example", { action: "add", job: { ...job, delivery } });
    expect(gateway).toHaveBeenCalledOnce();
    expect(gateway.mock.calls[0]?.[2]).toMatchObject({ delivery });
  });

  it("does not bypass the destination requirement by choosing a system-event reminder", async () => {
    const automation = tool();
    expect(automation.description).toContain("ask where future results should go");
    await expect(
      automation.execute("create-example", {
        action: "add",
        job: { ...job, sessionTarget: "main", payload: { kind: "systemEvent", text: "Reminder" } },
      }),
    ).rejects.toThrow("Ask the user where future results should go");
    expect(gateway).not.toHaveBeenCalled();
  });
});
