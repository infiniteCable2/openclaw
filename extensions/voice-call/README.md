# @openclaw/voice-call

Official Voice Call plugin for **OpenClaw**.

Providers:

- **Twilio** (Programmable Voice + Media Streams)
- **Telnyx** (Call Control v2)
- **Plivo** (Voice API + XML transfer + GetInput speech)
- **Asterisk** (authenticated inbound AudioSocket calls)
- **Mock** (dev/no network)

Docs: `https://docs.openclaw.ai/plugins/voice-call`
Plugin system: `https://docs.openclaw.ai/tools/plugin`

## Install

```bash
openclaw plugins install @openclaw/voice-call
```

Restart the Gateway afterwards.

## Local dev install

```bash
PLUGIN_HOME=~/.openclaw/extensions
mkdir -p "$PLUGIN_HOME"
cp -R <local-plugin-checkout> "$PLUGIN_HOME/voice-call"
cd "$PLUGIN_HOME/voice-call" && pnpm install
```

## Config

Put under `plugins.entries.voice-call.config`:

```json5
{
  provider: "twilio", // or "telnyx" | "plivo" | "asterisk" | "mock"
  fromNumber: "+15550001234",
  toNumber: "+15550005678",
  sessionScope: "per-phone", // or "per-call" | "main"
  inboundPolicy: "allowlist",
  allowFrom: ["+15550005678"],

  twilio: {
    accountSid: "ACxxxxxxxx",
    authToken: "your_token",
  },

  telnyx: {
    apiKey: "KEYxxxx",
    connectionId: "CONNxxxx",
    // Telnyx webhook public key from the Telnyx Mission Control Portal
    // (Base64 string; can also be set via TELNYX_PUBLIC_KEY).
    publicKey: "...",
  },

  plivo: {
    authId: "MAxxxxxxxxxxxxxxxxxxxx",
    authToken: "your_token",
  },

  // Inbound Asterisk only. Does not require fromNumber or a public URL.
  asterisk: {
    registrationToken: "replace-with-a-long-random-secret",
    registrationPath: "/voice/asterisk/register",
    audioSocket: {
      bind: "127.0.0.1",
      port: 9092,
      sampleRate: 8000,
    },
  },

  // Webhook server
  serve: {
    port: 3334,
    path: "/voice/webhook",
  },

  // Public exposure (pick one):
  // publicUrl: "https://example.ngrok.app/voice/webhook",
  // tunnel: { provider: "ngrok" },
  // tailscale: { mode: "funnel", port: 8443, path: "/voice/webhook" }

  outbound: {
    defaultMode: "notify", // or "conversation"
  },

  // Optional response agent workspace. Defaults to "main".
  agentId: "main",

  streaming: {
    enabled: true,
    // optional; if omitted, Voice Call picks the first registered
    // realtime-transcription provider by autoSelectOrder
    provider: "<realtime-transcription-provider-id>",
    streamPath: "/voice/stream",
    providers: {
      "<realtime-transcription-provider-id>": {
        // provider-owned options
      },
    },
    preStartTimeoutMs: 5000,
    maxPendingConnections: 32,
    maxPendingConnectionsPerIp: 4,
    maxConnections: 128,
  },
}
```

Notes:

- Twilio/Telnyx/Plivo require a **publicly reachable** webhook URL.
- Asterisk uses a local authenticated HTTP registration followed by a one-time UUID AudioSocket admission. The initial implementation is inbound-only; outbound calls intentionally wait for a restricted ARI implementation.
- `tailscale.port` defaults to `443` and owns the external HTTPS port for both legacy `tailscale.mode` and unified Tailscale tunnel providers. Funnel supports `443`, `8443`, or `10000`; Serve accepts any valid TCP port.
- Twilio defaults to US1. For a non-US Region, set `twilio.region` to `ie1` or `au1` and use credentials created in that Region; see [Twilio's regional REST API guide](https://www.twilio.com/docs/global-infrastructure/using-the-twilio-rest-api-in-a-non-us-region).
- `mock` is a local dev provider (no network calls).
- Telnyx requires `telnyx.publicKey` (or `TELNYX_PUBLIC_KEY`) unless `skipSignatureVerification` is true.
- Runtime accepts canonical config only. If older configs still use `provider: "log"`, `twilio.from`, or legacy `streaming.*` OpenAI keys, run `openclaw doctor --fix` to rewrite them.
- advanced webhook, streaming, and tunnel notes: `https://docs.openclaw.ai/plugins/voice-call`
- `responseModel` is optional. When unset, voice responses use the runtime default model.
- `sessionScope` defaults to `per-phone`, preserving caller memory across calls. Use `per-call` for reception, booking, IVR, and bridge flows where each carrier call should start fresh. Use `main` to share the configured agent's main session (`agent:<agentId>:main`, or `global` when core `session.scope` is `"global"`). Custom core `session.mainKey` values are ignored.
- `realtime.consultThinkingLevel` is optional. When set, it overrides the thinking level used by the model behind realtime `openclaw_agent_consult` calls.
- `realtime.consultFastMode` is optional. When set, it toggles fast mode for realtime `openclaw_agent_consult` calls.

## Stale call reaper

See the plugin docs for recommended ranges and production examples:
`https://docs.openclaw.ai/plugins/voice-call#stale-call-reaper`

## TTS for calls

Voice Call uses the core `tts` configuration for
streaming speech on calls. Override examples and provider caveats live here:
`https://docs.openclaw.ai/plugins/voice-call#tts-for-calls`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --json
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## Tool

Tool name: `voice_call`

Actions:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

## Gateway RPC

- `voicecall.initiate` (to?, message, mode?)
- `voicecall.continue` (callId, message)
- `voicecall.speak` (callId, message)
- `voicecall.end` (callId)
- `voicecall.status` (callId)

## Notes

- Uses webhook signature verification for Twilio/Telnyx/Plivo.
- Adds replay protection for Twilio and Plivo webhooks (valid duplicate callbacks are ignored safely).
- Twilio speech turns include a per-turn token so stale/replayed callbacks cannot complete a newer turn.
- `responseModel` / `responseSystemPrompt` control AI auto-responses.
- Voice-call auto-responses enforce a spoken JSON contract (`{"spoken":"..."}`) and filter reasoning/meta output before playback.
- While a Twilio stream is active, playback does not fall back to TwiML `<Say>`; stream-TTS failures fail the playback request.
- Outbound conversation calls suppress barge-in only while the initial greeting is actively speaking, then re-enable normal interruption.
- Twilio stream disconnect auto-end uses a short grace window so quick reconnects do not end the call.
- Realtime provider selection is generic. Configure `streaming.provider` / `realtime.provider` and put provider-owned options under `providers.<id>`.

## Asterisk inbound AudioSocket

Asterisk must register each call before opening its AudioSocket. Keep both listeners on loopback when Asterisk and OpenClaw share a host. The standard [`AudioSocket()` dialplan application](https://docs.asterisk.org/Latest_API/API_Documentation/Dialplan_Applications/AudioSocket/) uses 8 kHz signed-linear PCM, matching the default `sampleRate: 8000`. The framing follows Asterisk's [AudioSocket protocol](https://docs.asterisk.org/Configuration/Channel-Drivers/AudioSocket/).

```ini
[openclaw-inbound]
exten => 700,1,Set(OPENCLAW_UUID=${UUID()})
 same => n,Set(CURLOPT(httpheader)=Authorization: Bearer ${OPENCLAW_ASTERISK_TOKEN})
 same => n,Set(CURLOPT(httpheader)=Content-Type: application/json)
 same => n,Set(OPENCLAW_BODY={"uuid":"${OPENCLAW_UUID}"\,"from":"${CALLERID(num)}"\,"to":"+49123456700"})
 same => n,Set(OPENCLAW_REG=${CURL(http://127.0.0.1:3334/voice/asterisk/register,${OPENCLAW_BODY})})
 same => n,GotoIf($["${OPENCLAW_REG}" = "Accepted"]?admit:reject)
 same => n(admit),Answer()
 same => n,AudioSocket(${OPENCLAW_UUID},127.0.0.1:9092)
 same => n,Hangup()
 same => n(reject),Hangup(21)
```

Set `OPENCLAW_ASTERISK_TOKEN` from a root-readable Asterisk include instead of committing it. Normalize `CALLERID(num)` to E.164 before registration if your trunk does not already provide it. Configure `inboundPolicy` and `allowFrom`; rejected callers never receive AudioSocket admission. The HTTP response body is deliberately simple (`Accepted`) so the dialplan can gate `Answer()` on successful admission.
