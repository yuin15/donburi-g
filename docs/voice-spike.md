# GPT-Live × LiveAvatar integration

## Implemented path

`browser microphone → Vercel WebSocket → GPT-Live → LiveAvatar LITE media-server WebSocket → LiveKit → browser`

The server starts a bare LiveAvatar LITE session. It sends the returned LiveKit URL/token to the browser and keeps the media-server `ws_url` server-side. GPT-Live output audio is forwarded as PCM16 24kHz `agent.speak` frames only after LiveAvatar reports `session.state_updated: connected`.

The browser never receives OpenAI or LiveAvatar API keys.

## Conversation behavior

The GPT-Live persona is a short, competitive Japanese rival. Confirmed game state is appended as silent context. Important events request a short reaction:

- seven jackpot
- lead change
- upgrade application
- final result

User speech is treated as conversation data and cannot mutate game rules. A separate Responses API call chooses the rival's legal upgrade at each window, constrained to `steady` or `jackpot`, with a short timeout and deterministic fallback.

## Interrupts

Input transcripts start an interruption watch. If the live model yields, queued avatar speech is cleared with `agent.interrupt` so old speech does not continue after the conversation changed.

## Required production verification

Code integration is present, but real-provider validation must be run with deployment secrets and account access before claiming the live path verified. Record, without conversation content or credentials:

- deployment/commit
- browser and network
- first avatar frame latency
- first audible response latency
- important-event → audible-response latency
- 90-second connection survival
- barge-in behavior
- normal close and tab-close teardown, repeated at least three times

Do not mark mock/practice results as live-provider verification.
