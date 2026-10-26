---
summary: "Migrating realtime voice, telephony, and meeting code to the unified Talk session API"
read_when:
  - You maintain a realtime voice, telephony, or meeting plugin
  - You are moving off the removed talk.realtime.*, talk.transcription.*, or talk.handoff.* methods
title: "Talk and realtime voice migration"
sidebarTitle: "Talk and voice"
---

The unified Talk session controller, its supported session combinations, and the method map from the removed Talk families. Part of the [Plugin SDK migration](/plugins/sdk-migration) guide.

## Talk and realtime voice migration

Realtime voice, telephony, meeting, and browser Talk code shares one Talk
session controller exported by `openclaw/plugin-sdk/realtime-voice`. The
controller owns the common Talk event envelope, active turn state, capture
state, output-audio state, recent event history, and stale-turn rejection.
Provider plugins own vendor-specific realtime sessions. Browser-meeting plugins
use `openclaw/plugin-sdk/meeting-runtime` for session, browser, audio, node-host,
agent-consult, and voice-call mechanics, then implement `MeetingPlatformAdapter`
for URL rules, DOM scripts, manual-action mapping, captions, creation, and dial-in
plans. Platform REST APIs, OAuth, artifacts, selectors, and wire names remain in
the plugin. Browser permission plans receive the requested meeting URL so each
platform can grant only its exact supported origins. Session runtimes must also
normalize platform-specific live health after confirmed browser departure;
historical transcript fields may remain, but caption and audio readiness must
not stay active after leave.

All bundled surfaces run on the shared controller: browser relay,
managed-room handoff, voice-call realtime, voice-call streaming STT, Google
Meet realtime, and native push-to-talk. Gateway advertises one live Talk event
channel in `hello-ok.features.events`: `talk.event`.

Live agent consults can forward the admitted ingress channel as `speechChannelId`.
The shared run owner resolves the exact agent/channel/provider execution profile
from `talk.speech.agentProfiles`, after selecting the actual model provider;
adapters must not guess the provider or rewrite shared configuration. The optional
`thinkingLevelExplicit` fact on provider stream-wrapper contexts distinguishes
such an authoritative effort override from an implicit default `off`. Providers
keep their existing capability and wire-format mapping; this fact is not a wire
parameter, a tool grant, or a session-setting mutation.

New code should not call `createTalkEventSequencer(...)` directly unless
implementing a low-level adapter or test fixture. Use the shared controller so
turn-scoped events cannot be emitted without a turn id, stale `turnEnd` /
`turnCancel` calls cannot clear a newer active turn, and output-audio
lifecycle events stay consistent across telephony, meetings, browser relay,
managed-room handoff, and native Talk clients.

The public API shape:

```typescript
// Gateway-owned Talk session API.
await gateway.request("talk.session.create", {
  mode: "realtime",
  transport: "gateway-relay",
  brain: "agent-consult",
  sessionKey: "main",
});
await gateway.request("talk.session.appendAudio", { sessionId, audioBase64 });
// Capture this before stopping playback from the active output `talk.event`.
const turnId = activeOutputTalkEvent.talkEvent.turnId;
await gateway.request("talk.session.cancelOutput", { sessionId, turnId, reason: "barge-in" });
await gateway.request("talk.session.submitToolResult", {
  sessionId,
  callId,
  result: { status: "working" },
  options: { willContinue: true },
});
await gateway.request("talk.session.submitToolResult", {
  sessionId,
  callId,
  result: { status: "already_delivered" },
  options: { suppressResponse: true },
});
await gateway.request("talk.session.submitToolResult", { sessionId, callId, result });
await gateway.request("talk.session.close", { sessionId });

// Client-owned provider session API.
await gateway.request("talk.client.create", {
  mode: "realtime",
  transport: "webrtc",
  brain: "agent-consult",
  sessionKey: "main",
});
await gateway.request("talk.client.toolCall", { sessionKey, callId, name, args });
await gateway.request("talk.client.steer", { sessionKey, text, mode: "steer" });
```

Browser-owned WebRTC/provider-websocket sessions use `talk.client.create`,
because the browser owns provider negotiation and media transport while the
Gateway owns credentials, instructions, and tool policy. `talk.session.*` is
the common Gateway-managed surface for gateway-relay realtime, gateway-relay
transcription, server-processed gateway-relay STT/TTS, and managed-room native
STT/TTS sessions.

Server STT-agent-TTS and meeting adapters use the same speech owner for readiness,
greetings, streaming synthesis, waiting audio, output generations, and pending
input. The supported `meeting-runtime` contracts remain transport adapters, not
a second speech implementation. Native Talk still owns session admission,
agent-run control, confirmation, and durable voice history. Batch channel media
keeps its native media-understanding and awaited reply-delivery owners.

Speech synthesis and paced audio delivery run independently. The shared speech
owner starts playback with the first available audio, without waiting to fill a
reserve. One serial producer reads ahead across provider results into a shared
two-block reservoir. PCM transport blocks are at most six seconds, so queued
audio is capped at twelve seconds; splitting those buffers does not change text
segmentation, expression boundaries, synthesis settings, or joining pauses.
There can also be one bounded provider frame being processed, and at most three
unplayed provider results (current plus two successors). A successor is prepared
only when its text is already available and reservoir capacity remains.

This is bounded lookahead, not a second conversation scheduler or a guarantee
of gapless playback under overload. Standalone services own compute admission;
their single worker can rotate between ready requests at safe inference-unit
boundaries. Output generation checks and cancellation discard prefetched audio,
including audio whose source already reached EOF. Delivery receipts still mark
the actual transport handoff, never precomputation.

Legacy configs that place realtime selectors beside `talk.provider` /
`talk.providers` should be repaired with `openclaw doctor --fix`; runtime Talk
does not reinterpret speech/TTS provider config as realtime provider config.

The supported `talk.session.create` combinations are intentionally small:

| Mode            | Transport       | Brain           | Owner              | Notes                                                                                                              |
| --------------- | --------------- | --------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `realtime`      | `gateway-relay` | `agent-consult` | Gateway            | Full-duplex provider audio bridged through the Gateway; tool calls route through the agent-consult tool.           |
| `transcription` | `gateway-relay` | `none`          | Gateway            | Streaming STT only; callers send input audio and receive transcript events.                                        |
| `stt-tts`       | `gateway-relay` | `agent-consult` | Gateway            | Server STT and TTS through the shared speech owner; the client owns capture and playback.                          |
| `stt-tts`       | `managed-room`  | `agent-consult` | Native/client room | Push-to-talk and walkie-talkie style rooms where the client owns capture/playback and the Gateway owns turn state. |
| `stt-tts`       | `managed-room`  | `direct-tools`  | Native/client room | Admin-only room mode for trusted first-party surfaces that execute Gateway tool actions directly.                  |

Method map for readers migrating from the older `talk.realtime.*` /
`talk.transcription.*` / `talk.handoff.*` families (all removed):

| Old                              | New                                                  |
| -------------------------------- | ---------------------------------------------------- |
| `talk.realtime.session`          | `talk.client.create`                                 |
| `talk.realtime.toolCall`         | `talk.client.toolCall`                               |
| `talk.realtime.relayAudio`       | `talk.session.appendAudio`                           |
| `talk.realtime.relayCancel`      | `talk.session.cancelOutput`                          |
| `talk.realtime.relayToolResult`  | `talk.session.submitToolResult`                      |
| `talk.realtime.relayStop`        | `talk.session.close`                                 |
| `talk.transcription.session`     | `talk.session.create({ mode: "transcription" })`     |
| `talk.transcription.relayAudio`  | `talk.session.appendAudio`                           |
| `talk.transcription.relayCancel` | `talk.session.close`                                 |
| `talk.transcription.relayStop`   | `talk.session.close`                                 |
| `talk.handoff.create`            | `talk.session.create({ transport: "managed-room" })` |
| `talk.handoff.revoke`            | `talk.session.close`                                 |

The unified control vocabulary is also deliberately narrow:

| Method                          | Applies to                                                                       | Contract                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `talk.session.appendAudio`      | `realtime/gateway-relay`, `transcription/gateway-relay`, `stt-tts/gateway-relay` | Append a base64 PCM audio chunk to the session owned by the same Gateway connection.                                                                                                                                      |
| `talk.session.cancelOutput`     | `realtime/gateway-relay`, `stt-tts/gateway-relay`                                | Stop assistant audio delivery without cancelling the underlying agent task.                                                                                                                                               |
| `talk.session.submitToolResult` | `realtime/gateway-relay`                                                         | Complete a provider tool call after any asynchronous completion exposed by its bridge; pass `options.willContinue` for interim output or, when supported, `options.suppressResponse` to avoid another assistant response. |
| `talk.session.steer`            | agent-backed Talk sessions                                                       | Send spoken `status`, `steer`, `cancel`, or `followup` control to the active embedded run resolved from the Talk session.                                                                                                 |
| `talk.session.close`            | all unified sessions                                                             | Stop relay sessions or revoke managed-room state, then forget the unified session id.                                                                                                                                     |

### Server-processed speech relay

Request `mode: "stt-tts"`, `transport: "gateway-relay"`, and
`brain: "agent-consult"`. The `provider` and `model` select transcription;
the agent's configured TTS voice supplies output. This mode does not support
realtime voice replacement or client-supplied tool results.

The result declares mono PCM16 input at 16 kHz and output at 24 kHz, plus a
session-specific `readyMark`. Subscribe to `talk.event`, prepare playback, then
acknowledge that exact mark with `talk.session.acknowledgeMark`. Neither received
microphone bytes nor a locally created output track count as playback readiness.
Capture and audio delivery are gated until acknowledgment; preparation leases
remain held until the session closes.

When `audio.supportsInputEnd` is true in the create result, a capture client may
end an utterance with `talk.session.appendAudio({ sessionId, audioBase64: "",
endOfInput: true })`. The same request may carry the last real audio chunk;
audio is appended before its boundary. Await that request before sending the
next utterance. Empty audio without `endOfInput: true` is invalid. Providers
without explicit input-boundary support reject the marker before accepting
its audio. This signal finalizes retained real input through the native speech
owner; it does not close the call, assert speech recognition, or bypass native
admission. Missing transport data and disconnect remain cancellation conditions.

Clients with echo-isolated capture and reversible playback gating may negotiate
both `isolated-input` and `output-gate` in `capabilities`. The client must apply
the `outputGate` events (`normal`, `duck`, `paused`) to playback. Omitting these
capabilities keeps non-full-duplex input suppression; declaring isolated input
without a playback gate is rejected rather than silently weakening barge-in.
Media capability declarations do not grant agent or tool authority.

Audio arrives as bounded `audio` events with `audioBase64`; text arrives as
final `transcript` events. The nested `talkEvent` retains the common turn/event
envelope, including output start/end and cancellation. An enqueued frame is not
proof that the user heard it. Closing or losing the owning Gateway connection
fences new work and joins accepted transcript writes and provider cleanup.

Do not introduce provider or platform special cases in core to make this work.
Core owns Talk session semantics. Provider plugins own vendor session setup.
Voice-call and Google Meet own telephony/meeting adapters. Browser and native
apps own device capture/playback UX.
