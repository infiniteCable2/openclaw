---
summary: "How OpenClaw manages conversation sessions"
read_when:
  - You want to understand session routing and isolation
  - You want to configure DM scope for multi-user setups
  - You are debugging daily or idle session resets
title: "Session management"
---

OpenClaw routes every inbound message to a **session** based on where it came
from: DMs, group chats, cron jobs, etc. All session state is owned by the
**gateway**; UI clients query the gateway for session data.

To continue the same Gateway-owned session in the Control UI, terminal, or a
coding harness, see [Session synchronization and attachment](/concepts/session-attachment).

For the personal-agent default — one rolling conversation shared by all your
DM channels, with group activity and background work flowing into it — see
[The main session](/concepts/main-session).

## How messages are routed

| Source          | Behavior                      |
| --------------- | ----------------------------- |
| Direct messages | Shared session by default     |
| Group chats     | Isolated per group by default |
| Rooms/channels  | Isolated per room by default  |
| Cron jobs       | Fresh session per run         |
| Webhooks        | Isolated per hook             |

Native catalog source IDs, Matrix room and thread IDs, and Signal group IDs are
case-sensitive: IDs that differ only by case identify different conversations.

With `session.scope: "global"`, the selected agent still owns its session.
The shared key `global` does not merge different agents' conversations:
commands, skills, replies, and background task notifications retain the
agent selected by the route or explicit request.
Session lists, model filters, previews, and sharing controls also retain the
stored conversation's agent, rather than the aggregate view's default agent.
Renaming, pinning, or editing session metadata retains the existing message
preview without rereading the transcript. New messages, transcript replacements,
and completed transcript repairs refresh previews; changes to model selection
or fallback state refresh the relevant model facts.
Stopping with `/stop`, deleting, resetting, or archiving a session cancels only that agent's work for
the selected conversation. Another agent's active turn and queued messages are
preserved even when the agents use the same session key.

## Conversation branches

`agents.entries.<agentId>.conversationMode` selects conversation organization:

- `native` (default) keeps the normal channel routing and session-scope settings.
- `branches` uses a separate internal headless consolidation root.
  Direct conversations use separate account/channel/peer branches; groups remain
  separate. A direct audio connection is a conversation branch, not a task
  sub-agent, and does not acquire sub-agent tool restrictions or a parent read grant.

```json5
{
  agents: {
    entries: {
      researcher: { conversationMode: "branches" },
    },
  },
}
```

The internal root has a stable key independent of `session.mainKey`. Native main
keys, session IDs, histories, delivery addresses, and CLI bindings are not renamed
or moved. The root cannot accept external input, run a model, or serve as a reply
address. The mode cannot use `session.scope: "global"`; choosing the reserved
internal root as the native main key is rejected.

Branches currently require a dedicated physical session database owned by the
corresponding agent. Before startup maintenance or root creation, the Gateway
rejects a branch whose database belongs to another agent or resolves to the same
physical file as another configured agent, including a native-mode agent or a
directory alias. Omit `session.store` to use the default per-agent layout, or
configure dedicated agent-owned stores. A fixed selector that natively partitions
agents into different database files remains supported. This check does not move
or merge history; changing a populated store location requires the normal explicit
data migration. Fully native shared-store configurations remain unchanged.

Changing the mode uses the existing Gateway restart/drain boundary, not a hot
switch underneath an accepted turn. Startup admits the root before channels
become ready. Existing conversations are enrolled through a separate exact-row
native lifecycle operation, never an ordinary metadata merge. Enrollment changes
only membership, not history, ownership, or permissions. The existing native main
is admitted at startup; other existing conversations are admitted when their
authorized ingress selects them. Missing lifecycle facts or conflicting root
incarnations require explicit repair instead of silent adoption.

An initial bounded history seed records only proven completed native exchanges
and committed realtime utterances as opaque references. It never invents missing
completion evidence, a speaker identity, or permission to disclose the history.
An interrupted seed can resume through its existing native receipts. Oversized or
changed source prefixes are not acknowledged as complete.

Switching back to `native` restores normal routing and leaves the internal root
separate. Previously enrolled native conversations may catch up authorized
branch-origin contributions; they do not automatically share newly produced
native dialogue with one another. Their committed original messages can publish passive
native-origin references, so re-enabling `branches` can catch up the intervening
native work. Source mode is captured from the admitted turn, not guessed at
settlement. Existing packet progress deduplicates repeated switches. A root's
mere existence grants neither enrollment authority nor cross-conversation access.

Private visibility is independent of conversation mode. When the original ingress
proves the private recipient of a new conversation, creation stores native `draft`
visibility in both modes. It remains private through `/new` and later mode changes;
switching modes does not reset visibility or rewrite the transcript. Existing
shared or unconfirmed histories keep their policy and require an explicit,
verified privacy change before receiving private differences. A current private
message does not retroactively attest an older conversation's audience.

<Warning>
Upgrading to this branch does not migrate legacy visibility. Private cross-branch
context will remain unavailable for affected existing conversations until their
audience is verified and native visibility is explicitly changed to `draft`.
Do not bulk-convert shared or unconfirmed sessions. TODO: add a Doctor check and
an opt-in, evidence-backed migration that preserves histories and participants.
</Warning>

Branches remain independent native session lanes. Concurrent inputs to one branch
use the existing queue/steering policy; separate branches may work concurrently.
Stopping audio cancels playback, not an already accepted agent task. Subsequent
spoken input is persisted through native reply admission; a late transcript
cannot steer a replacement backend merely because its session key matches.

Each eligible original user message and saved assistant text message is journaled
with its native transcript append. Publication starts asynchronously after commit,
without waiting for the answer or task to finish. A steered input retains its own
original admission rather than borrowing the running input's audience. The root
records bounded, text-free `utterance-observation` references to exact committed
occurrences. These quote saved dialogue, including commentary, not streamed tokens,
hidden reasoning, consultation prompts or tool payloads; an intention is not proof
that an action completed. Provider-owned realtime voice uses the same observation
contract. An eligible private sibling can receive bounded, quoted differences at
its next natural model step. Historical completed-turn receipts remain readable
and quote only their validated exchanges; new terminal settlement does not publish
another copy of messages already journaled independently.
The two reference kinds use separate progress frontiers and deduplicate within
their actual source incarnation and transcript generation. The root stores
neither dialogue text nor fabricated model turns.

An exact-row transcript rewrite can renew the physical read anchors of an
earlier, unchanged contribution in the same native worker transaction. The
original occurrence, private admission, packet IDs, and progress frontiers stay
unchanged, so already admitted observations are not copied again. Renewal requires
an unbroken generation chain and unchanged native interval boundaries; a rewrite
inside the contributed range, a replaced source, or an already stale reference
does not acquire continuity merely because its message IDs still exist. Existing
live audience and read-permission checks remain mandatory. Legacy synchronous
writers retain conservative invalidation rather than doing additional background
publication work on the Gateway main thread.

An active native turn also retains committed continuity for its original user
admission when a later metadata-only rewrite preserves the active projection.
Only an exact previous-generation mapping for an unchanged earlier row can
advance that admission. Steering another input cannot silently invalidate the
original turn's next terminal; overlapping edits, missing mappings, revoked
authority, compaction, and reset still retain their normal fences. The temporary
subscription ends with the original run.

The central embedded Reply path catches up a fixed prefix of all eligible root
references, not just the latest four sources. It copies quoted observations into
the recipient's native transcript in bounded packets. Each packet records its
source occurrence and exact content offset; a partial packet never acknowledges
the whole contribution. Cancellation can therefore resume from durable progress
without duplicating admitted packets. Progress means that text was admitted,
not that a model understood every fact or executed an action.

In branch mode, opening an authorized private conversation starts background
catch-up without manufacturing a user input. Committed root updates wake its
existing database-lifetime owner; notifications carry no dialogue or read permission.
Source read-ahead is coalesced and read-only. Disposable caches are bounded;
evicting cached bytes does not unregister an open recipient or acknowledge unread data.

An idle recipient uses native session maintenance and its exclusive session lane
to retain missing observations in chronological order. Scheduling quanta yield
execution but do not limit total catch-up or require another interaction. Native
context admission and prospective token accounting decide when a summary is
needed; only the native compaction owner may compact. Catch-up creates no user
turn, answer, tool action, or delivery. Current writer absence/presence, lifecycle,
audience and source ranges are revalidated at native commits. Foreground work
preempts optional idle maintenance and waits for its actual writer settlement;
durable packet progress lets idle work resume without replaying committed additions.

An existing embedded model request may consume ready observations, including at
the next natural model step after tools. It does not wait for full freshness or
uncached source hydration. Fresh native source/recipient authorization and exact
range validation precede each durable packet write under the current writer.
Append-only source growth uses native prefix proof; replacement, reset, and
rewritten navigation remain fenced. Native prospective token accounting preserves
the current request and response reserve. If an addition does not fit, it remains
pending until native preflight or idle maintenance can make room; this live boundary
never starts compaction, restarts generation, or creates a turn. There is no fixed
eight-packet admission limit. Already admitted packets retain their positions during retries
and live steering. New observations are quoted data, not new instructions or
permission to repeat tools.
They can inform subsequent model decisions within the existing task; provenance
does not make them semantically inert or authorize a different task.

Ordinary reply preflight, authority checks, and native compaction remain in charge
of the actual dialogue. Previously enrolled native-mode continuity retains its
existing pre-hydration maintenance path. As with normal session compaction, a
summary is a lossy model interpretation, not lossless retention of every detail.
Exact source history keeps its current read grants.
Already admitted observations are recipient history and are never recopied merely
because they left the active context. Native context metadata distinguishes
summarized ancestors from active carriers that still need hydration checks, even
on a later turn with no new contributions. One deferred contribution does not
prevent independent later contributions from being admitted.

A reset/replaced source is not silently treated as its previous incarnation.
An exact source range that is no longer projectable is not marked consumed.
Supplementary-history status stays in operational debug logs, never in model
context or transcripts. Bounded diagnostics record closed reason codes, counts
and hashed recipient/source references without dialogue text. Old unverified
ranges need source revalidation, not a promise of success next turn. Missing
reads, changed generations and denied access do not prove permanent data loss.
This does not reconstruct deleted history.

Only native final-archive pruning can retire an irrecoverable source obligation:
the worker compares the complete selected archive metadata, confirms the exact
derived file is absent, and excludes hot, cold, and other canonical copies. In
the same transaction it records generation-bound loss evidence on the existing
root references. Original source identity, private admission, read ranges, and
recipient progress remain unchanged; retirement is not delivery. A malformed
existing root refuses deletion rather than losing the only proof. Ordinary
native-mode agents need not have a root. Synchronous legacy maintenance does not
infer retirement, and historical missing reads remain conservative. No history
or imported recipient content is deleted by this reference repair.

Read-only snapshots, including provider-owned realtime startup and direct CLI
candidates, remain bounded without model-facing coverage notices. They do not claim the
embedded path's durable automatic catch-up.

Projection excludes imported knowledge carriers, history-tool result bodies and
native inter-session or internal-system user messages. Reading or forwarding
another branch's text therefore does not automatically publish that text as new
original user dialogue. Genuine user repetitions and actual assistant replies
remain dialogue: semantic paraphrases are not silently removed by text matching.

Original live read permissions, source incarnation, and target audience
must all remain valid. Root membership is not authorization. Shared, unidentified,
or group audiences do not automatically receive private context. In particular,
a paired room device authenticates the device, not the person speaking nearby.
Automatic private context also requires the same verified native participant
identity in the actual incoming request and both conversations. For eligible
enrolled conversations, a narrow personal permission can read bounded differences
under the same agent and consolidation root, subject to the selected mode's
source filter; it does
not require an operator history scope. This permission does not authorize
`chat.history`, `sessions_history`, another agent, or a shared/group audience.
The original input source and native audience facts remain live throughout the
read and its consuming turn. Explicit operator-authorized history reads keep their own
scope, sharing policy, and lifetime. An administrator's ability to inspect another person's history does
not make that person's dialogue part of the current speaker's context. Missing
identity or an applicable read permission is reported as unavailable, not replaced by system
access or inferred from a matching device, agent, or display name.
Automatic difference context never substitutes operator scope for a missing
original participant, even when the caller is an administrator.

A current private recipient can be proved by the original native ingress without
reinterpreting historical participant rows. Matrix checks the actual private room
state independently of its channel routing; personal browser Chat and Talk bind
the original authenticated profile and retained native operator authority to the
exact private target. A generic authenticated connection, administrator, shared
device, or public target is insufficient. Internal agent bookkeeping alone does
not revoke this separately proved audience; another person, observation, sharing
change, or replaced session still invalidates a held read.

Only future accepted contributions receive this additional provenance, with an
exact lower transcript boundary. Older unconfirmed dialogue remains stored but is
not automatically promoted into privately readable history. Normal audio hangup
does not undo already accepted work; actual recipient or authority revocation
still prevents additional disclosure. A Gateway restart discards live proofs,
not history or saved references; the next verified ingress obtains a new proof.

A new provider-owned voice branch is natively materialized before its authorized
startup snapshot. When its original personal recipient is proved, that snapshot
can include readable sibling context before the first utterance. Startup does not
manufacture an initial user turn or contribution. Each future accepted provider
utterance is independently qualified and references only its exact saved event;
replayed old events do not acquire new provenance.
Legacy transcript clients without an original native session-incarnation binding
continue to save dialogue, but do not manufacture this additional private proof
from the current session key.
The central native Reply path joins its already accepted participant recording
before preparing difference context for the first real turn. Provider-owned
voice receives a startup snapshot and refreshes on actual consultations, not
continuous synchronization of an external provider's conversation.

This is not a live transcript merge: updates do not rewrite past messages, become
new user instructions, cancel running work, or repeat completed tools. Native
session history/search tools remain the explicit way to inspect permitted live
work or additional source detail. Tool-backed delegated jobs and scheduled work
retain their native task and delivery owners.

Provider-native realtime dialogue receives a separately authorized startup snapshot
and fresh related context during an actual agent consult. It does not have an
automatic continuous cross-branch provider-context update port. These observations
are not injected as new user messages or model work.

Use [conversation tools](/concepts/session-tool#sessions-versus-conversations) to discover
durable delivery addresses and authorized active connections. A context session,
an external chat address, and a temporary audio connection are different things;
none is a substitute for the others.

## DM isolation

By default, all DMs share one session for continuity, which is fine for
single-user setups.

<Warning>
If multiple people can message your agent, enable DM isolation. Without it, all
users share the same conversation context, so Alice's private messages would be
visible to Bob.
</Warning>

```json5
{
  session: {
    dmScope: "per-channel-peer", // isolate by channel + sender
  },
}
```

`session.dmScope` options:

| Value                      | Behavior                                                 |
| -------------------------- | -------------------------------------------------------- |
| `main` (default)           | All DMs share the [main session](/concepts/main-session) |
| `per-peer`                 | Isolate by sender, across channels                       |
| `per-channel-peer`         | Isolate by channel + sender (recommended)                |
| `per-account-channel-peer` | Isolate by account + channel + sender                    |

Slack Agent View and Assistant View DMs are the exception: each visible root gets
its own `:thread:<rootTs>` session on top of the base that `dmScope` selects, so
those conversations stay isolated even under `main`. See
[Agent View DMs](/channels/slack/threads-and-sessions#agent-view-dms).

<Tip>
If the same person contacts you from multiple channels, use
`session.identityLinks` to map their identities to one canonical peer id so
they share a session.
</Tip>

Verify your setup with `openclaw security audit`.

## Retired channel docking

Channel docking and manual cross-channel reply focus have been removed. The
`/dock-*` commands no longer move a session's reply destination to another
channel.

Use `session.identityLinks` to associate a person's identities for DM session
routing, or [thread-bound sessions](/tools/subagents#thread-bound-sessions) to
keep a supported conversation attached to a subagent. These are separate
features; neither restores manual cross-channel docking.

## Group and room routing

`session.groupScope` controls where non-direct peers store conversation
context:

| Value                 | Behavior                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `per-group` (default) | Keep each group, room, or channel in its existing channel-scoped session                  |
| `main`                | Route groups, rooms, and channels into the agent's [main session](/concepts/main-session) |

A route binding can override the global value. This is useful when only a
named team room should join the main conversation:

```json5
{
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "slack",
        peer: { kind: "channel", id: "C0123TEAM" },
      },
      session: { groupScope: "main" },
    },
  ],
}
```

Use `peer.kind: "group"` for providers that classify the room as a group.
The binding override wins over global `session.groupScope`. This setting
changes session-key selection only: DM routing, mention gating, delivery
context, and replies to the source room remain unchanged.

## Incognito sessions

Incognito sessions are available only from the Control UI's **New thread** screen. Turn on **Incognito** before starting the thread to keep its session entry, transcript, and compaction state in process memory instead of on disk. The thread expires 24 hours after creation or when the Gateway restarts, whichever comes first. Activity does not extend its lifetime. Expiry stops active work and deletes the session and transcript without an archive. Incognito does not run OpenClaw's automatic memory flush, and does not create a transcript archive when you reset or delete it. Codex-backed runs also start their harness thread in ephemeral mode, so Codex writes no rollout or local session-state files; other model providers use HTTP APIs and keep no local provider transcript in OpenClaw.

Delegated work uses its native execution and completion owners. Live subagent activity and completion delivery remain available.

The `incognito-` segment is reserved for dashboard, subagent, and hidden internal session keys; `openclaw doctor --fix` renames any colliding legacy durable keys.

Incognito does not restrict the agent's normal tools. An explicit request to save information, or any tool-driven file write, can still persist data outside the incognito session store. Your configured model provider still processes the messages you send. Incognito content is excluded from ordinary Gateway output, delivery and response diagnostics, WebSocket event previews, raw-stream, cache-trace, and Anthropic payload logs. Live replies remain available, and OpenClaw still records operational diagnostics and content-free audit metadata such as HMAC references.

On multi-user gateways, incognito threads are visible only to admin-scope connections and never appear through another session's agent session tools or transcript search. This protects them from storage and other gateway-mediated users, not from the gateway owner or process operator, who can always observe live sessions.

## Remember across conversations

Separate transcripts control each conversation's local history. For a personal
or fully trusted agent, `memory.search.rememberAcrossConversations: true`
adds an optional retrieval step across that agent's other private
conversations; it does not combine their transcripts.

Private direct and persistent explicit UI conversations can supply relevant
context to one another. Under default `session.groupScope: "per-group"`, groups and channels stay separate in both directions:
their transcripts are not private recall sources, and replies in those
conversations do not receive private transcript context. The current
conversation is also excluded because its history is already loaded.

This setting does not change session keys, DM scope, routing, delivery, or
`tools.sessions.visibility`. Shared workspace memory in `MEMORY.md` and
`memory/*.md` also keeps its existing behavior. The current memory provider
must support protected private transcript recall; context engines such as
Lossless Claw remain independent and can run alongside it. See
[Active Memory](/concepts/active-memory#remember-across-conversations) for setup
and runtime details.

## Session lifecycle

Sessions are reused until you reset them manually or opt into an automatic reset policy:

- **No automatic reset** (default `mode: "none"`) - sessions keep the same
  `sessionId`; compaction manages the active context as the conversation grows.
- **Daily reset** (`mode: "daily"`) - opt into a new session at a configured local
  hour (`session.reset.atHour`, default `4`, 0-23) on the gateway host. Daily
  freshness is based on when the current `sessionId` started, not on later
  metadata writes.
- **Idle reset** (`mode: "idle"`) - opt into a new session after `session.reset.idleMinutes`
  of inactivity. Idle freshness is based on the last real user/channel
  interaction, so heartbeat, cron, and exec system events do not keep the
  session alive.
- **Manual reset** - type `/new` or `/reset` in chat. `/new <model>` also
  switches the model.

When both daily and idle resets are configured, whichever expires first wins.
Heartbeat, cron, exec, and other system-event turns may write session metadata,
but those writes do not extend daily or idle reset freshness. When a reset
rolls the session, queued system-event notices for the old session are
discarded so stale background updates are not prepended to the first prompt in
the new session.

Sessions with an active provider-owned CLI session follow the same no-automatic-reset
default. Use `/reset` or configure `session.reset` explicitly when those sessions
should expire on a timer.

Opt into automatic resets globally, then override them per chat type or channel:

```json5
{
  session: {
    reset: { mode: "daily", atHour: 4 },
    resetByType: {
      group: { mode: "idle", idleMinutes: 120 },
      thread: { mode: "daily", atHour: 6 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
  },
}
```

`resetByType` supports `direct`, `group`, and `thread`. Doctor migrates legacy `dm` entries to `direct` and `session.idleMinutes` to `session.reset.idleMinutes`; the schema rejects both retired forms.

## Gateway restart recovery

When a Gateway restart interrupts an active turn, OpenClaw tries to continue
the existing session automatically. Three attempts that fail to start a backend
turn exhaust the recovery budget. Once a real backend turn starts,
the budget refreshes, so a later Gateway restart does not consume the old allowance.
Accepting, queueing, or preparing a resume request alone does not refresh it.
CLI backends that do not report turn acceptance refresh the budget only after
observed assistant output or tool activity; silent startup does not refresh it.

For a freshly created session's eligible local, idle, restart-safe initial turn,
`sessions.create` commits the session first, then commits the input transcript and
restart claim together before acknowledging a started run. Failure or a crash
between those commits can leave the created session with no retained input bytes.
After the input commits, restart recovery retains that turn even if the client
never receives the acknowledgment. Queued input, hook-dependent input, worker
placement, idle `chat.send`, and retries of existing durable input retain their
existing admission and recovery behavior. A restart
during managed worktree preparation resumes the accepted turn and prepares or
reuses its local worktree before starting the agent. Recovery does not inherit
the original caller's permission to run worktree setup scripts.

When replaying an interrupted turn, recovery preserves its recorded tool calls
and results, including nested tool activity, and reuses the original user message.
A completed reply or a later user message closes that turn to replay.

For authenticated operator turns, recovery revalidates the original caller's
recorded permissions against current profile, role, access-grant, and device
policy. A Control UI administrator can therefore continue authorized automation
work after a restart without losing `operator.admin`. Recovery cannot gain scopes
the original caller lacked, and revocation still stops the recovered run.
Older interrupted turns without a recorded authorization source remain restricted;
send a fresh authenticated message to continue privileged work. Session ownership
or a saved display name never grants recovery permissions.

This also covers parent turns started by subagent completion or pause notices.
An interrupted parent continues independently of later child completions, and a
retry of the same notice joins that recovery instead of starting the turn again.
Parents still waiting after yielding to children remain owned by their child batch.

Messages sent while restart recovery is waiting to start stay pending. Once
recovery starts, they follow the session's normal message queue policy. You do
not need to resend a message just because recovery is waiting for capacity.
Stopping or replacing the session still cancels pending work.

If subagent recovery changes session-protection facts while an incoming turn is
being prepared, reply initialization refreshes those facts and retries within its
existing bounded retry budget. Exhaustion reports an error asking you to retry
the message. A saved user message that has not reached the model remains user
input when a subagent announcement continues the session; it is not demoted to
background context.

If automatic recovery is exhausted, the transcript remains available. Use
**Resume in new session** in WebChat, or `/new` or `/reset` in other channels,
to start a replacement session.

## Where state lives

- **Runtime session rows and transcripts:** `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` by default
- **Archived transcript files:** `~/.openclaw/agents/<agentId>/sessions/`
- **Legacy row migration source:** `~/.openclaw/agents/<agentId>/sessions/sessions.json`

Archive discovery uses the selected store, recorded transcript paths, and agent
directories. The pre-agent `~/.openclaw/sessions/` directory is no longer an
implicit fallback; explicitly configured paths still work.

The session rows in the per-agent SQLite database keep separate lifecycle
timestamps:

- `sessionStartedAt`: when the current `sessionId` began; daily reset uses this.
- `lastInteractionAt`: last user/channel interaction that extends idle lifetime.
- `updatedAt`: last store-row mutation; useful for listing and pruning, but not
  authoritative for daily/idle reset freshness.

To import legacy `sessions.json` rows and hot transcript JSONL history from an
older installation, stop the Gateway, back up its state, and run
`openclaw doctor --fix` before restarting it. Gateway and local CLI startup use
SQLite without importing, restoring, or rewriting legacy session files.
If startup finds a legacy store, it refuses readiness and prints the Doctor
command for the active profile instead of silently starting with empty history.
During Doctor import, rows without `sessionStartedAt` are resolved from the
legacy transcript JSONL session header when available. If an older row also
lacks `lastInteractionAt`, idle freshness falls back to that session start time,
not to later bookkeeping writes. Use `openclaw doctor --session-sqlite inspect
--session-sqlite-all-agents` and the [Doctor migration
sequence](/cli/doctor#session-sqlite-migration) for inspection and validation.

## Session maintenance

OpenClaw bounds session storage over time via `session.maintenance`, defaults
shown:

```json5
{
  session: {
    maintenance: {
      mode: "enforce", // "enforce" applies cleanup; "warn" only reports
      pruneAfter: "30d",
      archiveDashboardAfter: "7d", // false or 0 disables this dashboard trigger
      maxEntries: 5000,
      preserveRecent: false, // opt in with a duration such as "7d"
    },
  },
}
```

For production-sized `maxEntries` limits, Gateway runtime writes use a small
high-water buffer and clean back down to the configured cap in batches.
Session store reads do not prune or cap entries during Gateway startup, so
startup and isolated cron sessions do not pay for a full store cleanup.
`openclaw sessions cleanup --enforce` applies the cap immediately.

Ordinary entry writes also arm background maintenance at the next age boundary,
with a periodic recheck every 30 minutes while the store remains open. This lets
eligible sessions age out without further traffic. Writes that cannot change
age or count maintenance outcomes skip candidate scans. Automatic planning reads
only retention and protection metadata before entering the foreground write queue;
cap selection retains only the required oldest eligible entries. The writer checks
the prepared store revision before applying changes, so concurrent updates are
reconsidered instead of overwritten.
If writes invalidate an automatic maintenance plan, its replacement waits for
a quiet window after the last write (one second, then two seconds). Three
consecutive invalidations pause automatic retries and log the cause; a new
entry write can schedule another attempt. `warn` mode captures the maintenance
age fact without constructing or dispatching automatic reclamation.

`maxEntries` defaults to 5000 unarchived session rows. Archived rows do not consume
the cap. Existing explicit limits remain unchanged.
When pressure exceeds the cap, cleanup archives the oldest eligible ordinary
sessions instead of deleting their transcripts. Synthetic runtime sessions such
as cron, hooks, heartbeat, ACP, and sub-agents remain disposable and may be
removed. Pinned root sessions, active or admitted work, model-locked sessions, and
durable external conversation pointers are protected; the unarchived total can
therefore remain above the cap when protected rows alone exceed it.

Root sessions and sessions auto-parented to the agent's Home root can be pinned;
genuine child sessions and subagent runs reject pin requests. Persistent child
sessions retain their sidebar nesting; subagent runs appear in transcript activity
and session transcripts. Existing child pins disappear and no longer protect the session
from maintenance.

Gateway model-run check sessions are short-lived by default. Rows matching
`agent:*:explicit:model-run-<uuid>` use fixed `24h` retention, but cleanup is
pressure-gated: it only removes stale check rows when session-entry
maintenance/cap pressure is reached, and runs before the broader stale-entry
age cutoff and entry cap. Normal direct, group, thread, cron, hook, heartbeat,
ACP, and sub-agent sessions do not inherit this 24h retention.

Maintenance preserves durable external conversation pointers, including direct,
group, and thread-scoped chat sessions, while still allowing synthetic cron, hook,
heartbeat, ACP, and sub-agent entries to age out.

Shared or high-volume installations can set `preserveRecent` to protect
recently active interactive sessions and every SQLite history generation owned
by those sessions. The option is disabled when omitted or set to `false`, so
personal installations keep the normal oldest-first policy. Synthetic
model-run, cron, hook, heartbeat, ACP, and sub-agent sessions remain eligible
for bounded cleanup. Protection can temporarily keep the store above its entry
or disk target; it expires after the configured inactivity window.

Recent-session protection does not change managed-worktree garbage collection;
durable dashboard sessions auto-archive after 7 days of inactivity by default,
and `pruneAfter` archives other eligible durable sessions in place after 30 days
by default, preserving their session ids and transcript generations. Disposable
automation rows still delete at their age cutoff.

Pinned sessions and manual, legacy, age-retention, stale-dashboard, or recovery
archives are user-protected and exempt from automatic maintenance. Sessions archived because
`maxEntries` was reached record that reason and remain searchable/restorable
until physical usage exceeds `maxDiskBytes`; disk-budget cleanup may then delete
the oldest cap archives after cheaper artifacts and unreferenced history are
exhausted. Sessions without a recorded archive reason remain protected.

After skipping a history generation or archived session, disk-budget cleanup
rechecks physical usage before considering another deletion. A measurement
failure stops the sweep.

Background disk-budget checks run at most every 30 minutes on entry writes.
Delete and reset operations can request a check sooner, but repeated requests
coalesce to at most one forced check per minute per store. If cleanup exhausts
eligible history and the store remains over budget, automatic checks back off
for 30 minutes and log one warning until the pressure clears or the budget changes.
The warning recommends raising `session.maintenance.maxDiskBytes` or exporting
and deleting unneeded sessions. Checks resume on subsequent activity;
`openclaw sessions cleanup --enforce` remains available immediately.

Cleanup first tries to truncate the WAL without waiting for readers. If readers
prevent truncation, a complete PASSIVE checkpoint is sufficient: frames relevant
to cleanup must have reached the main database, even if the WAL file remains allocated.
Retained WAL bytes still count toward the physical budget. Successful cleanup
logs one outcome with the before/after bytes and removal counts.

An incomplete SQLite WAL checkpoint is a separate deferral. Cleanup preserves
archives and history instead of deleting more data behind the blocked checkpoint.
The result records `deferredReason: "checkpoint-incomplete"`, WAL bytes before and
after, and the checkpoint outcome. Automatic and manual budget passes remain
deferred until the checkpoint owner records completion after the pending cleanup
work. Newer frames from concurrent writes do not erase that completion. Each SQLite cleanup
deletion or vacuum commit requires a new completion before further pruning, so a
reader pinning those changes still defers cleanup. Ordering uses monotonic time;
elapsed time, a budget change, or a system clock correction cannot release the gate.
Normal periodic checkpointing continues, and subsequent activity can resume cleanup
after recovery.

Look for `session history disk budget deferred until a completed WAL checkpoint is observed`
in the Gateway log. Its checkpoint fields include bounded operation names for
explicitly tracked readers, connection and thread IDs, and open-transaction flags.
Collecting these facts does not keep connections open or change worker retirement.
They do not prove which connection holds the blocking SQLite read mark. Raw native
statements outside explicit reader tracking, other workers, and other processes
can remain unidentified. No transcript contents, SQL text, or bound values are included.

If you previously used DM isolation and later returned `session.dmScope` to
`main`, preview stale peer-keyed DM rows with
`openclaw sessions cleanup --dry-run --fix-dm-scope`. Applying the same flag
retires those old direct-DM rows and keeps their transcripts as deleted
archives.

Preview any maintenance run with `openclaw sessions cleanup --dry-run`.

## Inspecting sessions

| Command                    | Shows                                           |
| -------------------------- | ----------------------------------------------- |
| `openclaw status`          | Session store path and recent activity          |
| `openclaw sessions --json` | All sessions (filter with `--active <minutes>`) |
| `/status` in chat          | Context usage, model, and toggles               |
| `/context list`            | What is in the system prompt                    |

<a id="further-reading" />

## Related

- [Session search](/concepts/session-search) - full-text recall across past transcripts
- [Session Pruning](/concepts/session-pruning) - trimming tool results
- [Compaction](/concepts/compaction) - summarizing long conversations
- [Session Tools](/concepts/session-tool) - agent tools for cross-session work
- [Session Management Deep Dive](/reference/session-management-compaction) -
  store schema, transcripts, send policy, origin metadata, and advanced config
- [Multi-Agent](/concepts/multi-agent) - routing and session isolation across agents
- [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools) - per-agent sandbox and tool restrictions, including session visibility
- [Transcript hygiene](/reference/transcript-hygiene) - in-memory, provider-specific transcript sanitization applied before a run
- [Command queue](/concepts/queue)
- [Channel routing](/channels/channel-routing) - how inbound messages are routed to sessions
