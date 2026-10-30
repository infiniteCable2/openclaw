import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  beginForegroundSessionMaintenance,
  createSessionMaintenanceOwner,
  onSessionMaintenanceAvailable,
  tryCreateIdleSessionMaintenanceOwner,
} from "./coordinator.js";

afterEach(async () => {
  await drainGlobalSingletonLifecycleState("close");
});

it("wakes an idle recipient when the final foreground reservation releases", async () => {
  const key = "session:idle-wake-foreground";
  let wakeups = 0;
  const unsubscribe = onSessionMaintenanceAvailable(key, () => wakeups++);
  const releaseFirst = await beginForegroundSessionMaintenance(key);
  const releaseSecond = await beginForegroundSessionMaintenance(key);
  try {
    releaseFirst();
    expect(wakeups).toBe(0);
    releaseSecond();
    expect(wakeups).toBe(1);
    unsubscribe();
    const releaseLater = await beginForegroundSessionMaintenance(key);
    releaseLater();
    expect(wakeups).toBe(1);
  } finally {
    releaseFirst();
    releaseSecond();
    unsubscribe();
  }
});

it("wakes a recipient after other native maintenance settles", async () => {
  const key = "session:idle-wake-maintenance";
  let wakeups = 0;
  const unsubscribe = onSessionMaintenanceAvailable(key, () => wakeups++);
  const owner = createSessionMaintenanceOwner({ sessionKey: key });
  try {
    expect(tryCreateIdleSessionMaintenanceOwner({ sessionKey: key })).toBeUndefined();
    await owner.track(Promise.resolve());
    expect(wakeups).toBe(1);
  } finally {
    unsubscribe();
  }
});

it("does not reschedule its own settled idle probe", async () => {
  const key = "session:idle-no-self-wake";
  let wakeups = 0;
  const unsubscribe = onSessionMaintenanceAvailable(key, () => wakeups++);
  const owner = tryCreateIdleSessionMaintenanceOwner({ sessionKey: key });
  try {
    if (!owner) {
      throw new Error("Expected idle probe owner");
    }
    await owner.track(owner.run(async () => {}));
    expect(wakeups).toBe(0);
  } finally {
    unsubscribe();
  }
});

it("refuses an idle owner immediately while foreground is reserved", async () => {
  const release = await beginForegroundSessionMaintenance("session:idle-foreground");
  try {
    expect(
      tryCreateIdleSessionMaintenanceOwner({ sessionKey: "session:idle-foreground" }),
    ).toBeUndefined();
  } finally {
    release();
  }
});

it("does not enqueue idle work behind an existing maintenance writer", async () => {
  const owner = createSessionMaintenanceOwner({ sessionKey: "session:idle-maintenance" });
  try {
    expect(
      tryCreateIdleSessionMaintenanceOwner({ sessionKey: "session:idle-maintenance" }),
    ).toBeUndefined();
  } finally {
    await owner.track(Promise.resolve());
  }
});

it("preempts admitted idle work and settles its real writes before foreground", async () => {
  const key = "session:idle-preemption";
  const owner = tryCreateIdleSessionMaintenanceOwner({ sessionKey: key });
  expect(owner).toBeDefined();
  if (!owner) {
    throw new Error("Expected idle owner");
  }
  const started = createDeferred();
  const aborted = createDeferred();
  const cleanup = createDeferred();
  const events: string[] = [];
  owner.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
  const work = owner.track(
    owner.run(async () => {
      started.resolve();
      try {
        await aborted.promise;
        owner.assertCurrent();
      } finally {
        events.push("cleanup");
        await cleanup.promise;
      }
    }),
  );
  const stopped = expect(work).rejects.toMatchObject({ name: "AbortError" });
  await started.promise;
  const foreground = beginForegroundSessionMaintenance(key).then((release) => {
    events.push("foreground");
    return release;
  });
  try {
    await aborted.promise;
    expect(events).not.toContain("foreground");
  } finally {
    cleanup.resolve();
    (await foreground)();
    await stopped;
  }
  expect(events).toEqual(["cleanup", "foreground"]);
});
