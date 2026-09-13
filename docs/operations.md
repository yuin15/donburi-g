# Operations

## Fail-closed live mode

Live paid sessions start only when all of the following are configured:

- `LIVE_MODE_ENABLED=true`
- OpenAI key
- LiveAvatar key only when live video was selected
- invite code
- signing key

No database is required for this invitation-only demo. Its in-memory connection guard runs inside the Vercel function; it does not replace a provider budget or a deployment-wide rate limit.

## Limits

Defaults:

- ticket lifetime: 60 seconds
- unused lobby: closes 90 seconds after provider initialization; late start commands obey the same deadline
- voice teardown begins no later than 120 seconds from provider initialization; a playing game continues to its full 60-second result
- a game must start before 90 seconds and finishes before 150 seconds, within the 180-second Vercel execution budget
- selected LiveAvatar video requests `max_session_duration: 120` in the provider token
- result input/output window: at most 8 seconds, bounded by that original 120-second deadline
- GPT-Live connections: at most 2 per match, sequential (play, then final reaction); zero LiveAvatar sessions in audio mode, one only for selected video
- CPU rival BET policy: no AI reasoning; BET3 by default, BET1 when far ahead, BET5 when losing near the end, with an affordable-BET fallback
- mic input per one-second bucket: 192,000 base64 characters
- messages per one-second bucket: 120; individual JSON payload: 300,000 characters
- gap recovery on the same game socket: 5-second timeout
- spontaneous live reactions: up to 5 during play plus 1 final result; pending candidates expire in 1.8 seconds
- daily starts per running process: 10 (configurable)
- concurrent sessions per running process: 1 (configurable)

The process tracks admitted starts, active leases, and used tickets. Session teardown removes the active lease but retains replay protection through ticket expiry. Leases expire after 180 seconds. Restarting or scaling Vercel functions resets or splits these counters; they are intentionally modest demo safeguards, not global spending caps. Use a private invite and short demo sessions. Vercel Firewall rules may be added for wider access without introducing a database. They have not been configured by this code change. Vercel WAF rate-limit counters are per region, including a constant custom key; they do not by themselves establish a deployment-wide concurrency lease or daily spending cap. See the [rate-limiting SDK scope](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting-sdk).

The 120-second deadline starts voice teardown; it is not proof that provider billing or remote resources have already stopped. GPT finalization can take up to 5 seconds, and the subsequent avatar stop request has a 10-second timeout. Verify final usage and residual remote sessions separately. Result reconnection never resets the original deadline. If old GPT closure or the matching LiveAvatar buffer-clear ACK (video mode) fails, abandon result speech and retain the finished game.

## Current invitation-only deployment

On 2026-09-12, the user-authorized GPT-Live-1 demo was enabled on production using the existing Vercel Secret variables. The allowed origin is `https://slot-chan.vercel.app`. The real production transport check finalized 76 seconds for play plus 4 seconds for the result; these are usage measurements, not a currency charge or a provider quota guarantee. See [verification and remaining checks](voice-spike.md).

The demo remains invitation-only. LiveAvatar's corresponding historic session was 95 seconds / 1.6 credits with an end timestamp; the active-session list was empty after teardown. The video token now requests a provider-enforced 120-second maximum, based on the current LITE token schema; forced expiry has not been retested with paid video. A free sandbox check received video and reached the provider's automatic maximum-duration close at 59.195 seconds with no credits consumed and no active session remaining. It requested a 30-second maximum, so it does not prove that the production 120-second parameter expires at the requested time; see [sandbox evidence](voice-spike.md#2026-09-12-free-sandbox-lifecycle-check). Cross-instance global quotas and currency-based billing remain tracked in #11; do not describe the process-local limits as a public service spending cap.

## Kill switch

Set `LIVE_MODE_ENABLED=false` and redeploy to reject new paid sessions. Existing provider sessions should also be reviewed in provider dashboards if responding to an incident.

## Logs

Do not log:

- API keys or session tokens
- invite code
- mic audio
- conversation text
- signed access tickets

Safe operational metrics are session duration, exit reason, aggregate call counts and provider HTTP status class.

`voice_session_usage` records only `phase` (`match`/`result`), `seconds`, and `finalized`. Preserve both generations; closing the match connection must not discard its final usage. Null seconds or `finalized=false` mean final usage is unconfirmed, never zero cost. No conversation, session identifier, email, or key is included.

## Credential leak

1. Disable live mode.
2. Revoke/rotate the exposed credential at the provider.
3. Replace the Vercel environment variable.
4. Purge the leaked value from Git history if it was committed. Deleting it only in a later commit is not sufficient.
5. Review provider usage for abuse before re-enabling live mode.

## Cost measurement

Measure provider usage from real sessions and current provider billing records. Do not treat estimates or practice mode as measured cost. Keep per-match records aggregate-only and do not persist conversation content by default.
