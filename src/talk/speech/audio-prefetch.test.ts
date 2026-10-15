import { describe, expect, it } from "vitest";
import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import { createSpeechAudioPrefetch } from "./audio-prefetch.js";

describe("speech audio prefetch reservoir", () => {
  it("shares the two-block duration budget across streams and resumes a waiting producer", async () => {
    const prefetch = createSpeechAudioPrefetch(2);
    const first = prefetch.createChannel(new AbortController().signal);
    const second = prefetch.createChannel(new AbortController().signal);
    await first.push(Buffer.alloc(12, 1));
    await second.push(Buffer.alloc(12, 2));
    const resumed = createDeferred();
    const third = second.push(Buffer.alloc(12, 3)).then(() => resumed.resolve());
    expect(await first.read()).toEqual({ done: false, value: Buffer.alloc(12, 1) });
    await resumed.promise;
    expect(await second.read()).toEqual({ done: false, value: Buffer.alloc(12, 2) });
    expect(await second.read()).toEqual({ done: false, value: Buffer.alloc(12, 3) });
    await third;
    first.close();
    second.close();
  });

  it("slices a long frame without dropping samples or admitting a third queued block", async () => {
    const channel = createSpeechAudioPrefetch(2).createChannel(new AbortController().signal);
    const source = Buffer.from(Array.from({ length: 30 }, (_, index) => index));
    const pushing = channel.push(source);
    const actual: Uint8Array[] = [];
    for (let index = 0; index < 3; index += 1) {
      const chunk = await channel.read();
      if (!chunk.done) {
        actual.push(chunk.value);
      }
    }
    await pushing;
    channel.finish();
    expect(actual.map((chunk) => chunk.byteLength)).toEqual([12, 12, 6]);
    expect(Buffer.concat(actual)).toEqual(source);
    expect(await channel.read()).toEqual({ done: true, value: undefined });
    channel.close();
  });

  it("discards buffered audio on abort even after natural EOF", async () => {
    const controller = new AbortController();
    const channel = createSpeechAudioPrefetch(2).createChannel(controller.signal);
    await channel.push(Buffer.alloc(12));
    channel.finish();
    controller.abort();
    expect(await channel.read()).toEqual({ done: true, value: undefined });
  });

  it("wakes a producer blocked on the shared budget when its channel is aborted", async () => {
    const prefetch = createSpeechAudioPrefetch(2);
    const controller = new AbortController();
    const channel = prefetch.createChannel(controller.signal);
    await channel.push(Buffer.alloc(12));
    await channel.push(Buffer.alloc(12));
    const blocked = channel.push(Buffer.alloc(12));
    const rejection = expect(blocked).rejects.toThrow();
    controller.abort();
    await rejection;
    expect(await channel.read()).toEqual({ done: true, value: undefined });
    const successor = prefetch.createChannel(new AbortController().signal);
    await successor.push(Buffer.alloc(12));
    successor.close();
  });

  it("does not append audio when abort races an immediately available capacity receipt", async () => {
    const controller = new AbortController();
    const channel = createSpeechAudioPrefetch(2).createChannel(controller.signal);
    const pushing = channel.push(Buffer.from([1, 2]));
    const rejected = expect(pushing).rejects.toThrow();
    controller.abort();
    await rejected;
    expect(await channel.read()).toEqual({ done: true, value: undefined });
  });

  it("delivers already buffered audio before the ordered source failure", async () => {
    const channel = createSpeechAudioPrefetch(2).createChannel(new AbortController().signal);
    await channel.push(Buffer.from([1, 2]));
    const failure = new Error("synthetic provider failure");
    channel.finish({ error: failure });
    channel.finish();
    expect(await channel.read()).toEqual({ done: false, value: Buffer.from([1, 2]) });
    await expect(channel.read()).rejects.toBe(failure);
    channel.close();
  });

  it("rejects an oversized provider frame before buffering it", async () => {
    const channel = createSpeechAudioPrefetch(48_000).createChannel(new AbortController().signal);
    await expect(channel.push(Buffer.allocUnsafe(32 * 1024 * 1024 + 1))).rejects.toThrow(
      "Speech provider audio frame exceeds the prefetch limit",
    );
    channel.close();
    expect(await channel.read()).toEqual({ done: true, value: undefined });
  });
});
