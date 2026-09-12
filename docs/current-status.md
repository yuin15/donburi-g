# Slot-chan completion status

## Verified locally (2026-09-12)

- TypeScript, ESLint, 36 unit/integration tests, and the production build pass.
- Six lifecycle regressions were reproduced before the fix: disconnects during avatar/media/OpenAI startup, result cleanup, fatal voice errors, and repeated initialization.
- A real loopback WebSocket test verifies that a disconnect during quota allocation returns the lease without starting providers.
- Mock provider tests verify startup-error cleanup, bounded transport shutdown, the live kill switch, ticket expiry, and the final 60-second snapshot.
- ESLint now excludes generated bundles globally, so running lint after a build works.
- The invitation-only demo requires no Redis/Upstash. Its in-process admission guard defaults to 10 starts/day and one active session, retains used tickets after cleanup, and expires abandoned leases. Tests verify concurrency, replay, late cleanup, daily rollover, and expiry. These counters are not global limits across Vercel instances or restarts.
- Browser connection tests verify late microphone permission, refused access, early socket closure, combined readiness, late avatar tracks, and audio startup failure. The UI can exit, return to the gate on failure, and preserve AI-audio mute on reconnect.
- Chrome practice verification covered start, both upgrade choices (20s/40s), selected-button feedback, the 60-second result, and rematch. Start is disabled during countdown. Screenshots identified and verified a fix for clipped reels; the visible title is Slot-chan.
- These tests do not use paid APIs, real microphone input, or real avatar playback.

## Still required for the MVP

- Verify browser microphone-denial and live disconnect recovery against the deployed service, and check Edge/mobile layout. Local provider mocks are not a real live-session test.
- Configure the deployment's server-only environment, inspect its GitHub linkage, and verify the candidate deployment.
- Verify three complete real-provider matches, 90-second connection survival, interruptions, teardown, latency, and measured usage. Local mocked tests are not evidence for these items.
- Complete first-time playtests and record the observations required by Issue #12.

## Deployment state

- The Vercel project exists but is still deployed through the CLI, without a Git repository connection.
- A free Upstash database was created during setup; it is not connected to this game and is not required by the current code. No paid plan was selected. No Vercel Firewall rule has been added by these changes.

## Provider references

- [LiveAvatar session stop](https://docs.liveavatar.com/api-reference/sessions/stop-session): the existing `POST /v1/sessions/stop` endpoint accepts the session ID with server-side API-key authentication.
- [OpenAI GPT-Live](https://developers.openai.com/api/docs/guides/live): startup, audible response, and teardown are separate checks; voice sessions bill by duration.

Credentials and personal contact details belong only in ignored local files or the hosting provider's secret store. Do not include them in verification evidence.
