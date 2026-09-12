# Slot-chan completion status

## Verified locally (2026-09-12)

- TypeScript, ESLint, 47 unit/integration tests, and the production build pass.
- `npm run check:server-runtime` compiles server code with NodeNext and starts the emitted HTTP/WebSocket APIs directly. It verifies disabled-live rejection without contacting providers; CI runs this check to catch ESM import failures hidden by Vitest.
- Six lifecycle regressions were reproduced before the fix: disconnects during avatar/media/OpenAI startup, result cleanup, fatal voice errors, and repeated initialization.
- A real loopback WebSocket test verifies that a disconnect during quota allocation returns the lease without starting providers.
- Mock provider tests verify startup-error cleanup, bounded transport shutdown, the live kill switch, ticket expiry, and the final 60-second snapshot.
- ESLint now excludes generated bundles globally, so running lint after a build works.
- The invitation-only demo requires no Redis/Upstash. Its in-process admission guard defaults to 10 starts/day and one active session, retains used tickets after cleanup, and expires abandoned leases. Tests verify concurrency, replay, late cleanup, daily rollover, and expiry. These counters are not global limits across Vercel instances or restarts.
- Browser connection tests verify late microphone permission, refused access, early socket closure, combined readiness, late avatar tracks, and audio startup failure. The UI can exit, return to the gate on failure, and preserve AI-audio mute on reconnect.
- Chrome practice verification covered start, both upgrade choices (20s/40s), selected-button feedback, the 60-second result, and rematch. Start is disabled during countdown. Screenshots identified and verified a fix for clipped reels; the visible title is Slot-chan.
- Both upgrade strategies were measured across 10,000 hashed seeds with both seat assignments (20,000 games per pairing). Effects are now cherry +6 / seven +1; see `docs/game-balance.md`. Winning, losing, drawing, and last-10-second comeback fixtures are in the domain tests.
- Upgrade choices lock after the first submission, matching server rules. Server receipt time decides the deadline even if its interval is delayed. Rival output must be an exact legal choice; ambiguous, truncated, or timed-out responses use a deterministic fallback.
- These tests do not use paid APIs, real microphone input, or real avatar playback.

## Still required for the MVP

- Verify browser microphone-denial and live disconnect recovery against the deployed service, and check Edge/mobile layout. Local provider mocks are not a real live-session test.
- Git-based automatic deployment remains unconnected. Manual deployments through the connected Vercel API are available; server-only environment configuration and deployed API rejection have been verified.
- Verify three complete real-provider matches, 90-second connection survival, interruptions, teardown, latency, and measured usage. Local mocked tests are not evidence for these items.
- Complete first-time playtests and record the observations required by Issue #12.

## Deployment state

- Production deployment `dpl_HMZTim5PWQ1jSXxsWBMHrJKkSqha` reached READY at `https://slot-chan.vercel.app`, with PR #20's Node ESM import fix. A public smoke check confirmed `/api/access` returns HTTP 401 with `invalid_access`; `/api/ws` completes the WebSocket handshake, returns `session_rejected`, and closes with code 1008 while live mode is disabled. These checks do not start provider sessions.
- PR #17 through #20 are merged; deployed main commit `fadcf71d938c41f598f0788b07f7893b4f39713e` passed post-merge CI (run `34662021563`). The preceding deployment's HTTP 500 was traced to extensionless server imports; emitted JavaScript startup is now covered in CI. Git-based automatic deployment is not connected; the GitHub account-selection popup did not respond to browser automation. Deployments can still be created using the connected Vercel API.
- OpenAI/LiveAvatar keys, signing key, and invite code are saved as Vercel Secrets for Production and Preview. Live mode is explicitly disabled, allowed origin is the public Slot-chan URL, and per-process demo limits are configured. Actual API use is awaiting confirmation of the bounded test budget.
- A free Upstash database was created during setup; it is not connected to this game and is not required by the current code. No paid plan was selected. No Vercel Firewall rule has been added by these changes.

## Provider references

- [LiveAvatar session stop](https://docs.liveavatar.com/api-reference/sessions/stop-session): the existing `POST /v1/sessions/stop` endpoint accepts the session ID with server-side API-key authentication.
- [OpenAI GPT-Live](https://developers.openai.com/api/docs/guides/live): startup, audible response, and teardown are separate checks; voice sessions bill by duration.

Credentials and personal contact details belong only in ignored local files or the hosting provider's secret store. Do not include them in verification evidence.
