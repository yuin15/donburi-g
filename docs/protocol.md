# Live protocol

Live mode uses a single authenticated WebSocket at `/api/ws` for one match. The connection also owns the upstream GPT-Live and LiveAvatar sessions.

## Authentication

1. Browser obtains microphone permission before starting any paid session.
2. Browser POSTs `/api/access` with the invite code in `X-Invite-Code`.
3. Server validates origin, live-mode kill switch, required configuration and invite code.
4. Server returns a short-lived HMAC-signed ticket bound to the browser origin.
5. Browser upgrades `/api/ws?ticket=...`.
6. WebSocket verifies origin and ticket, then acquires an in-process quota lease for this invitation-only demo. Its limits and ticket-reuse tracking do not span instances or restarts. Shared/global spending limits are not implemented in this demo and would be a separate requirement before wider paid access. CPU play needs neither a database nor this connection.

## Client messages

- `start` — start the authoritative 60-second match once voice/avatar is ready.
- `spin` — `{matchId, commandId}`. Requests one simultaneous player/rival spin. The server advances elapsed deadlines first, rejects duplicate IDs and requests less than 1.1 seconds apart, and never draws at or after 60 seconds.
- `upgrade` — `{matchId, commandId, offerIndex, upgradeId}`. LiveClient supplies its authenticated match ID. A different match ID is rejected; duplicate command IDs are ignored. Player and asynchronous rival choices are checked against arrival time, not a delayed interval tick.
- `mic` — base64 PCM16/24kHz audio. Size limited.
- `voice_close` — release optional media while preserving the match.
- `snapshot` — request latest safe match snapshot.
- `close` — end the whole session.

Unknown/oversized/invalid payloads do not mutate game state.
The connection closes above 120 messages or 192,000 audio base64 characters per one-second bucket; individual JSON input is limited to 300,000 characters. Provider initialization starts an independent 120-second teardown deadline; remote cleanup/final usage can finish later.

## Server messages

- `hello`
- `avatar` — LiveKit URL/client token only; provider API keys never reach the browser.
- `voice_status`
- `snapshot`
- `spin`
- `spin_status` — `{commandId, accepted, retryAfterMs}` acknowledges a manual request, including rejected requests. The client keeps at most one queued input and drops it on result, exit, or hidden page.
- `upgrade_offer`
- `upgrade_applied`
- `rival_line`
- `transcript`
- `match_ended`
- `error`

Snapshots never contain RNG state, unrevealed choices, reel pools, API credentials, or future results.

`snapshot.stats` is required for both sides: `wins: {cherry, bell, seven}` contains confirmed winning-spin counts; `bestSpin` is `{round, payout}` for the first highest payout, or null when there were no wins. Counts are bounded by the completed round count, their payout sum must equal the score, and the best spin must be consistent with those counts. Manual matches allow 0–55 rounds and up to 66,000 points. Every confirmed round remains accounted for after recovery; results are not derived from animation history. A zero-spin match can end in a zero-score draw.

Each new `SpinView` includes its side's confirmed `upgrades` at the time of that draw. This keeps a delayed animation on the correct display strip even when a newer snapshot includes a later upgrade. The field is optional when validating older fixture messages; it contains no random state or future result.

After authentication, every server message includes `sessionId`, `streamSeq` and `serverTime` (Unix milliseconds). `streamSeq` is a contiguous per-connection delivery sequence and is separate from the domain's `snapshot.eventSeq`. The first message is `hello` at sequence 1. The client validates message shapes, lengths, numbers, symbols and match identity before updating UI or starting media. Initial unauthenticated rejection may have no envelope and is treated as a failed connection.

Duplicate/older deliveries are ignored. A sequence gap requests one current snapshot on the same connection and suppresses incomplete game updates until recovery; optional-media shutdown is still processed immediately. Recovery must arrive within five seconds or the client explicitly ends the interrupted transport. A snapshot contains the most recent confirmed player/rival spin, so missing final-spin or result messages cannot leave the display waiting forever. Results follow that final settled frame. Active upgrade windows can also be reconstructed from snapshot time. This mechanism never reconnects or starts a different match silently.

## Failure model

The MVP intentionally does not resume a disconnected live match. WebSocket loss aborts it and tears down upstream services. UI can start a fresh rematch explicitly. AI latency never pauses the game timer; rival inference uses a bounded deterministic fallback on timeout/failure, and a late answer cannot overwrite the closed choice window.

Pending live reaction candidates are scoped to one MatchSession, deduplicated by event/round, checked again against current state and expired after 1.8 seconds. A same-round jackpot outranks a lead change. At most five spontaneous in-match requests are sent, with a three-second interval. The final result clears pending commentary and invalidates that GPT connection's audio/transcript callbacks. After its transport closes and LiveAvatar acknowledges the matching buffer-clear event, a second GPT connection receives the final state and a short, explicitly untrusted user quote in its startup context and one final reaction request. Failure skips the reaction. No third connection is attempted.

On a result snapshot or match_ended, the client immediately stops microphone capture/sends, including while recovering a sequence gap. LiveKit remains available for result playback. The server supplies real-time PCM16 24kHz mono silence during this final phase. Its output and timer use the earlier of result+8 seconds or the original session deadline. Stopping voice or the whole session clears timers/candidates. The first UI result transition clears the old caption accumulator; duplicate result messages retain the new caption. Already delivered browser audio and actual interruption/latency still require real-media verification under #3/#8.
