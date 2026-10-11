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

`message(action="send")` accepts optional `voiceExpression` alongside plain
`voiceText`. The expression is a speech-only fact: its ordered text parts must
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
the selected provider/model's admitted expression capabilities. Without either,
the expression request fails before synthesis; it does not silently speak the
markup or fall back to a neutral rendering. There is no new `[[tts:...]]` syntax.

This structured-send contract does **not** by itself make automatic final answers,
live commentary, or prepared greetings produce expressions. Those paths retain
their existing plain-text behavior until their native producer supplies the same
structured facts. A provider's `whisper` capability alone does not imply a whisper
emotion/event identifier; use only its declared vocabulary.

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
