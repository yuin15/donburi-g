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

The default Luna model uses `reasoning.effort: none` with a 64-token output budget for this two-option decision. Reasoning tokens share the output budget, so the previous 12-token budget with reasoning enabled could exhaust it before producing a choice. Only an exact legal output is accepted, and current upgrade effects are included in its context. See [Luna model settings](https://developers.openai.com/api/docs/models/gpt-5.6-luna) and [Responses output budget](https://developers.openai.com/api/reference/cli/resources/responses/methods/create). Live provider response quality remains to be verified.

## Interrupts

Input transcripts start an interruption watch. If the live model yields, queued avatar speech is cleared with `agent.interrupt` so old speech does not continue after the conversation changed.

## Required production verification

### Shutdown evidence

The voice transport sends `session.close`, keeps reading `session.closed`, then closes its WebSocket. It allows up to five seconds before forced cleanup. `voice_session_usage` runtime logs contain only `seconds` and `finalized`: cumulative updates replace earlier values; they are not added together. Without the terminal event, the last observed duration is marked unconfirmed. No session configuration, provider ID, audio, or transcript is logged. See [OpenAI usage and graceful close](https://developers.openai.com/api/docs/guides/live-conversations#usage-and-graceful-close).

LiveAvatar `error` and `session.state_updated: disconnected` events now end the media leg and notify the match. Cancellation suppresses late readiness events, and a nonresponsive media socket is terminated after 1.5 seconds. See [LiveAvatar LITE events](https://docs.liveavatar.com/docs/lite-mode/events).

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
