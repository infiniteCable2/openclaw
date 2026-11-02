import { describe, expect, it } from "vitest";
import { IdentitySchema } from "./zod-schema.core.js";

describe("identity language config", () => {
  it.each([
    ["de-de", "de-DE"],
    [" EN-us ", "en-US"],
    ["fr-CA", "fr-CA"],
    ["zh-hant-tw", "zh-Hant-TW"],
  ])("canonicalizes %s while retaining valid unsupported languages", (input, expected) => {
    expect(IdentitySchema.parse({ language: input })?.language).toBe(expected);
  });

  it.each(["", "de DE", "de_DE", "de-DE.UTF-8", "en--US"])("rejects invalid tag %s", (language) => {
    expect(IdentitySchema.safeParse({ language }).success).toBe(false);
  });

  it("keeps existing identity and absent language configs unchanged", () => {
    expect(IdentitySchema.parse({ name: "Example" })).toEqual({ name: "Example" });
    expect(IdentitySchema.parse(undefined)).toBeUndefined();
  });
});
