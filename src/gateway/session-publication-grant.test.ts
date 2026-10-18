import { describe, expect, it } from "vitest";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { prepareSessionPublicShareGrant } from "./session-publication-grant.js";

describe("session publication grants", () => {
  it("never publishes a consolidating root, including one carrying a preexisting token", () => {
    const entry: InternalSessionEntry = {
      sessionId: "root",
      updatedAt: 1,
      conversationTopology: { version: 1, role: "root" },
    };
    expect(() => prepareSessionPublicShareGrant(entry, "agent:example:main")).toThrow(
      "root cannot be published",
    );
    entry.publicShare = { id: "a".repeat(48), sessionId: "root", createdAt: 1 };
    expect(resolveSessionPublicShare(entry)).toBeUndefined();
    expect(() => prepareSessionPublicShareGrant(entry, "agent:example:main")).toThrow(
      "root cannot be published",
    );
  });

  it("preserves native publication of an ordinary branch and reuses its existing grant", () => {
    const entry: InternalSessionEntry = {
      sessionId: "branch",
      updatedAt: 1,
      conversationTopology: {
        version: 1,
        role: "branch",
        rootSessionKey: "agent:example:main",
        rootSessionId: "root",
        rootSessionLifecycleRevision: "root-lifecycle",
      },
    };
    const grant = prepareSessionPublicShareGrant(entry, "agent:example:matrix:direct:peer");
    expect(grant).toMatchObject({
      sessionId: "branch",
      id: expect.stringMatching(/^[a-f0-9]{48}$/),
    });
    entry.publicShare = grant;
    expect(prepareSessionPublicShareGrant(entry, "agent:example:matrix:direct:peer")).toEqual(
      grant,
    );
  });

  it("retains the native Incognito refusal", () => {
    expect(() =>
      prepareSessionPublicShareGrant(
        { sessionId: "private", updatedAt: 1, incognito: true },
        "agent:example:private",
      ),
    ).toThrow("Incognito sessions cannot be published");
  });
});
