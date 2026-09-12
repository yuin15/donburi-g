# Live protocol

Live mode uses a single authenticated WebSocket at `/api/ws` for one match. The connection also owns the upstream GPT-Live and LiveAvatar sessions.

## Authentication

1. Browser obtains microphone permission before starting any paid session.
2. Browser POSTs `/api/access` with the invite code in `X-Invite-Code`.
3. Server validates origin, live-mode kill switch, required configuration and invite code.
4. Server returns a short-lived HMAC-signed ticket bound to the browser origin.
5. Browser upgrades `/api/ws?ticket=...`.
6. WebSocket verifies origin and ticket, then acquires a quota lease. The invitation-only demo defaults to an in-process store; its limits do not span instances or restarts. An optional shared store provides cross-instance quotas. Ticket reuse is rejected by the selected store. CPU play needs neither store nor this connection.

## Client messages

- `start` — start the authoritative 60-second match once voice/avatar is ready.
- `upgrade` — `{matchId, commandId, offerIndex, upgradeId}`. LiveClient supplies its authenticated match ID. A different match ID is rejected; duplicate command IDs are ignored. Player and asynchronous rival choices are checked against arrival time, not a delayed interval tick.
- `mic` — base64 PCM16/24kHz audio. Size limited.
- `voice_close` — release optional media while preserving the match.
- `snapshot` — request latest safe match snapshot.
- `close` — end the whole session.

Unknown/oversized/invalid payloads do not mutate game state.
The connection closes above 120 messages or 192,000 audio base64 characters per one-second bucket; individual JSON input is limited to 300,000 characters. The 120-second session lifetime remains a separate bound.

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

After authentication, every server message includes `sessionId`, `streamSeq` and `serverTime` (Unix milliseconds). `streamSeq` is a contiguous per-connection delivery sequence and is separate from the domain's `snapshot.eventSeq`. The first message is `hello` at sequence 1. The client validates message shapes, lengths, numbers, symbols and match identity before updating UI or starting media. Initial unauthenticated rejection may have no envelope and is treated as a failed connection.

Duplicate/older deliveries are ignored. A sequence gap requests one current snapshot on the same connection and suppresses incomplete game updates until recovery; optional-media shutdown is still processed immediately. Recovery must arrive within five seconds or the client explicitly ends the interrupted transport. A snapshot contains the most recent confirmed player/rival spin, so missing final-spin or result messages cannot leave the display waiting forever. Results follow that final settled frame. Active upgrade windows can also be reconstructed from snapshot time. This mechanism never reconnects or starts a different match silently.

## Failure model

The MVP intentionally does not resume a disconnected live match. WebSocket loss aborts it and tears down upstream services. UI can start a fresh rematch explicitly. AI latency never pauses the game timer; rival inference uses a bounded deterministic fallback on timeout/failure, and a late answer cannot overwrite the closed choice window.

Pending live reaction candidates are scoped to one MatchSession, deduplicated by event/round, checked again against current state and expired after 1.8 seconds. A same-round jackpot outranks a lead change. At most five spontaneous in-match requests plus one final-result request are sent, with a three-second interval. The final result clears pending old commentary. Stopping voice or the whole session clears all timers/candidates. Already transmitted provider audio and audible interruption/latency still require real-media verification under #3/#8.
