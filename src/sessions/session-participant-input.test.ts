import { describe, expect, it } from "vitest";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import {
  captureConsistentConversationParticipant,
  prepareSessionParticipantInput,
  readSessionConversationParticipant,
  type SessionParticipantInputContext,
} from "./session-participant-input.js";

const profile = { type: "profile", id: "example-person" } as const;
const remote = {
  type: "remote",
  pluginId: "example-chat",
  domain: "example.org",
  idKind: "user",
  id: "remote-person",
} as const;

describe("original native conversation participant snapshot", () => {
  it("copies and freezes one consistent original profile without selecting the session owner", () => {
    const ctx: SessionParticipantInputContext = {};
    const original: SessionParticipantIdentity = { ...profile };
    prepareSessionParticipantInput(ctx, original);
    prepareSessionParticipantInput(ctx, { ...profile });
    const snapshot = readSessionConversationParticipant(ctx);
    original.id = "changed-later";
    expect(snapshot).toEqual(profile);
    expect(snapshot).not.toBe(original);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("retains all original remote qualification instead of comparing bare sender IDs", () => {
    const ctx: SessionParticipantInputContext = {};
    prepareSessionParticipantInput(ctx, remote);
    expect(readSessionConversationParticipant(ctx)).toEqual(remote);
    expect(
      captureConsistentConversationParticipant([remote, { ...remote, domain: "other.example" }]),
    ).toBeUndefined();
  });

  it.each([
    [],
    [profile, undefined],
    [profile, { ...profile, id: "another-person" }],
    [profile, remote],
    [{ type: "agent", id: "example-agent" }],
    [{ type: "legacy", actorType: "human", source: "example", id: "example-person" }],
    [
      {
        type: "observation",
        pluginId: "example-chat",
        accountId: "example-account",
        senderKind: "human",
        id: "example-person",
      },
    ],
    [{ ...remote, domain: "" }],
    [{ ...remote, idKind: " " }],
  ] satisfies Array<Array<SessionParticipantIdentity | undefined>>)(
    "declines absent, mixed or unqualified input facts (%j)",
    (...identities) => {
      expect(captureConsistentConversationParticipant(identities)).toBeUndefined();
    },
  );

  it("does not infer native participant proof from sender, owner or display fields", () => {
    expect(
      readSessionConversationParticipant({ SenderId: profile.id, SenderIsOwner: true }),
    ).toBeUndefined();
  });

  it("does not turn an internal event into an external person just because it retains context", () => {
    const ctx: SessionParticipantInputContext = { InternalTurnSource: "event" };
    prepareSessionParticipantInput(ctx, profile);
    expect(readSessionConversationParticipant(ctx)).toBeUndefined();
  });

  it("declines a non-external continuation even when original native participant facts remain", () => {
    const ctx: SessionParticipantInputContext = { InputProvenance: { kind: "continuation" } };
    prepareSessionParticipantInput(ctx, profile);
    expect(readSessionConversationParticipant(ctx)).toBeUndefined();
  });
});
