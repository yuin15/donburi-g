# Operations

## Fail-closed live mode

Live paid sessions start only when all of the following are configured:

- `LIVE_MODE_ENABLED=true`
- OpenAI key
- LiveAvatar key
- invite code
- signing key

No database is required for this invitation-only demo. Its in-memory connection guard runs inside the Vercel function; it does not replace a provider budget or a deployment-wide rate limit.

## Limits

Defaults:

- ticket lifetime: 60 seconds
- server session hard limit: 120 seconds
- normal result reaction window: 8 seconds
- rival reasoning: max two calls per match, each ~2.5 second timeout
- mic input per one-second bucket: 192,000 base64 characters
- messages per one-second bucket: 120; individual JSON payload: 300,000 characters
- gap recovery on the same game socket: 5-second timeout
- spontaneous live reactions: up to 5 during play plus 1 final result; pending candidates expire in 1.8 seconds
- daily starts per running process: 10 (configurable)
- concurrent sessions per running process: 1 (configurable)

The process tracks admitted starts, active leases, and used tickets. Session teardown removes the active lease but retains replay protection through ticket expiry. Leases expire after 180 seconds. Restarting or scaling Vercel functions resets or splits these counters; they are intentionally modest demo safeguards, not global spending caps. Use a private invite and short demo sessions. Vercel Firewall rules may be added for wider access without introducing a database. They have not been configured by this code change.

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
