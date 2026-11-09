---
doc-schema-version: 1
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

Session lists reconcile invalidated metadata before returning rows. If a native
session changes ownership during a list read, that row uses the
configured model metadata while other sessions remain available. Native metadata
is refreshed when that row is next invalidated; an unchanged list read does not
retry it.

Conversation branch listing (`sessions.branches.list`) has a ten-second request
deadline, including access checks and cold-transcript restoration. If it expires,
the Gateway returns a retryable `UNAVAILABLE` error instead of an empty branch
list. Retry after database preparation finishes. Required integrity checks and
already-admitted storage cleanup keep their own lifetimes.

Compressed transcript archives are decoded directly from their source files;
history, discovery, usage, and memory indexing do not create plaintext copies in
the temporary directory. History retains navigation metadata and reads selected
byte ranges through a bounded-memory stream. An archive that
would expand past 4 GiB fails with a visible error and remains unchanged.
Archive publication verifies compressed output against the original plaintext byte
count, preserving compression and disk-budget retention.
Doctor reports the size of read-cache directories left by older versions.
`openclaw doctor --fix` (also run during updates) removes recognized cache files
and the directory if empty, preserving unrelated entries. Cleanup is best effort:
files still open on Windows may remain until a later run; current readers do not
use them.

To continue the same Gateway-owned session in the Control UI, terminal, or a
coding harness, see [Session synchronization and attachment](/concepts/session-attachment).

For turn ownership, queueing, stopping, and lifecycle mutation rules, see
[Session controller](/concepts/session-controller).

Retries with the same input key acknowledge an already committed input even after
another turn has started. They do not append another user message or generate a
second reply. Interrupted current turns can still resume; reusing a key for
conflicting content or sender identity is refused.

For the personal-agent default — one rolling conversation shared by all your
DM channels, with group activity and background work flowing into it — see
[The main session](/concepts/main-session).

Delivered command exchanges from the shared dispatcher are conversation history
too. OpenClaw appends the user's command and delivered reply as ordinary
user/assistant messages. Native menus and command acknowledgements on Discord
and Telegram, Slack argument menus, and Mattermost model pickers are also retained after delivery.
Later turns and chat history can read these exchanges.
Login, pairing, and sensitive `/config set` or `/debug set` values are redacted before storage.
`/new` and `/reset` put their confirmation exchange in the new session; they do not
rewrite the old session. `/btw` and `/side` stay ephemeral, and message edits or
deletions do not rewrite earlier transcript rows.

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
In the Sessions page, enabling **Unknown** includes authorized unknown sessions
owned by the selected agent. An agent-qualified key such as `agent:ops:unknown`
is an ordinary session and remains visible when **Unknown** is off.
Renaming, pinning, or editing session metadata retains the existing message
preview without rereading the transcript. New messages, transcript replacements,
completed transcript repairs, and cold-storage restoration refresh previews; changes to model selection
or fallback state refresh the relevant model facts.
When `sessions.list` requests `includeLastMessage`, rows can also include
`lastAssistantMessage` with the latest visible assistant text and its timestamp.
This field uses the same bounded recent transcript window as other previews;
it is absent when no timestamped assistant text is available in that window.
The general `lastMessagePreview` can still contain a user message.
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

Branches currently require SQLite agent storage
(`database.families.agent.engine: "sqlite"`) and a dedicated physical session
database owned by the corresponding agent. PostgreSQL agent storage is supported
in `native` mode; branch mode rejects it before startup maintenance or root
creation, without changing stored data.
The Gateway also rejects a branch whose database belongs to another agent or
resolves to the same physical file as another configured agent, including a native-mode agent or a
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

Private context follows the native person profile, not a display name or device
label. Administrator-linked channel identities can share it across configured
inputs. Existing private contributions keep their original channel identity;
the personal read owner checks the source account, native sender provenance and
current profile link before disclosing an exact saved range. Unlinking or
reassigning the identity invalidates prepared reads. Unconfirmed history is not
promoted, and source attribution and transcript bytes remain unchanged.

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
their actual source incarnation and transcript generation. The root retains
original references without copying whole dialogues or fabricating model turns.

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
source preparation without manufacturing a user input. Committed root updates wake its
existing database-lifetime owner; notifications carry no dialogue or read permission.
Healthy channel startup can register an already enrolled private conversation
and prepare its recipient view before its first input. This reuses the same
recipient owner as an ordinary connection; it neither creates a dialogue nor
backfills historical enrollment. Endpoint, enrollment, or authorization changes require
fresh native admission; a skipped registration is retried on the corresponding
state change rather than by polling or manufacturing a turn.
Reusable private Gateway conversations retain their original admitted source
metadata. On restart, the Gateway rechecks that source's current native permissions
and exact branch/root identities, then registers background preparation without a
connected device or a new input. A completed model run does not end a reusable
conversation. Archived, shared, incognito, or replaced conversations are excluded;
temporary conversations without reusable enrollment are not restored as recipients.
Older conversations without this enrollment require one authorized opening or turn;
historical routing metadata alone never establishes permission. Preparation does not
mean model-context admission: native request budgets and safe boundaries still apply.
One coalesced, read-only scheduler prepares bounded source segments fairly across
open recipients. Each quantum releases shared background capacity. A transient
preparation failure receives a cancellable retry with bounded backoff, without
waiting for another user input. Closing or revoking a recipient cancels that work.
Native foreground admission pauses optional root and recipient preparation across
sessions. Completed segments and pending source notifications are retained;
the last foreground release resumes preparation without polling. Journal
publication and atomic write settlement continue. Already prepared observations
remain available at the running turn's safe boundaries. Long foreground work can
therefore defer preparation of newly published observations.
Disposable caches are bounded per recipient; cache capacity does not acknowledge
unread data or remove references from the root.
Unchanged root references and recipient progress reuse separate background
snapshots within that same cache budget. Full native transcript versions and
fresh physical-store and lifecycle checks invalidate stale snapshots. Temporary
storage-fact unavailability retries preparation instead of settling a source as unreadable.

The root remains the authoritative source-reference ledger. Prepared segments are
a rebuildable view, not a second root, durable admission receipt, or guarantee
that a model has seen every contribution. Source preparation is read-only. Idle
maintenance admits prepared packets under the recipient's session lane, using
the native request's system/tool footprint and response reserve. It checks the
exact recipient version and current permissions and yields to foreground input.
When a verified missing packet fits an empty window but exceeds the space left
in this branch, idle maintenance can compact the branch's existing history.
The pending packet stays outside the summary and is checked again for admission.
A failed summary leaves its receipt open. Native owner availability
and selected donor changes schedule retries without polling or a new user turn.
When no live preparation remains, an opening rebuilds it from the existing root
and durable packet receipts.

After a restart, source preparation does not wait for a model request. The
prepared observations remain available for the first native model boundary,
which checks its actual system/tool footprint before admitting them. Eligible
idle recipients can also check ready packets using a fresh native maintenance
request. Its budget applies to that operation. A later user request calculates
its own budget. Where native placement or model selection cannot be established,
preparation waits for a supported admission boundary.

Root checkpoints bound the context offered to new branches. A separate background
owner prepares an audience-scoped summary when the projected context reaches the
native model token/compaction threshold. Cache byte limits do not trigger semantic
compaction. Publication atomically records the summary and its exact newly covered
original ranges; later contributions remain outside that checkpoint. Checkpoints
form an immutable chain with delta coverage, preserving original session history
and references. A summary remains a lossy interpretation, not a replacement for
the historical record or permission to read it.

An unavailable original range remains outside new checkpoint coverage. It does
not block preparation or summarization of later verified originals. If the range
becomes verifiable later, a subsequent checkpoint can cover it as a new delta.
Previously covered sources still require current authorization before their
summary can be reused; unavailable storage facts retain the normal retry path.

A genuinely new private branch installs its authorized checkpoint and subsequent
observations in the native creation transaction, before the first input. The
original private destination, absent row, unused transcript/window identity, root
prefix and every selected source range remain guarded through commit. A complete
background frame retains its original broker and donor custody while new branches
borrow its immutable context. Creation proves the new private destination without
repeating donor discovery. A revoked frame falls back to normal authorized
preparation; borrowed custody is released only after its copies settle. Concurrent root
appends remain later deltas; a changed source or recipient refuses the copy
atomically. The first model request still uses its actual system/tool footprint
and native capacity/compaction checks, without an invented budget or checkpoint.
Preparation publishes the complete available tail before acquiring a summary model
or waiting for a new summary. Existing recipients retain their own imported progress and native
compaction; publishing a root checkpoint does not rebase them, repeat earlier
imports, or remove their local conversation. Their missing original contributions
remain independently recoverable under the same permissions.

Foreground conversation takes priority over root summarization. Checkpoint work
uses native provider/authentication and compaction facilities without creating a
speaking root session or exposing tools. Mandatory cloud-worker placement currently
does not support this sessionless helper: it defers root summarization with an
operational warning rather than bypassing the placement policy.

The foreground consumes only a bounded prepared candidate view. Native provenance
is rebound to the current recipient and physical database; source and audience
permissions are still checked freshly. This does not enumerate the full root or
all recipient receipts before a model request. Exact native receipt observations
distinguish active carriers, historical carriers and missing evidence, so a retry
can recover an accepted observation without resurrecting compacted content.
Background preparation also retains bounded native read custody shared per donor.
Unrelated root additions preserve unchanged donor groups; changed or retired
selections and scope changes invalidate the affected custody.
Each admission binds fresh execution, destination and root evidence to that custody;
it does not reuse the former caller's grant or repeat source discovery. Native
revocation, physical identity, exact ranges and atomic write predicates still apply.
Consumption, retirement and recipient closure release unused custody. Stale donor
preparation is deferred without rebuilding it on the foreground path.
The shared root retains the same per-donor preparation across background quanta;
an unrelated contribution does not repeat unchanged donor discovery. If current
native authority disproves a cached text range or prefix, preparation discards
only the matching cache values and schedules one fresh pass. Missing permission
or unavailable history alone does not schedule a repair loop. Original receipts
and session history remain unchanged.
Native compaction, navigation, reset and rewrite notifications also wake watched
source preparation without a new user turn or root receipt. Clean message and
report appends do not trigger a redundant source scan.

An existing embedded model request may consume ready observations, including at
the next natural model step after tools. It does not wait for full freshness or
uncached source hydration. Fresh native source/recipient authorization and exact
range validation precede each durable packet write under the current writer.
Append-only source growth uses native prefix proof; replacement, reset, and
rewritten navigation remain fenced. Native prospective token accounting preserves
the current request and response reserve. If an addition does not fit, it remains
pending for idle maintenance or a later native request; this live boundary
never starts compaction, restarts generation, or creates a turn. SQL receipt batches
do not limit the number of ready packets admitted at one model boundary: successive
batches share the same prospective token budget and yield between operations.
While that drain writes prepared packets, the same recipient's background
preparation retains notifications but does not start another quantum. It resumes
after the drain, including on cancellation; model generation does not hold this pause.
Already admitted packets retain their positions during retries
and live steering. New observations are quoted data, not new instructions or
permission to repeat tools.
They can inform subsequent model decisions within the existing task; provenance
does not make them semantically inert or authorize a different task.

Late additive admission uses the native model-request boundary before its
checkpoint and compaction decision. Both the legacy embedded context engine and
the native V2 request path retain their own assembly and capacity checks. Other
configured context engines retain ownership of their assembled window; the host
does not append observations after assembly without that engine's integration.

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
At info level, `Conversation knowledge transfer outcome` identifies the recipient
and the contributing sources by stable hashes. A `prepared` outcome reports
work staged in memory. An `admitted` outcome reports packets accepted by the
recipient, including how many were newly appended or already present. A
`deferred` outcome gives the reason and the available progress counts. Debug
events add individual packet offsets and source sequences. These operational
records contain no dialogue and stay outside model context. Old unverified
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

After its first healthy sync, Matrix verifies existing private endpoints and opens
their shared root preparation in the background, before any user message or call.
The generic conversation-input `prepareConnection` contract accepts
`purpose: "root-preparation"` with original endpoint ingress and account-owned
cancellation/cleanup. This reuses an existing enrolled branch; it creates neither
a session nor a user turn. A disconnect releases its live proof, and reconnect
qualifies it again. Calls arriving before preparation finishes still use native
creation checks; a ready frame covers its captured root prefix, with newer
contributions supplied through normal catch-up.

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

## Creators and assigned owners

New delegated sessions and automations retain the verified human who initiated
the work as their creator. This is normal behavior; no Labs switch is required.
The assigned owner remains separate: reassignment alone does not transfer
creator rights for sharing, public-link management, archive, or restore. Existing
creator/admin authorization rules still apply. Existing records are not
retroactively reassigned.

A selected tool user supplies execution authority, not evidence that they
initiated the task. Autonomous work without a retained human stays
agent/system-created. Creator attribution affects discovery, creator controls,
and the personal-profile fallback when no human owner is assigned; it does not
change the executing agent, model/tool permissions, or required sandbox identity.

Public links still require explicit publication. Attribution does not publish
sessions automatically, change their anonymous read-only view, or expose private
isolation metadata. Content exclusions, revocation, and future-message behavior
are unchanged.

Attribution is stored alongside the original actor inside the existing creation
record. Original actor fields and database schema versions are unchanged. A
compatible older runtime ignores the additional attribution and uses its original
creator rules; it retains the record when writing sessions, so returning to this
runtime restores the attributed creator without changing sandbox identity.
Retain the ordinary [rollback safeguards](/install/updating/rollback-and-recovery):
this feature does not make unrelated database-format changes readable by older
binaries. An incompatible binary remains blocked rather than silently restoring
an old backup and losing later writes.

## Automatic session names

Interactive chat sessions without an explicit name generate a topic title in the
background when the Gateway dispatches their message. Naming starts alongside
worktree and reply preparation; it does not wait for the agent’s first progress
event and does not block the turn. The name appears when the title model finishes.
If the title request fails while overlapping a turn, it retries once after that
turn settles. Explicit names and manual renames are preserved.

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
`session.identityLinks` to map their identities to one shared peer id so
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

Incognito sessions are available only from the Control UI's **New thread** screen. Turn on **Incognito** before starting the thread to keep its session entry, transcript, and compaction state in process memory instead of on disk. The thread expires 24 hours after creation or when the Gateway restarts, whichever comes first. Finishing a turn does not close the thread, and activity does not extend its lifetime. Expiry stops active work and deletes the session and transcript without an archive. Incognito does not run OpenClaw's automatic memory flush, and does not create a transcript archive when you reset or delete it. Codex-backed runs also start their harness thread in ephemeral mode, so Codex writes no rollout or local session-state files; other model providers use HTTP APIs and keep no local provider transcript in OpenClaw.

Incognito agent turns use the same in-memory session owner from command preparation through execution, so the first turn can produce a reply without switching to the durable session store.

<Warning>
On the Codex runtime, the Codex app-server still writes each message you submit to its own diagnostic log database (`logs_2.sqlite` in that agent's Codex home), including messages in incognito threads. Codex currently offers no setting that turns this log off, so OpenClaw cannot prevent it. For conversations that must not reach disk, use an agent on the OpenClaw runtime.
</Warning>

Delegated work uses its native execution and completion owners. Live subagent activity and completion delivery remain available.

The `incognito-` segment is reserved for dashboard, subagent, and hidden internal session keys; `openclaw doctor --fix` renames any colliding legacy durable keys.

Incognito does not restrict the agent's normal tools. An explicit request to save information, or any tool-driven file write, can still persist data outside the incognito session store. Your configured model provider still processes the messages you send. Incognito content is excluded from ordinary Gateway output, delivery and response diagnostics, WebSocket event previews, raw-stream, cache-trace, and Anthropic payload logs. Live replies remain available, and OpenClaw still records operational diagnostics and content-free audit metadata such as HMAC references.

On multi-user gateways, incognito threads are visible only to admin-scope connections and never appear through another session's agent session tools or transcript search. This limits persisted session history and access through other gateway-mediated sessions; it does not make all tool, upload, approval, or configured diagnostic data ephemeral. The gateway owner or process operator can still observe live sessions.

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

Independent sessions can initialize their first turns concurrently. Requests for
the same session remain ordered; parent forks and resets retain their shared-state
coordination.

Sessions are reused until you reset them manually or opt into an automatic reset policy:

- **No automatic reset** (default `mode: "none"`) - sessions keep the same
  `sessionId`; compaction manages the active context as the conversation grows.
- **Daily reset** (`mode: "daily"`) - opt into a new session at a configured local
  hour (`session.reset.atHour`, default `4`, 0-23) on the gateway host. Daily
  freshness is based on when the current `sessionId` started, not on later
  metadata writes.
- **Idle reset** (`mode: "idle"`) - opt into a new session after `session.reset.idleMinutes`
  of inactivity. Idle freshness is based on the last real user/channel
  interaction, including browser Talk consults. Heartbeat, cron, and exec system
  events do not keep the session alive.
- **Manual reset** - type `/new` or `/reset` in chat. `/new <model>` also
  switches the model.

When both daily and idle resets are configured, whichever expires first wins.
The message that triggers an automatic reset continues in the new conversation.
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

A graceful Gateway stop or restart writes one small marker for each running root
session, then aborts work promptly. A root is running when its agent loop, one of
its descendant sub-agents, or one of its background processes is active. At startup,
the Gateway clears the marker and sends one ordinary system input asking the agent
to check current files, processes, sub-agents, and external actions before continuing.
This includes channel threads and non-default agents; replies retain the session's
recorded channel and thread. Marker persistence uses the process shutdown deadline.
Shutdown and startup log per-agent marked/resumed counts and skip reasons.

Running children stop quietly and do not resume independently. Their root requester
receives the single resume input and can inspect results, send new instructions,
or spawn replacements. Cron occurrence sessions and ACP/external-harness sessions
keep their own lifecycle owners.

The input uses the recorded human owner's current authority, or the human creator
when no owner is set, narrowed by the session's current permission mode and tool
policy. A deleted or archived session, removed principal, or lost access is skipped.
A session without a human principal uses ordinary system-event authority. Saved
operator or requester snapshots do not grant permissions.

The marker records the IDs of accepted user messages still queued at shutdown.
Only those messages follow the resume input in FIFO order, each under its recorded
sender's current authority. Older crash-left queued rows remain inert. A sender that
cannot be admitted gets an ordinary failed send and can resend. New messages during
the resumed run use normal steering and queue rules; they do not wait behind a
special recovery predecessor.

A crash or `SIGKILL` writes no shutdown markers. Startup uses the existing persisted
nonterminal run identity to resume an eligible root whose execution owner is gone.
Successful chat commands do not create a running marker or trigger a recovery turn.
Queued turns publish their running marker when execution starts, so a crash during
their execution resumes that work once.
Both sources produce one resume input per session. The agent must inspect uncertain
effects before repeating them. The Control UI shows the ordinary
conversation and resume turn without restart banners or interrupted-input notices.
There is no manual `sessions.recover` method.

Already-produced outbound messages and media keep their existing delivery queue.
An unknown delivery outcome can still require inspection; restarting does not prove
that an external action or reply happened exactly once. See
[Restart recovery](/gateway/restart-recovery) for shutdown, compatibility, and
post-update checks.

## Where state lives

- **Runtime session rows and transcripts:** `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` by default
- **Archived transcript files:** `~/.openclaw/agents/<agentId>/sessions/`
- **Legacy row migration source:** `~/.openclaw/agents/<agentId>/sessions/sessions.json`

Archive discovery uses the selected store, recorded transcript paths, and agent
directories. The pre-agent `~/.openclaw/sessions/` directory is no longer an
implicit fallback; explicitly configured paths still work.

State directories reached through symlinks are supported on SQLite and PostgreSQL,
including session deletion, transcript archiving, and retained cron history reads.

The session rows in the per-agent SQLite database keep separate lifecycle
timestamps:

- `sessionStartedAt`: when the current `sessionId` began; daily reset uses this.
- `lastInteractionAt`: last user/channel interaction that extends idle lifetime.
  Finalized user voice transcripts update this only with a new committed entry;
  replayed, assistant-only, and rejected transcripts do not.
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

Ordinary entry writes and reply initialization arm background maintenance at the next age boundary,
with a periodic recheck every 30 minutes while the store remains open. This lets
eligible sessions age out without further traffic. Reply preparation does not wait
for unrelated retention cleanup. Writes that cannot change
age or count maintenance outcomes skip candidate scans. Automatic planning reads
only retention and protection metadata before entering the foreground write queue;
age candidates must reach their enabled retention phase's cutoff, and maintenance
looks up only active-session ancestry unless runtime identities need the full
session-key inventory. Cap selection retains only the required oldest eligible entries.
Automatic capacity cleanup yields the writer between batches of up to 64 entries;
explicit cleanup remains exhaustive. The writer rechecks the selected rows and their protection before applying
changes, so concurrent updates are reconsidered instead of overwritten. Activity
on unrelated sessions and protection that has ended do not invalidate the plan.
When an over-cap pass finds only durably protected entries, ordinary activity does not
repeat that futile plan. New eligible entries, restored identities, lost entry
protection, and changed policy reconsider it. Delivery cleanup resumes idle maintenance
when it releases the session's remaining recovery protection. Temporary protection from active
sessions, runtime providers, or recent activity does not suppress planning on
ordinary writes; age deadlines and the periodic recheck still resume idle cleanup.
While entry pressure still requires cleanup, capacity maintenance revisits entries
once temporary write protection ends, without requiring another entry write.
Releasing acquired session work also wakes idle capacity maintenance; overlapping
work keeps the session protected until its final admission releases.
If writes invalidate an automatic maintenance plan, its replacement waits for
the scheduled retry delay (one second, then two seconds). Further writes coalesce
into that retry without postponing it indefinitely. Three
consecutive invalidations pause automatic retries and log the cause; a new
entry write can schedule another attempt. `warn` mode skips automatic reclamation.
Certified transcript backfill and usage-cache writes retain a protected-only no-op result
while entry-change publications and scoped write receipts remain current. Unknown writes
still invalidate that result and wait for the existing quiet window before replanning.

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
Unchanged entry patches do not schedule a check.
Delete and reset operations can request a check sooner, but repeated requests
coalesce to at most one forced check per minute per store. If cleanup exhausts
eligible history and the store remains over budget, automatic checks back off
for 30 minutes and log one warning until the pressure clears or the budget changes.
Per-agent legacy store locators and their canonical SQLite paths share this queue
and backoff. Custom aggregate store locators retain their own maintenance scope.
After a pass reclaims nothing, the next automatic check first inspects eligible
data without reserving the foreground writer; protected-only pressure does not
repeat archive pruning or checkpoints. Manual cleanup still runs immediately.
The warning recommends raising `session.maintenance.maxDiskBytes` or exporting
and deleting unneeded sessions. Checks resume on subsequent activity;
`openclaw sessions cleanup --enforce` remains available immediately.

Cleanup first tries to truncate the WAL without waiting for readers. If readers
prevent truncation, a complete PASSIVE checkpoint is sufficient: frames relevant
to cleanup must have reached the main database, even if the WAL file remains allocated.
Retained WAL bytes still count toward the physical budget. Successful cleanup
logs one outcome with the before/after bytes and removal counts.
Archive pruning measures physical usage outside the foreground writer queue.
Each deletion and page-reclamation unit retains its own admission, with a yield
between reclamation units. Archive retention also selects candidates outside the
writer queue, then rechecks and removes at most 16 rows per admission, yielding
between batches while retaining the same 256-row selection limit per pass.
Concurrent shrinkage can prune one additional oldest derived archive before the
next measurement ends the sweep; canonical retention and deletion eligibility
checks are unchanged.

An incomplete SQLite WAL checkpoint is a separate deferral. Cleanup preserves
archives and history instead of deleting more data behind the blocked checkpoint.
The result records `deferredReason: "checkpoint-incomplete"`, WAL bytes before and
after, and the checkpoint outcome. Manual cleanup and subsequent throttled
automatic checks retry the checkpoint: an earlier blocked observation cannot
suspend cleanup indefinitely when another connection completes a checkpoint
without publishing its result. Cleanup still requires the checkpoint owner to
record completion after the pending cleanup work. Newer frames from concurrent
writes do not erase that completion. Each SQLite cleanup
deletion or vacuum commit requires a new completion before further pruning, so a
reader pinning those changes still defers cleanup. Ordering uses monotonic time;
elapsed time, a budget change, or a system clock correction cannot release the gate.
Normal periodic checkpointing continues. A published completion allows the next
activity to retry immediately; otherwise the normal check interval applies.

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
