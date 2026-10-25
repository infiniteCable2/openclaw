import { resolveMemoryDeepDreamingConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import { describe, expect, it, vi } from "vitest";
import { MANAGED_DREAMING_DECLARATION_KEY } from "./dreaming-cron-contract.js";
import { reconcileShortTermDreamingCronJob, type CronServiceLike } from "./dreaming-cron.js";

function fixture() {
  const jobs: Awaited<ReturnType<CronServiceLike["list"]>> = [];
  const add = vi.fn<CronServiceLike["add"]>(async (input) => {
    jobs.push({ id: "managed-sweep", ...input });
  });
  const update = vi.fn<CronServiceLike["update"]>(async (id, patch) => {
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job) {
      throw new Error("Expected the existing managed sweep");
    }
    Object.assign(job, patch);
  });
  const remove = vi.fn<CronServiceLike["remove"]>(async () => ({ removed: false }));
  const cron: CronServiceLike = { list: async () => jobs, add, update, remove };
  const config = resolveMemoryDeepDreamingConfig({
    cfg: {},
    pluginConfig: { dreaming: { enabled: true } },
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    jobs,
    add,
    update,
    remove,
    reconcile: () => reconcileShortTermDreamingCronJob({ cron, config, logger }),
  };
}

describe("managed dreaming ambient ownership", () => {
  it("creates an unpinned sweep and clears a historical pin once without touching other jobs", async () => {
    const f = fixture();
    expect(await f.reconcile()).toMatchObject({ status: "added" });
    expect(f.add.mock.calls[0]?.[0]).not.toHaveProperty("agentId");
    const managed = f.jobs[0]!;
    expect(managed.declarationKey).toBe(MANAGED_DREAMING_DECLARATION_KEY);
    managed.agentId = "retired-agent";
    const foreign = { ...managed, id: "foreign", declarationKey: "other-plugin:sweep" };
    f.jobs.push(foreign);

    expect(await f.reconcile()).toMatchObject({ status: "updated" });
    expect(f.update).toHaveBeenCalledExactlyOnceWith(managed.id, { agentId: undefined });
    expect(Object.hasOwn(f.update.mock.calls[0]![1], "agentId")).toBe(true);
    expect(managed.agentId).toBeUndefined();
    expect(foreign.agentId).toBe("retired-agent");
    expect(f.remove).not.toHaveBeenCalled();
    expect(await f.reconcile()).toMatchObject({ status: "noop" });
    expect(f.add).toHaveBeenCalledOnce();
    expect(f.update).toHaveBeenCalledOnce();
  });
});
