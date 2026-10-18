import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readPreparedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";
import { prepareInternalGetReplyOptions, type InternalGetReplyOptions } from "./get-reply.types.js";
import { createQueueCase } from "./queue.case.test-support.js";
import { clearFollowupQueueForTest, createQueueTestRun } from "./queue.test-helpers.js";
import {
  createOverflowSummaryRetrySource,
  prepareNextDeliveryGroup,
} from "./queue/delivery-context.js";
import { admitFollowupRunLifecycle } from "./queue/lifecycle.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { isFollowupRunAborted } from "./queue/types.js";
import type { ReplySpeechPresentationSource } from "./reply-speech-presentation.js";

const queueKeys = new Set<string>();
afterEach(() => {
  for (const key of queueKeys) clearFollowupQueueForTest(key);
  queueKeys.clear();
});

function source(name: string) {
  let available = true;
  return {
    assertCurrent: vi.fn(() => {
      if (!available) throw new Error(`${name} source unavailable`);
    }),
    refuse: () => {
      available = false;
    },
  };
}

function speechSource(): ReplySpeechPresentationSource {
  return {
    speakCommentary: true,
    onError: vi.fn(),
    openRun: vi.fn(() => ({
      onBlockReply() {},
      finish: async () => {},
      abort: async () => {},
      close() {},
    })),
  };
}

describe("native queued non-owner source authority", () => {
  it("pins and checks an internal source before preprocessing without requiring an owner", () => {
    const original = source("guest");
    const options: InternalGetReplyOptions = { assertSourceCurrent: original.assertCurrent };
    const prepared = prepareInternalGetReplyOptions(options);
    expect(prepared?.assertSourceCurrent).toBe(original.assertCurrent);
    expect(prepared?.operatorAuthority).toBeUndefined();
    options.assertSourceCurrent = () => {};
    original.refuse();
    expect(() => prepared?.assertSourceCurrent?.()).toThrow("guest source unavailable");
    const unavailableOptions: InternalGetReplyOptions = {
      assertSourceCurrent: original.assertCurrent,
    };
    expect(() => prepareInternalGetReplyOptions(unavailableOptions)).toThrow(
      "guest source unavailable",
    );
  });

  it("collects every original guest assertion into the actual drained native admission", async () => {
    const q = createQueueCase({ mode: "collect", debounceMs: 0 });
    queueKeys.add(q.key);
    const sources = [source("first"), source("second")];
    const settlements = sources.map(() => createDeferred());
    for (const [index, original] of sources.entries()) {
      const queued = createQueueTestRun({ prompt: `request ${index}` });
      queued.assertSourceCurrent = original.assertCurrent;
      queued.run.senderIsOwner = false;
      queued.turnAdoptionLifecycle = {
        admission: "cancel-only",
        ownerKey: "same-conversation",
        onAdopted: () => {},
        onSettled: () => settlements[index]!.resolve(),
      };
      expect(q.add(queued)).toBe(true);
    }
    const observed: string[] = [];
    q.start(async (queued) => {
      expect(queued.prompt).toContain("request 0");
      expect(queued.prompt).toContain("request 1");
      expect(queued.operatorAuthority).toBeUndefined();
      expect(queued.run.senderIsOwner).toBe(false);
      const prepared = prepareChannelRunAdmission({
        cfg: {},
        runId: "queued-original-guest",
        agentId: queued.run.agentId,
        ingressKind: "channel",
        boundary: "source-authority-test",
        assertSourceCurrent: queued.assertSourceCurrent,
      });
      try {
        await admitFollowupRunLifecycle(queued);
        await prepared.admit("embedded");
        expect(readPreparedRunOperatorAuthority(prepared)).toBeUndefined();
        prepared.assertSourceCurrent();
        expect(sources[0]!.assertCurrent).toHaveBeenCalled();
        expect(sources[1]!.assertCurrent).toHaveBeenCalled();
        sources[0]!.refuse();
        expect(() => prepared.assertSourceCurrent()).toThrow("first source unavailable");
        observed.push(queued.prompt);
      } finally {
        prepared.close();
      }
    });
    await Promise.all(settlements.map((settlement) => settlement.promise));
    expect(observed).toHaveLength(1);
  });

  it("settles refused guest input before drain through the original native lifecycle, not a silent drop", async () => {
    const q = createQueueCase({ mode: "collect", debounceMs: 0 });
    queueKeys.add(q.key);
    const original = source("guest");
    const abandoned = createDeferred();
    const settled = createDeferred();
    const cleanup = createDeferred();
    const onAdopted = vi.fn();
    const onAbandoned = vi.fn(() => abandoned.resolve());
    const onSettled = vi.fn(() => settled.resolve());
    const queued = createQueueTestRun({ prompt: "guest request" });
    queued.assertSourceCurrent = original.assertCurrent;
    queued.turnAdoptionLifecycle = { admission: "exclusive", onAdopted, onAbandoned, onSettled };
    expect(q.add(queued)).toBe(true);
    original.refuse();
    q.start(async (input) => {
      expect(input).toBe(queued);
      expect(isFollowupRunAborted(input)).toBe(true);
      expect(input.operatorAuthority).toBeUndefined();
      expect(input.abortSignal).toBeUndefined();
      cleanup.resolve();
    });
    await Promise.all([abandoned.promise, settled.promise, cleanup.promise]);
    expect(onAdopted).not.toHaveBeenCalled();
    expect(onAbandoned).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(getExistingFollowupQueue(q.key)?.items ?? []).toEqual([]);
  });

  it("keeps the original assertion in a native overflow retry source", () => {
    const original = source("guest");
    const queued = createQueueTestRun({ prompt: "request" });
    queued.assertSourceCurrent = original.assertCurrent;
    const retry = createOverflowSummaryRetrySource(queued);
    expect(retry.assertSourceCurrent).toBe(original.assertCurrent);
    original.refuse();
    expect(() => retry.assertSourceCurrent?.()).toThrow("guest source unavailable");
  });

  it("does not accept replacing an assertion while native group preparation is held", async () => {
    const original = source("guest");
    const queued = createQueueTestRun({ prompt: "request" });
    queued.assertSourceCurrent = original.assertCurrent;
    const prepared = await prepareNextDeliveryGroup(
      () => [queued],
      () => {},
    );
    queued.assertSourceCurrent = () => {};
    expect(() => prepared.assertCurrent()).toThrow("Queued delivery source changed");
  });

  it("drains two speech outputs individually even when their chat route and policy match", async () => {
    const q = createQueueCase({ mode: "collect", debounceMs: 0 });
    queueKeys.add(q.key);
    const outputs = [speechSource(), speechSource()];
    const settlements = outputs.map(() => createDeferred());
    for (const [index, output] of outputs.entries()) {
      const queued = createQueueTestRun({ prompt: `speech ${index}` });
      queued.speechPresentation = output;
      queued.turnAdoptionLifecycle = {
        admission: "cancel-only",
        ownerKey: "same-conversation",
        onAdopted() {},
        onSettled: () => settlements[index]!.resolve(),
      };
      expect(q.add(queued)).toBe(true);
    }
    const observed: Array<{ prompt: string; output: ReplySpeechPresentationSource | undefined }> =
      [];
    q.start(async (queued) => {
      observed.push({ prompt: queued.prompt, output: queued.speechPresentation });
    });
    await Promise.all(settlements.map((settlement) => settlement.promise));
    expect(observed).toEqual([
      {
        prompt: "[Queued messages while agent was busy]\n\n---\nQueued #1\nspeech 0",
        output: outputs[0],
      },
      {
        prompt: "[Queued messages while agent was busy]\n\n---\nQueued #1\nspeech 1",
        output: outputs[1],
      },
    ]);
    for (const output of outputs) expect(output.openRun).not.toHaveBeenCalled();
  });

  it("retains the original speech source through preprocessing and overflow retry", () => {
    const output = speechSource();
    const options: InternalGetReplyOptions = { speechPresentation: output };
    const prepared = prepareInternalGetReplyOptions(options);
    options.speechPresentation = speechSource();
    expect(prepared?.speechPresentation).toBe(output);
    const queued = createQueueTestRun({ prompt: "request" });
    queued.speechPresentation = output;
    expect(createOverflowSummaryRetrySource(queued).speechPresentation).toBe(output);
  });

  it("rejects a swapped speech output during native delivery preparation", async () => {
    const queued = createQueueTestRun({ prompt: "request" });
    queued.speechPresentation = speechSource();
    const prepared = await prepareNextDeliveryGroup(
      () => [queued],
      () => {},
    );
    queued.speechPresentation = speechSource();
    expect(() => prepared.assertCurrent()).toThrow("Queued delivery source changed");
  });
});
