import { describe, expect, it } from "vitest";
import { resolveMatrixSenderParticipant } from "./sender-identity.js";

describe("SDK Matrix sender product identity", () => {
  it.each([
    ["@Alice:example.test", "example.test"],
    ["@alice:example.test:8448", "example.test:8448"],
    ["@alice:[2001:db8::1]:8448", "[2001:db8::1]:8448"],
  ])("preserves the full SDK identity %s without guessing a local profile", (id, domain) => {
    expect(resolveMatrixSenderParticipant({ stableId: id })).toEqual({
      domain,
      idKind: "user-id",
      id,
    });
  });

  it.each([
    undefined,
    null,
    123,
    "",
    "Alice",
    "@alice",
    "@:example.test",
    "@alice:",
    " @alice:example.test",
    "@alice:example.test ",
    "matrix:@alice:example.test",
    "user:@alice:example.test",
    "!room:example.test",
    "*",
    "@alice:example.test/path",
    "@alice:example.test?query",
    "@alice:example.test#fragment",
    "@alice:user@example.test",
    "@alice:example.test:invalid",
    "@alice:[broken",
    "@alice:example.test\n",
  ])("does not turn an alias, missing value or invalid sender into a person: %s", (stableId) => {
    expect(resolveMatrixSenderParticipant({ stableId })).toBeUndefined();
  });

  it("does not merge case-distinct Matrix users", () => {
    expect(resolveMatrixSenderParticipant({ stableId: "@Alice:example.test" })).not.toEqual(
      resolveMatrixSenderParticipant({ stableId: "@alice:example.test" }),
    );
  });
});
