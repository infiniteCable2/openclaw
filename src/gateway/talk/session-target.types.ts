// Keep shared Talk identity independent of the storage runtime used to prepare it.
/** Selected by the host's method owner, never by wire parameters. */
export type TalkSessionTargetPurpose = "conversation-input" | "settlement" | "address-resolution";

export type PreparedTalkSessionTarget = Readonly<{
  agentId: string;
  /** Voice records and close/resume retain the client's exact key, not its storage alias. */
  sessionKey: string;
  canonicalKey: string;
  storePath: string;
}>;
