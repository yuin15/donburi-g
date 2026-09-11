# Slot-chan completion status

## Verified locally (2026-09-12)

- TypeScript, ESLint, 35 unit/integration tests (including five against real Redis), and the production build pass.
- Six lifecycle regressions were reproduced before the fix: disconnects during avatar/media/OpenAI startup, result cleanup, fatal voice errors, and repeated initialization.
- A real loopback WebSocket test verifies that a disconnect during quota allocation returns the lease without starting providers.
- Mock provider tests verify startup-error cleanup, bounded transport shutdown, the live kill switch, ticket expiry, and the final 60-second snapshot.
- ESLint now excludes generated bundles globally, so running lint after a build works.
- Quota admission now uses one atomic Redis script, its UTC clock, expiring concurrency leases, and replay markers retained after cleanup. Real Redis tests cover concurrent admission, rejection accounting, replay, abandoned leases, late cleanup, daily rollover, and delayed expiry. CI provisions Redis; locally set `REDIS_TEST_PORT` for a dedicated loopback Redis instance (test database 15).
- These tests do not use paid APIs, real microphone input, or real avatar playback.

## Still required for the MVP

- Provision the production shared quota store and verify its REST configuration. Atomic admission is tested locally; provider REST behavior still needs deployment verification.
- Browser lifecycle: prevent duplicate countdowns/starts, recover from connection failures, stop microphone/avatar resources, and give feedback when an upgrade is selected.
- Replace the old visible title with Slot-chan and verify layout, reel upgrades, result, and rematch in Chrome/Edge.
- Configure the deployment's server-only environment, inspect its GitHub linkage, and verify the candidate deployment.
- Verify three complete real-provider matches, 90-second connection survival, interruptions, teardown, latency, and measured usage. Local mocked tests are not evidence for these items.
- Complete first-time playtests and record the observations required by Issue #12.

## Provider references

- [LiveAvatar session stop](https://docs.liveavatar.com/api-reference/sessions/stop-session): the existing `POST /v1/sessions/stop` endpoint accepts the session ID with server-side API-key authentication.
- [OpenAI GPT-Live](https://developers.openai.com/api/docs/guides/live): startup, audible response, and teardown are separate checks; voice sessions bill by duration.

Credentials and personal contact details belong only in ignored local files or the hosting provider's secret store. Do not include them in verification evidence.
