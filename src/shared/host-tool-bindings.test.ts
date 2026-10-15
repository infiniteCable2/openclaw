import { describe, expect, it } from "vitest";
import {
  describeToolBindings,
  registerHostToolBinding,
  snapshotToolBindings,
} from "./host-tool-bindings.js";

describe("native host tool bindings", () => {
  it("retains only admitted immutable capabilities and snapshots ordinary data", () => {
    let closed = false;
    const source = Object.freeze({
      read() {
        if (closed) {
          throw new Error("source closed");
        }
        return "frame";
      },
    });
    registerHostToolBinding(source);
    const browser = { target: { id: "first" } };
    const input = { video_inspect: source, browser };
    const snapshot = snapshotToolBindings(input)!;
    expect(snapshot.video_inspect).toBe(source);
    expect(snapshot.browser).toEqual(browser);
    expect(snapshot.browser).not.toBe(browser);
    browser.target.id = "second";
    expect(snapshot.browser).toEqual({ target: { id: "first" } });
    expect(source.read()).toBe("frame");
    closed = true;
    expect(() => (snapshot.video_inspect as typeof source).read()).toThrow("source closed");
    expect(() => registerHostToolBinding({})).toThrow("immutable");
    expect(() => snapshotToolBindings({ forged: Object.freeze({ read() {} }) })).toThrow();
    expect(snapshotToolBindings(undefined)).toBeUndefined();
  });

  it("separates distinct live sources and JSON imitations without serializing closures", () => {
    const first = Object.freeze({ read() {} });
    const second = Object.freeze({ read() {} });
    registerHostToolBinding(first);
    registerHostToolBinding(first);
    registerHostToolBinding(second);
    const identity = describeToolBindings({ video_inspect: first });
    expect(describeToolBindings(snapshotToolBindings({ video_inspect: first }))).toEqual(identity);
    expect(describeToolBindings({ video_inspect: second })).not.toEqual(identity);
    expect(describeToolBindings({ video_inspect: identity })).not.toEqual(identity);
    expect(() => structuredClone(identity)).not.toThrow();
    expect(describeToolBindings({ b: 2, a: 1 })).toEqual(describeToolBindings({ a: 1, b: 2 }));
  });
});
