# Operations

## Fail-closed live mode

Live paid sessions start only when all of the following are configured:

- `LIVE_MODE_ENABLED=true`
- OpenAI key
- LiveAvatar key
- invite code
- signing key
- shared quota REST URL/token

Missing shared quota configuration rejects paid sessions instead of falling back to per-process counters.

## Limits

Defaults:

- ticket lifetime: 60 seconds
- server session hard limit: 120 seconds
- normal result reaction window: 8 seconds
- rival reasoning: max two calls per match, each ~2.5 second timeout
- max mic WebSocket message: 256 KB base64 field
- global daily sessions: 100 (configurable)
- global concurrent sessions: 5 (configurable)

The shared store tracks a daily counter, global concurrent counter, and one-time ticket/session lease. Session teardown decrements concurrency and removes the lease. The daily counter is intentionally not decremented: it represents starts, not successful completions.

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

## Credential leak

1. Disable live mode.
2. Revoke/rotate the exposed credential at the provider.
3. Replace the Vercel environment variable.
4. Purge the leaked value from Git history if it was committed. Deleting it only in a later commit is not sufficient.
5. Review provider usage for abuse before re-enabling live mode.

## Cost measurement

Measure provider usage from real sessions and current provider billing records. Do not treat estimates or practice mode as measured cost. Keep per-match records aggregate-only and do not persist conversation content by default.
