# Live protocol

Live mode uses a single authenticated WebSocket at `/api/ws` for one match. The connection owns GPT-Live and, only when video was selected, a LiveAvatar session.

## Authentication

1. Browser obtains microphone permission before starting any paid session.
2. Browser POSTs `/api/access` with the invite code in `X-Invite-Code` and `X-Voice-Mode: audio` (default UI) or `avatar` (video selected).
3. Server validates origin, live-mode kill switch, required configuration and invite code.
4. Server returns a short-lived HMAC-signed ticket bound to the browser origin and the selected voice mode. Missing mode defaults to `avatar` for older clients; unknown modes are rejected. Audio mode does not require a LiveAvatar key.
5. Browser upgrades `/api/ws?ticket=...`.
6. WebSocket verifies origin and ticket, then acquires an in-process quota lease for this invitation-only demo. Its limits and ticket-reuse tracking do not span instances or restarts. Shared/global spending limits are not implemented in this demo and would be a separate requirement before wider paid access. CPU play needs neither a database nor this connection.

## Client messages

- `start` — start the authoritative 60-second match once voice/avatar is ready.
- `spin` — `{matchId, commandId}`. Requests one player spin. Rival spins are scheduled independently every two seconds. The server advances elapsed deadlines first, rejects duplicate IDs and requests less than 1.1 seconds apart, and never accepts a player draw at or after 60 seconds.
- `upgrade` — retained for historical fixtures; current matches reject it without applying a choice or calling the AI.
- `purchase` — `{matchId, commandId, upgradeId, expectedCount}` buys a player upgrade. The server advances the clock, deduplicates command IDs, checks the current product count, funds and match status, then emits a snapshot. Prices are $5/$10/$15 per product, capped at three purchases. A stale expected count never buys a second level accidentally.
- `mic` — base64 PCM16/24kHz audio. Size limited.
- `voice_close` — release optional media while preserving the match.
- `snapshot` — request latest safe match snapshot.
- `close` — end the whole session.

Unknown/oversized/invalid payloads do not mutate game state.
The connection closes above 120 messages or 192,000 audio base64 characters per one-second bucket; individual JSON input is limited to 300,000 characters. Provider initialization starts an independent 120-second teardown deadline; remote cleanup/final usage can finish later.

## Server messages

- `hello`
- `avatar` — video mode only; LiveKit URL/client token, never provider API keys.
- `voice_audio` — audio mode only; base64 PCM16, mono 24kHz, at most 64,000 base64 characters per message. Consumed by the browser audio adapter without entering ViewModel state.
- `voice_interrupt` — stop and discard scheduled browser PCM sources before accepting new speech.
- `voice_status`
- `snapshot`
- `side_spin` — `{spin: SpinView}` for only the side that drew. Each side owns its round number.
- `spin` — paired messages retained for historical automatic simulations.
- `spin_status` — `{commandId, accepted, retryAfterMs}` acknowledges a manual request, including rejected requests. The client keeps at most one queued input and drops it on result, exit, or hidden page.
- `upgrade_offer` / `upgrade_applied` — historical simulations only; never emitted by current matches.
- `rival_line`
- `transcript`
- `match_ended`
- `error`

Snapshots never contain RNG state, unrevealed choices, reel pools, API credentials, or future results.

`snapshot.stats` is required for both sides: `wins: {cherry, bell, seven}` contains confirmed winning-spin counts; `bestSpin` is `{round, payout}` for the first highest payout, or null when there were no wins. Counts are bounded by that side's completed `snapshot.rounds[side]` count, their payout sum must equal the score, and the best spin must be consistent with those counts. Player input allows 0–55 rounds and up to 66,000 points; the rival completes 30 scheduled rounds. `snapshot.round` aliases `rounds.player`. Every confirmed round remains accounted for after recovery; results are not derived from animation history. A player with zero spins still faces the rival's independent score.

Each new `SpinView` preserves its starting `upgrades` and cumulative `upgradeSpent`. The snapshot includes current `upgradeSpent`; player cash equals initial cash minus spin costs and upgrade spending plus payouts. Latest spin totals are compared after subtracting any spending since that spin. Paid player upgrades allow up to six entries (three per product); the rival remains unmodified in playable sessions.

After authentication, every server message includes `sessionId`, `streamSeq` and `serverTime` (Unix milliseconds). `streamSeq` is a contiguous per-connection delivery sequence and is separate from the domain's `snapshot.eventSeq`. The first message is `hello` at sequence 1. The client validates message shapes, lengths, numbers, symbols and match identity before updating UI or starting media. Initial unauthenticated rejection may have no envelope and is treated as a failed connection.

Duplicate/older deliveries are ignored. A sequence gap requests one current snapshot on the same connection and suppresses incomplete game updates until recovery; optional-media shutdown is still processed immediately. Recovery must arrive within five seconds or the client explicitly ends the interrupted transport. A snapshot contains `lastSpins`, keyed by side, with the most recent confirmed spin for each side that has drawn. It omits a side with zero spins. The wire validator checks each count, side and total independently; missing or inconsistent final spins are rejected. Results wait for both sides' final settled frames. This mechanism never reconnects or starts a different match silently.

## Failure model

The MVP intentionally does not resume a disconnected live match. WebSocket loss aborts it and tears down upstream services. UI can start a fresh rematch explicitly. AI latency never pauses either side's game timer or input. No upgrade inference runs in current matches.

Pending live reaction candidates are scoped to one MatchSession, deduplicated by event/round, checked again against current state and expired after 1.8 seconds. A same-round jackpot outranks a lead change. At most five spontaneous in-match requests are sent, with a three-second interval. The final result clears pending commentary and invalidates that GPT connection's audio/transcript callbacks. After its transport closes and the output buffer is cleared (matching LiveAvatar acknowledgment for video, ordered `voice_interrupt` for browser audio), a second GPT connection receives the final state and a short, explicitly untrusted user quote in its startup context and one final reaction request. Failure skips the reaction. No third connection is attempted.

On a result snapshot or match_ended, the client immediately stops microphone capture/sends, including while recovering a sequence gap. The selected output route remains available for result playback. The server supplies real-time PCM16 24kHz mono silence during this final phase. Its output and timer use the earlier of result+8 seconds or the original session deadline. Stopping voice or the whole session clears timers/candidates. The first UI result transition clears the old caption accumulator; duplicate result messages retain the new caption. The browser PCM queue keeps a 40ms scheduling cushion and discards a queued burst above 750ms; interrupt, stream gaps and cleanup clear its sources. Audio and video never play simultaneously. Actual audible interruption/latency still require user listening checks under #3/#8.
