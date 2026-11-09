import { describe, expect, it } from "vitest";
import { bindRequesterProfile } from "../auto-reply/requester-profile.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import {
  isSessionPersonalBootstrapTurn,
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

  it("does not infer native participant proof from sender, owner allowlist or display fields", () => {
    expect(
      readSessionConversationParticipant({
        SenderId: profile.id,
        SenderName: "Example person",
        OwnerAllowFrom: [profile.id],
      }),
    ).toBeUndefined();
  });

  it("does not turn an internal event into an external person just because it retains context", () => {
    const ctx: SessionParticipantInputContext = { InternalTurnSource: "event" };
    prepareSessionParticipantInput(ctx, profile);
    expect(readSessionConversationParticipant(ctx)).toBeUndefined();
  });

  it("declines an inter-session handoff even when original native participant facts remain", () => {
    const ctx: SessionParticipantInputContext = {
      InputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    };
    prepareSessionParticipantInput(ctx, profile);
    expect(readSessionConversationParticipant(ctx)).toBeUndefined();
  });
});

it("uses the session selection for qualified humans and internal continuations only", () => {
  const human: SessionParticipantInputContext = {};
  prepareSessionParticipantInput(human, { type: "profile", id: "participant" });
  for (const ctx of [
    human,
    { InputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" } },
    { InputProvenance: { kind: "internal_system", sourceTool: "goal_continue" } },
    { InternalTurnSource: "cron", SessionKey: "agent:main:conversation" },
  ] satisfies SessionParticipantInputContext[]) {
    expect(isSessionPersonalBootstrapTurn(ctx)).toBe(true);
  }
  expect(
    isSessionPersonalBootstrapTurn({
      ChatType: "group",
      SenderId: "unqualified-participant",
      InputProvenance: { kind: "external_user" },
    }),
  ).toBe(false);
  expect(
    isSessionPersonalBootstrapTurn({
      SessionKey: "agent:main:cron:isolated:run:synthetic",
      InputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    }),
  ).toBe(false);
});

it.each(["valid", "stale", "mixed-profile", "observation", "retargeted"] as const)(
  "unifies dual native attribution only for a live verified requester: %s",
  (state) => {
    const ctx: SessionParticipantInputContext = {
      SenderId: remote.id,
      AccountId: "default",
      OriginatingChannel: "example-chat",
    };
    prepareSessionParticipantInput(ctx, remote);
    prepareSessionParticipantInput(ctx, profile);
    bindRequesterProfile(ctx, {
      id: profile.id,
      displayName: null,
      isCurrent: () => state !== "stale",
    });
    if (state === "mixed-profile") {
      prepareSessionParticipantInput(ctx, { type: "profile", id: "other-person" });
    }
    if (state === "observation") {
      prepareSessionParticipantInput(ctx, {
        type: "observation",
        pluginId: "example-chat",
        accountId: "default",
        senderKind: "unknown",
        id: "other-sender",
      });
    }
    if (state === "retargeted") {
      ctx.SenderId = "other-sender";
    }
    expect(readSessionConversationParticipant(ctx)).toEqual(
      state === "valid" ? profile : undefined,
    );
  },
);
