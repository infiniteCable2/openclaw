---
summary: "The tts agent tool and the Gateway TTS RPC methods"
title: "Text-to-speech agent tool and Gateway RPC"
read_when:
  - You are calling TTS from an agent tool call
  - You need the Gateway tts.* RPC method list
---

## Agent tool

The `tts` tool converts text to speech and returns an audio attachment for
reply delivery. On Feishu, Matrix, Telegram, and WhatsApp, the audio is
delivered as a voice message rather than a file attachment. Feishu and
WhatsApp can transcode non-Opus TTS output on this path when `ffmpeg` is
available.

WhatsApp sends audio through Baileys as a PTT voice note (`audio` with
`ptt: true`) and sends visible text **separately** from PTT audio because
clients do not consistently render captions on voice notes.

The tool accepts optional `channel` and `timeoutMs` fields; `timeoutMs` is a
per-call provider request timeout in milliseconds. Per-call values override
`tts.timeoutMs`; configured TTS timeouts override any plugin-authored
provider default.

### Tool profiles

`tts` is not part of the `minimal`, `coding`, or `messaging`
[tool profiles](/gateway/config-tools/tool-policy#tool-profiles). Agents on
those profiles cannot call it until you grant it explicitly:

```json5
{
  tools: {
    profile: "messaging",
    alsoAllow: ["tts"],
  },
}
```

The `full` profile and an unset profile include `tts` without extra
configuration. Other allow/deny layers can still remove it.

Tool profiles do not affect [automatic TTS](/tools/tts/output#auto-tts-behavior):
`tts.auto` still speaks replies when the agent cannot call the `tts` tool.

## Structured speech expressions

Speech expressions are optional answer presentation facts, not a capability
exclusive to the `message` tool. An admitted automatic voice-note turn, live
answer, commentary block, or prepared greeting can carry the same clean text and
expression. The agent receives the selected provider's supported vocabulary
only when expression delivery is enabled for that output.

For native output, the model can produce one explicit JSON presentation object
per native text block, with `type` first and no Markdown fence or surrounding
prose:

```json
{
  "type": "speech",
  "text": "Hello there.",
  "expression": {
    "emotion": "joyful",
    "parts": [{ "text": "Hello " }, { "event": "laugh" }, { "text": "there.", "emphasis": true }]
  }
}
```

The native stream boundary validates the presentation before exposing its clean
text. Incomplete envelope prefixes stay hidden; only complete validated
expression facts reach speech delivery. Ordinary text remains valid and needs
no envelope or `message` call. Native commentary retains its existing phase and
opt-in; preparing a greeting neither plays audio nor grants tool execution.
Speech presentation does not change routing, tool availability, subagent
restrictions, or run lifetime.

For an explicit send, `message(action="send")` accepts optional `voiceExpression`
alongside plain `voiceText`. The expression is a speech-only fact: its ordered text parts must
concatenate **exactly** to `voiceText`. Event parts have no visible text. Keep the
complete, clean answer in `message`; do not place provider emotion markup there.

```json
{
  "action": "send",
  "message": "Hello there.",
  "voiceText": "Hello there.",
  "voiceExpression": {
    "emotion": "joyful",
    "parts": [{ "text": "Hello " }, { "event": "laugh" }, { "text": "there.", "emphasis": true }]
  }
}
```

The shown declarations are illustrative, not universally supported. Expression
delivery requires an explicit exact-agent/channel/synthesis-target opt-in under
`talk.speech.agentProfiles.<agentId>.expression.channels.<channel>.targets` and
the selected provider/model's admitted expression capabilities. When expression
support is disabled for the exact scope, optional controls are ignored and the
clean plain text retains its normal delivery/TTS behavior. A stale model
instruction cannot re-enable expression support. When enabled, unsupported or
invalid controls still fail before synthesis. Control data is never spoken as
literal markup. There is no new `[[tts:...]]` syntax.

Enabling expression support does not require an expression on every reply. Omit
`voiceExpression` when no special emotion, emphasis, or vocal event is intended;
plain replies retain their configured automatic TTS behavior and clean text
projection. Explicit expression requests still require valid, supported controls.

The top-level `emotion` initializes the utterance. A text part can set its own
`emotion`, changing the active emotion from that part onward until another part
explicitly changes it. Omitting a part's emotion keeps the active value; it does
not reset it. Group consecutive sentences with the same emotion in one part:

```json
{
  "emotion": "joyful",
  "parts": [
    { "text": "You are here. We have time. " },
    { "text": "Let us reflect. Take a moment. ", "emotion": "sad" },
    { "text": "Now we can continue.", "emotion": "joyful" }
  ]
}
```

Place emotion changes at sentence boundaries. The speech adapter renders the
active emotion at each sentence and generation-unit start using its backend's
syntax. These are presentation annotations, not additional message sends or
generation boundaries. The normal chunker, pauses, cancellation, and clean text
projection retain their existing owners. Only declared provider emotion values
are valid; omission does not invent a universal neutral/reset identifier.

Native answer blocks and explicit sends share expression validation, provider
capability checks, segmentation, and clean-text projection. An explicit send
still requires the existing `message` tool permission; enabling native speech
presentation does not grant it. A provider's `whisper` capability alone does not
imply a whisper emotion/event identifier; use only its declared vocabulary.

## Gateway RPC

| Method            | Purpose                                      |
| ----------------- | -------------------------------------------- |
| `tts.status`      | Read current TTS state and last attempt.     |
| `tts.enable`      | Set local auto preference to `always`.       |
| `tts.disable`     | Set local auto preference to `off`.          |
| `tts.convert`     | One-off text → audio.                        |
| `tts.setProvider` | Set local provider preference.               |
| `tts.personas`    | List configured personas and the active one. |
| `tts.setPersona`  | Set local persona preference.                |
| `tts.providers`   | List configured providers and status.        |
