# Live protocol

Live mode uses a single authenticated WebSocket at `/api/ws` for one match. The connection also owns the upstream GPT-Live and LiveAvatar sessions.

## Authentication

1. Browser obtains microphone permission before starting any paid session.
2. Browser POSTs `/api/access` with the invite code in `X-Invite-Code`.
3. Server validates origin, live-mode kill switch, required configuration and invite code.
4. Server returns a short-lived HMAC-signed ticket bound to the browser origin.
5. Browser upgrades `/api/ws?ticket=...`.
6. WebSocket verifies origin and ticket, then acquires a shared daily/concurrency quota lease. Ticket reuse is rejected by the shared lease key.

## Client messages

- `start` — start the authoritative 60-second match once voice/avatar is ready.
- `upgrade` — `{commandId, offerIndex, upgradeId}`. Duplicate `commandId` is ignored; server validates time window and ownership.
- `mic` — base64 PCM16/24kHz audio. Size limited.
- `snapshot` — request latest safe match snapshot.
- `close` — end the whole session.

Unknown/oversized/invalid payloads do not mutate game state.

## Server messages

- `hello`
- `avatar` — LiveKit URL/client token only; provider API keys never reach the browser.
- `voice_status`
- `snapshot`
- `spin`
- `upgrade_offer`
- `upgrade_applied`
- `rival_line`
- `transcript`
- `match_ended`
- `error`

Snapshots never contain RNG state, unrevealed choices, reel pools, API credentials, or future results.

## Failure model

The MVP intentionally does not resume an interrupted live match. WebSocket loss aborts it and tears down upstream services. UI can start a fresh rematch explicitly. AI latency never pauses the game timer; rival upgrade inference falls back to `steady` after timeout/failure.
