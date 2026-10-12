import { afterEach, describe, expect, it } from "vitest";
import { getFreePort } from "../test-utils/ports.js";
import {
  createConfiguredProviderLocalServiceAcquirer,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";

describe("provider readiness wait", () => {
  afterEach(async () => {
    await stopManagedProviderLocalServices();
  });

  it("ends the readiness wait before reconciliation on cold and warm acquisition", async () => {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const phases: boolean[] = [];
    const acquire = createConfiguredProviderLocalServiceAcquirer(() => ({
      models: {
        providers: {
          "local-reconcile": {
            baseUrl,
            models: [],
            localService: {
              command: process.execPath,
              args: [
                "-e",
                `const http=require("http");let generation="worker1";http.createServer((req,res)=>{if(req.url==="/rotate")generation="worker2";res.writeHead(200,{"X-OpenClaw-Service-Generation":generation});res.end("ok");}).listen(${port},"127.0.0.1");`,
              ],
              readyTimeoutMs: 5_000,
              idleStopMs: 1,
            },
          },
        },
      },
    }));
    const target = {
      providerId: "local-reconcile",
      baseUrl,
      onReadinessWait: (waiting: boolean) => {
        phases.push(waiting);
      },
      reconcile: async () => {
        expect(phases).toEqual([true, false]);
        expect((await fetch(`${baseUrl}/models`)).ok).toBe(true);
      },
    };
    const coldLease = await acquire(target);
    expect(coldLease).toBeDefined();
    phases.length = 0;
    const warmLease = await acquire(target);
    expect(warmLease).toBeDefined();
    expect(coldLease?.admission?.generation).toBe("worker1");
    expect(warmLease?.admission).toBe(coldLease?.admission);
    await fetch(`http://127.0.0.1:${port}/rotate`);
    phases.length = 0;
    const replacement = await acquire(target);
    expect(coldLease?.admission?.signal.aborted).toBe(true);
    expect(replacement?.admission?.generation).toBe("worker2");
    expect(replacement?.admission?.signal.aborted).toBe(false);
    await stopManagedProviderLocalServices();
    expect(replacement?.admission?.signal.aborted).toBe(true);
    coldLease?.release();
    warmLease?.release();
    replacement?.release();
  });
});
