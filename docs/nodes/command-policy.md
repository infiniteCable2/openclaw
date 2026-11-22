---
summary: "Platform default allowlists, dangerous-command opt-ins, and the gateway.nodes configuration"
read_when:
  - Checking which commands a platform allows by default
  - Opting into dangerous or privacy-heavy node commands
  - Configuring gateway.nodes and tools.exec
title: "Node command policy"
sidebarTitle: "Command policy"
---

## Command policy

After device pairing, node commands must satisfy three requirements before they
can be invoked:

1. The node must declare the command in its authenticated connect metadata (`connect.commands`).
2. The command must be in the node's approved command surface on its paired-device record.
3. The Gateway's platform-and-approval-derived allowlist must include the declared command.

Use `openclaw nodes pending` and `openclaw nodes approve <nodeRequestId>` to
approve a pending surface. This request ID differs from the device request ID.
An initial unapproved surface has no effective commands. During a pending
expansion, only previously approved commands that remain declared and allowed
stay effective. Local exec approvals and operating-system permissions still
apply after these checks.

Default allowlists by platform (before plugin defaults and `commands.allow`/`commands.deny` overrides):

| Platform | Commands allowed by default                                                                                                                                                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS      | `camera.list`, `location.get`, `device.info`, `device.status`, `contacts.search`, `calendar.events`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer`, `system.notify`                                                                                                                                                              |
| watchOS  | `device.info`, `device.status`, `system.notify`                                                                                                                                                                                                                                                                                                             |
| Android  | `camera.list`, `location.get`, `notifications.list`, `notifications.actions`, `system.notify`, `device.info`, `device.status`, `device.permissions`, `device.health`, `device.apps`, `contacts.search`, `calendar.events`, `callLog.search`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer`, `mobile.ui.observe`, `mobile.ui.act` |
| macOS    | `camera.list`, `camera.ptz.status`, `location.get`, `device.info`, `device.status`, `device.apps`, `contacts.search`, `calendar.events`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer`, `system.notify`, `computer.act`                                                                                                          |
| Windows  | `camera.list`, `location.get`, `device.info`, `device.status`, `system.notify`, `computer.act`                                                                                                                                                                                                                                                              |
| Linux    | `system.notify`, `computer.act` (node host commands like `system.run` are approval-gated, see below)                                                                                                                                                                                                                                                        |

These rows describe the Gateway policy ceiling, not the commands implemented by every node app. A command is usable only when the connected node also declares it. In particular, Android advertises mobile UI commands only while Accessibility Control is enabled, and desktop nodes advertise `computer.act` only while their local Computer Control fulfiller is enabled. The current macOS app does not declare the device and personal-data families listed in the macOS policy row.

Plugin-owned defaults extend the platform table only for the plugin's supported
surface:

| Plugin | Platform | Commands allowed by default                        |
| ------ | -------- | -------------------------------------------------- |
| Canvas | macOS    | `canvas.present`, `canvas.hide`, `canvas.navigate` |

The Canvas commands present hosted widget documents in the macOS app's native
panel. iOS, Android, Windows, Linux, and unknown platforms do not receive Canvas
plugin defaults.

`talk.ptt.start`, `talk.ptt.stop`, `talk.ptt.cancel`, and `talk.ptt.once` are allowed by default for any node that advertises the `talk` capability or declares `talk.*` commands, independent of platform label.

Desktop host commands (`system.run`, `system.run.prepare`, `system.which`, `browser.proxy`, `browser.proxy.upload.v1`, `mcp.tools.call.v1`, `screen.snapshot`, and `desktop.stream` on macOS/Windows/Linux) are not part of the static platform-default table above. They become available once the operator approves a pairing request that declares them, after which the node's approved command set carries them forward on reconnect. Desktop sharing is enabled by default on desktop nodes; the Mac app exposes its local switch under **Settings → This Mac → Capabilities → Desktop sharing**.

Dangerous or privacy-heavy commands require a one-time persistent opt-in with `gateway.nodes.commands.allow`, even if a node declares them: `camera.snap`, `camera.clip`, `camera.ptz.control`, `screen.record`, `contacts.add`, `calendar.add`, `reminders.add`, `health.summary`, `sms.send`, `sms.search`. `gateway.nodes.commands.deny` always wins over defaults and extra allowlist entries. See [Paired node desktops](/gateway/config-browser-ui-desktop#paired-node-desktops), [HealthKit summaries](/platforms/ios-healthkit), and [Computer use](/nodes/computer-use) for the local enablement, pairing, capability, and tool-policy gates around desktop access.

Plugin-owned node commands can add a Gateway node-invoke policy. That policy runs after the allowlist check and before forwarding to the node, so raw `node.invoke`, CLI helpers, and dedicated agent tools share the same plugin permission boundary. Dangerous plugin node commands still require explicit `gateway.nodes.commands.allow` opt-in.

After a node expands its declared commands, capabilities, or permissions,
reconnect it, inspect `openclaw nodes pending`, and approve the widened surface
with `openclaw nodes approve <nodeRequestId>`. Removing declarations does not
grant new access or require approval for an expansion.

Matrix-connected go-e nodes use `network.device.read.v2` for **read-only** status of one assigned charger. The command requires an active authorized Matrix run, explicit Gateway command allowance, and node command approval. The `goe_status` plugin chooses the configured six-digit device key and sends it with the provider field `plugin: "go-e"`. Element checks its local charger and Wi-Fi grants before reading. The generic agent Nodes tool and node-published agent descriptors do not expose this keyed command.

The legacy Matrix command `network.device.read` takes an empty object and is for a single existing charger binding.

The go-e plugin can request `network.device.history.v1` with `plugin: "go-e"`, the configured `deviceKey`, and an integer `limit` from 1 to 20. Optional `from` and `to` are safe integer Unix timestamps in milliseconds and bound the session start with an inclusive lower and exclusive upper bound. `offset` is an optional nonnegative safe integer. The node filters completed sessions, sorts them by end and then by start (newest first), and applies the page. `hasMore: true` signals more matching sessions. `network.device.stop.v1` takes only `plugin` and `deviceKey`. Both commands require the live go-e plugin, its current private requester turn, an admitted Matrix Node and explicit Gateway and node command approval. The generic Nodes tool cannot invoke them. The phone owns the one-time stop confirmation. The Gateway sends a stop request once.

## Config (`openclaw.json`)

Node-related settings live under `gateway.nodes` and `tools.exec`:

```json5
{
  gateway: {
    nodes: {
      // Auto-approve first-time node pairing from trusted networks (CIDR list).
      // Disabled when unset. Only applies to first-time role:node requests
      // with no requested scopes; does not auto-approve upgrades. This
      // approves the device only: the node's command/capability surface still
      // needs `openclaw nodes approve <requestId>` (see `openclaw nodes
      // pending`), because device pairing alone must not grant commands.
      // Silent same-host pairing behaves the same way. SSH-verified pairing
      // and node-profile setup codes approve the initial surface, since both
      // record explicit machine-ownership or admin consent.
      pairing: {
        autoApproveCidrs: ["192.168.1.0/24"],
        // SSH-verified auto-approval (default: enabled). Approves first-time
        // node pairing on an exact device-key match read back over SSH.
        sshVerify: true,
      },
      // Trust agent-visible plugin tools published by paired nodes (default: true).
      pluginTools: {
        enabled: true,
      },
      // Persistently enable dangerous/privacy-heavy node commands.
      commands: {
        allow: ["camera.snap", "screen.record"],
        // Block exact command names even if defaults or commands.allow include them.
        deny: ["camera.clip"],
      },
    },
  },
  tools: {
    exec: {
      // Default exec host: "node" routes all exec calls to a paired node.
      host: "node",
      // Exec policy mode for node exec: allow only approved/allowlisted commands.
      mode: "allowlist",
      // Pin exec to a specific node (id or name). Omit to allow any node.
      node: "build-node",
    },
  },
}
```

Use exact node command names. `commands.deny` removes a command even when a platform default or `commands.allow` entry would otherwise allow it. Paired nodes may publish agent-visible plugin tool descriptors by default, but each descriptor's command must still be in the node's approved command surface. Set `gateway.nodes.pluginTools.enabled: false` to ignore all such descriptors. See [Gateway configuration reference](/gateway/config-gateway#gateway) for gateway node pairing and command-policy field details.

Per-agent exec node override:

```json5
{
  agents: {
    entries: {
      main: {
        tools: { exec: { node: "build-node" } },
      },
    },
  },
}
```

## Permissions map

Nodes may include a `permissions` map in `node.list` / `node.describe`, keyed by permission name (e.g. `screenRecording`, `accessibility`, `location`) with boolean values (`true` = granted).
