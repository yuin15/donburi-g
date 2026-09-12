# GPT-Live × LiveAvatar integration

## Implemented path

`browser microphone → Vercel WebSocket → GPT-Live → LiveAvatar LITE media-server WebSocket → LiveKit → browser`

The server starts a bare LiveAvatar LITE session. It sends the returned LiveKit URL/token to the browser and keeps the media-server `ws_url` server-side. GPT-Live output is continuous PCM16 24kHz, including silence. After LiveAvatar reports `session.state_updated: connected`, the adapter preserves 100ms before speech, groups about 400ms of audio per `agent.speak`, and seals the utterance with `agent.speak_end` after 300ms of silence. Idle silence is not streamed into avatar playback. A 500ms deadline also flushes a short final packet when the upstream stream pauses.

The browser never receives OpenAI or LiveAvatar API keys.

## Conversation behavior

The GPT-Live persona is a short, competitive Japanese rival. Confirmed game state is appended as silent context. Important events request a short reaction:

- seven jackpot
- lead change
- final result

User speech is conversation data and cannot mutate game rules. Reel upgrades and the separate upgrade decision model are disabled in the current game.

Game context has at most one unacknowledged `session.thinking.append`. Changes while it is pending replace a single latest-state slot. Only the matching `client_event_id` releases the next update. Acknowledgment is not proof of playback or of a fully applied game context.

Game reactions use `session.commentary.append`; they do not inject new behavior instructions into an ongoing answer. Recent microphone speech and input transcripts suppress optional commentary for four seconds, and new user activity drops old reaction candidates.

## Interrupts

Sustained microphone PCM activity triggers `agent.interrupt` without waiting for transcript arrival. The provider must acknowledge `agent.audio_buffer_cleared` with the matching interrupt ID before new avatar audio is accepted. A missing acknowledgment ends optional voice; the game continues.

If GPT-Live was speaking, the interrupted output is dropped until 200ms of model silence, with a four-second bound. This is application playback control, not a model turn-end event. Short quiet microphone chunks reset unconfirmed activity so separated key clicks do not accumulate into speech. Real microphones, noise suppression, soft voices, and overlapping speech still require listening checks.

## Required production verification

### Shutdown evidence

The voice transport sends `session.close`, keeps reading `session.closed`, then closes its WebSocket. It allows up to five seconds before forced cleanup. `voice_session_usage` runtime logs contain only `seconds` and `finalized`: cumulative updates replace earlier values; they are not added together. Without the terminal event, the last observed duration is marked unconfirmed. No session configuration, provider ID, audio, or transcript is logged. See [OpenAI usage and graceful close](https://developers.openai.com/api/docs/guides/live-conversations#usage-and-graceful-close).

LiveAvatar `error` and `session.state_updated: disconnected` events now end the media leg and notify the match. Cancellation suppresses late readiness events, and a nonresponsive media socket is terminated after 1.5 seconds. See [LiveAvatar LITE events](https://docs.liveavatar.com/docs/lite-mode/events).

## 2026-09-12 local real-provider checks

`gpt-live-1` and LiveAvatar LITE were connected using the existing ignored credentials. A user confirmed hearing the rival in the real Chrome game, then reported late or missing replies. Completed local matches finalized the match and result usage separately (61–70 seconds and 3 seconds in the observed sessions). These checks do not establish production voice readiness.

A controlled 25-second probe used a locally synthesized Japanese question, not a user recording. Before the fix, input transcripts arrived but no interrupt was requested; 147 of 231 forwarded output packets were silent. After the initial fix, three interrupt acknowledgments arrived in 188–189ms. The reply's `agent.speak_started` event was 1,614ms after the synthetic question's final input packet. The new path emitted utterance commit/end events instead of keeping an idle audio stream open. Provider errors: zero; both probes finalized 23 seconds of GPT-Live usage each. This is one sample per version, measured at server/provider events; it is not an audible latency percentile or a browser lip-sync measurement. The microphone activity guard was subsequently tightened from 80ms to 120ms to avoid accumulated short keyboard transients.

The browser microphone now requests 24kHz with interactive latency and uses 1,024-sample buffers. User caption fragments are accumulated into readable text instead of replacing the whole caption with each small delta. The updated local game is awaiting a user listening check.

Sources: [GPT-Live context and conversation](https://developers.openai.com/api/docs/guides/live-conversations), [GPT-Live interruption prompting](https://developers.openai.com/api/docs/guides/live-prompting), [LiveAvatar utterances and interruption acknowledgments](https://docs.liveavatar.com/docs/lite-mode/events).

## 2026-09-12 production transport verification

Deployment `dpl_CbGsUkzyfk3RyRdNExqzLE5N9geK` (source `108f6440625b35b02848a22691606741b7da0b19`, PR #84) is READY at `https://slot-chan.vercel.app`. Existing server-only secrets are retained; `LIVE_MODE_ENABLED=true`. Unauthenticated CPU play remains independent.

A real authenticated public WebSocket used synthesized question audio, held a ready connection for 22 seconds, then played the full 60-second game. This was a protocol client, not a browser listening test.

| Measurement | Observed |
| --- | --- |
| Access response | HTTP 200 |
| Provider readiness from access request | 4,665ms |
| Total access/connection/teardown duration | 97,761ms |
| Ordered server messages | 388, with 0 sequence gaps |
| Manual spins / independent rival spins | 16 / 30 |
| Final player / rival coins | 240 / 600 |
| Payout totals vs symbol counts | Match for both sides |
| User / assistant transcript characters | 12 / 178; content not retained |
| WebSocket close | 1000, no reported errors |
| GPT-Live match usage from Vercel logs | 76 seconds, finalized=true |
| GPT-Live result usage from Vercel logs | 4 seconds, finalized=true |

The 22-second ready hold was only to exercise the 90-second transport acceptance case; the normal browser starts its countdown after connection readiness. The production runtime region was `iad1`. Vercel status and the terminal usage logs were checked separately from the client's normal close. LiveAvatar residual-session inspection and actual browser audio/video timing remain open.

Production browser verification remains open. Record, without conversation content or credentials:

- deployment/commit
- browser and network
- first avatar frame latency
- first audible response latency
- important-event → audible-response latency
- 90-second connection survival
- barge-in behavior
- normal close and tab-close teardown, repeated at least three times

Do not mark mock/practice results as live-provider verification.
