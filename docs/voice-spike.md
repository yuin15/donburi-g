# GPT-Live voice with optional LiveAvatar video

## Implemented paths

Default voice-only route:

`browser microphone → Vercel WebSocket → GPT-Live → Vercel WebSocket → browser PCM player`

Selecting live video uses:

`browser microphone → Vercel WebSocket → GPT-Live → LiveAvatar LITE media-server WebSocket → LiveKit → browser`

Voice-only mode starts no LiveAvatar session and never loads LiveKit. Its selected mode is signed into the access ticket. The PCM adapter plays mono 24kHz audio with a short buffer; interruption clears all scheduled sources. Mute and cleanup apply to the selected output route.

For video, the server starts a bare LiveAvatar LITE session with `max_session_duration: 120`. It sends the returned LiveKit URL/token to the browser and keeps the media-server `ws_url` server-side. GPT-Live output is continuous PCM16 24kHz, including silence. After LiveAvatar reports `session.state_updated: connected`, the adapter preserves 100ms before speech, groups about 400ms of audio per `agent.speak`, and seals the utterance with `agent.speak_end` after 300ms of silence. Idle silence is not streamed into avatar playback. A 500ms deadline also flushes a short final packet when the upstream stream pauses.

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

Sustained microphone PCM activity clears browser playback immediately in voice-only mode, or triggers `agent.interrupt` in video mode, without waiting for transcript arrival. The provider must acknowledge `agent.audio_buffer_cleared` with the matching interrupt ID before new avatar audio is accepted. A missing acknowledgment ends optional voice; the game continues.

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
| LiveAvatar historic record | LITE/API, 95 seconds, 1.6 credits, ended timestamp present |
| LiveAvatar active sessions after teardown | 0 |

The 22-second ready hold was only to exercise the 90-second transport acceptance case; the normal browser starts its countdown after connection readiness. The production runtime region was `iad1`. Vercel status and the terminal usage logs were checked separately from the client's normal close. The provider's historic record had `end_reason=UNKNOWN`; the end timestamp plus zero active sessions confirms no residual session at that inspection, not a more specific provider end reason. Actual browser audio/video timing remains open. The checks used the [session listing](https://docs.liveavatar.com/api-reference/sessions/list-sessions) endpoint and retained no provider IDs.

The free sandbox supports LITE session tokens, but the documented avatar is Wayne and sessions end after about one minute. That limit does not cover normal connection startup, countdown, the 60-second game, and the final reaction. It is suitable for short development checks; it has not replaced the production path. See [sandbox constraints](https://docs.liveavatar.com/docs/sandbox-mode).

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
## 2026-09-12 voice-only browser check (#86)

Local Chrome at 1280×720 connected through the real GPT-Live API with video unchecked. The microphone was already authorized by the user. `VOICE READY` appeared with the existing rival artwork and hidden video. After PLAY and Space input, the 60-second result contained player 2 spins / 0 coins and rival 30 spins / 480 coins. The connection closed normally into rematch-ready state. Match/result usage finalized at 84/3 seconds; the longer match usage includes time spent checking the ready screen. No user speech was present during this browser run; generated speech transcripts were counted, not retained. This validates browser connection, game progression and teardown, not a human listening assessment.

The expanded voice gate also fits 1280×720: optional instructions and all controls are visible without clipping the headline. Automated boundary checks cover signed mode selection, full audio-only server completion without avatar start/stop, the exclusive client playback routes, PCM decoding, interruption, bounded queueing and cleanup. Typecheck, lint, runtime import check and production build pass; 228 tests pass across the existing suite and the new PCM-player checks.
A separate local protocol run sent synthesized Japanese question audio into the real voice-only route. Readiness was 800ms; 927 ordered messages had zero gaps, including 575 PCM packets and no avatar event. Three microphone activity interrupts plus the result reset were delivered. The first non-silent PCM after the final question packet arrived 200ms later; that is transport timing from one sample, not proof of a complete semantic reply or human audible latency. The game finished 16 / 30 spins, 240 / 600 coins, with consistent payout totals and normal close 1000. Final GPT usage was 56 seconds for play and 4 for the result. The protocol test's timer-driven input does not establish a real microphone clock or a latency percentile.

![Voice-only connection controls at 1280×720, with an empty invite field](evidence/voice-only/gate-1280.webp)
## 2026-09-12 voice-only production release

PR #87 merged as `63a5827f650052db5af5af630b573d6848ee51dd`; PR CI `34692346148` and post-merge CI `34692381994` passed. Vercel deployment `dpl_FCjMhbZS6tJQExRwrnSzg6LvgVGg` is READY with the public alias. Public Chrome shows the new voice-only default and optional unchecked video control. The loaded assets are `index-DcXOweyw.js` and `index-C_glZ5y0.css`.
The public voice-only protocol run completed in 73.188 seconds, with readiness at 2.290 seconds. It received 933 ordered messages (0 gaps), 588 PCM packets, 3 speech interrupts plus the result reset, and no avatar event. The synthesized caller's check that the rival could hear was answered; transcript content was inspected only for the synthetic test and was not saved. The first non-silent PCM after the final question packet arrived 861ms later (one transport sample, not a browser listening percentile). The score-related reply still needs alignment with event timing under #8. Final results were 16 / 30 spins and 240 / 600 coins, with matching payout counts; WebSocket closed 1000 with no errors. Vercel logs separately confirmed GPT usage of 56 seconds for the match and 4 for the result, both finalized=true.

The public browser is waiting for a separate site microphone permission; the user's earlier localhost permission does not transfer to this origin. No permission override was applied. Local real-Chrome completion and public real-API completion are reported separately until this browser step can finish.
## Latest-score context follow-up (#8)

The repeated update now contains the explicit current leader and omits unchanged rules that are already in the startup persona. New confirmed state supersedes old scores. The existing catch-up and before-microphone checks retain the correct scores, last spins, result and current leader.

A controlled 23-second real GPT-Live check used the actual server formatter with a synthetic change from 0–0 to player 1,200 / rival 0, then rival 240. The synthesized question about who was ahead received a player-leading reply. Updates were 69–139 characters; all 23 context acknowledgments reported estimated injection ranges of 200ms. Those ranges describe context ingestion, not audible response latency. Usage finalized at 21 seconds, with no reported provider errors. This single controlled sample does not establish that every rapidly changing score will be reflected in speech. Actual microphone listening remains pending.
The follow-up implementation `98a5ee0cf2d6f082ea021941c342a8701c092bda` passed CI `34692986660` and is deployed as READY `dpl_2zb5jzsH19SPBJssR8pfAAU8KseM`. The browser assets are unchanged from #87, and an unauthenticated audio access request still returns HTTP 401. The preceding public 60-second voice-only measurements belong to #87; this prompt/context follow-up was checked with the actual formatter and real GPT-Live locally.
## 2026-09-12 free sandbox lifecycle check

A separate local receiver connected to the provider's LITE sandbox using its documented Wayne avatar. It used no microphone or GPT-Live and requested `max_session_duration: 30`. Token creation returned HTTP 200 and start returned HTTP 201. LiveKit connected at 1,310ms, the media leg was ready at 1,604ms, and the first video track arrived at 1,760ms. Chrome exposed a 1280×720 video with readyState 4.

The provider media WebSocket closed normally with code 1000 at 59,195ms, before the probe's 75-second watchdog. The stop request returned HTTP 200; the ended history record reported `MAX_DURATION_REACHED`, zero consumed credits, and an end timestamp. The active-session list was empty. The separate credit balance check also showed zero change. No provider IDs, tokens, audio or conversation were retained in repository evidence.

The requested 30-second value did not produce a 30-second expiry. The observed lifetime is close to the [documented one-minute sandbox limit](https://docs.liveavatar.com/docs/sandbox-mode), but the precedence of those limits was not established. Sandbox history reported duration 0 despite the measured video connection; that usage field is not wall-clock duration. The browser's LiveKit-disconnected event was not observed. This confirms sandbox video reception and provider-side automatic termination; it does not establish paid-video 120-second expiry, browser lip-sync, or real speech quality.

## Voice deadline and late-start games (#90)

A previous implementation let a player starting after an 80-second ready wait lose voice at the original 120-second connection limit with time still on the clock. Audio-only PLAY now re-arms a bounded deadline: at least 95 seconds of deadline budget for a 70-second extended duel, its 15-second confirmed-line fallback, and its 8-second final reaction, with teardown beginning within 170 seconds of connection. Its unused lobby closes at 75 seconds. LiveAvatar keeps its provider-issued 120-second token and therefore closes an unused lobby at 25 seconds rather than start a shortened duel. These limits prevent the local timeout from truncating a reserved duel; they do not prove an external provider cannot close first.

Focused lifecycle checks use fake clocks: audio starts at 74 seconds, crosses the former 120-second deadline, waits through a 15-second accepted-line fallback, completes the 70-second extended duel and final reaction before the 170-second cap. Avatar idling reaches its 25-second retry path before a shortened duel begins. These checks substitute providers and are not real API duration measurements.
The local real GPT-Live audio route then held readiness for 80 seconds before starting. Voice stopped at 120,043ms from the access request; four subsequent manual spins were accepted, with no later audio packet. The game completed 60,099ms after start, with 8 player spins / 120 coins versus 30 rival spins / 240 coins. All 1,336 server messages were sequential, payout totals matched, and the socket closed normally with code 1000 at 140,951ms. The single GPT connection finalized 113 seconds of usage; no result reconnection or avatar session occurred. Synthetic question audio was used, and only transcript lengths were retained. This confirms real local API teardown and the full late-start game, separately from human listening.
The same long-wait probe then ran against production deployment `dpl_BXXgGMqGpNTaepupCCVqPLRtLTFB` (source `97ca8c69c45631d8990ed66f8db8041ffd00595a`). Ready arrived at 2,576ms; after the 80-second wait, the game began at 82,584ms. Voice stopped at 121,229ms from the access request (initializing/connecting was observed at 1,222ms). Four later manual spins were accepted, no audio arrived after voice closure, and the game completed after 60,232ms. The result was 8 / 30 spins and 1,320 / 240 coins, with matching payout counts and a player win. All 1,399 messages were sequential; the socket closed normally with code 1000 at 142,821ms, with no errors. Vercel logs separately confirmed one match usage of 111 seconds, finalized=true, and no result generation. No LiveAvatar session was requested. The public page retained the #87 JS/CSS assets. This is real public API and game-transport verification; browser listening and microphone responsiveness remain a separate check.
