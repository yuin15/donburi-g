# Slot-chan completion status

## Scope

The core game is a free, local 60-second CPU slot battle with two upgrades and rematch. OpenAI voice and LiveAvatar video are optional additions. They are not prerequisites for playing or completing the core game. No shared database is required. Game graphics use Three.js; controls and readable text use HTML.

## Verified implementation (2026-09-12)

- CPU entry requires no invite, microphone, keys or external API. Browser observation of a complete match recorded zero external/API requests without observation-buffer truncation (PR #25).
- The common game domain resolves 30 rounds, upgrades at 20/40 seconds with 24/44-second deadlines, final-round scoring, win/loss/draw and rematch. Deterministic fixtures include a last-ten-second comeback. Strategy distributions are documented in `game-balance.md`.
- Player selections lock on first submission. CPU player and rival input now use the actual monotonic clock rather than the last timer update; stalled-timer deadline and rematch regressions are tracked in #30.
- Three.js draws the cabinet, backdrop panel, reels, winning line and bounded jackpot coins with one renderer. Idle and hidden scenes stop scheduling frames; shared textures and all scene resources have cleanup coverage (PR #29).
- The optional LiveKit SDK loads only when avatar playback is requested. PR #29's public entry loaded only the main JavaScript file. Initial gzip JavaScript fell from 279 KB to about 134 KB. A five-second idle sample measured 0 ms script time and 0.393 ms total task time; this is not a claim of 60 fps on every device.
- Browser checks cover both pointer/keyboard upgrade choices, locked selection feedback, full 60-second matches, result, rematch, countdown cancellation, effect mute and exit. 1280×720 and 1920×1080 layouts were visually checked under PR #27. Reduced-motion preference was recognized by the browser.
- Optional-media failures are isolated from an already connected game. Tests verify the same match completes 30 spins and its second upgrade after media shutdown. Initial connection failure prepares CPU play. Game-WebSocket loss is reported as a separate interruption (PR #25).
- Tests cover token rejection, quota/replay, emitted Node ESM startup, WebSocket lifecycle, bounded provider cleanup, late microphone/SDK callbacks, sound resources and Three.js lifecycle. The current local suite has 75 passing tests; lint, TypeScript/build and emitted-server checks pass. The build retains a large-chunk warning.

## Latest verified game publication

- Public URL: https://slot-chan.vercel.app
- main: `15dd8091113add0bebe5db6c43f811f9809dc431` (PR #31)
- Vercel READY: `dpl_7SZytpFKzrNqpwgw7cDpcaMCTWjD`
- Post-merge CI: https://github.com/yuin15/donburi-g/actions/runs/34666048223 (success)
- Public CPU start and Three.js graphics were checked. Disabled-live smoke returned HTTP 401 `invalid_access` and WebSocket `session_rejected` / close 1008, without starting providers.
- Actual Windows Chrome 152 completed three consecutive published CPU matches: 600–3,480 loss, 600–120 win and 1,080–1,080 draw. Both upgrades were manually chosen in match two; default choices, rematch reset, effect mute and countdown cancellation were also checked. See `browser-release-check.md` for scope and remaining gaps.
- Git-based automatic deployment is not connected; manual deployment through the connected Vercel API is available.

## Remaining core verification

- Complete first-time play observations under #12: win condition, upgrade meaning, four-second choice time, sound quality and willingness to rematch. Do not collect names, emails or conversation content. Automated play is not a substitute for these observations.
- Verify the main flow and failure states in actual Edge. In-app Chromium and domain/client tests do not establish Edge coverage.
- Finish the requirement-by-requirement issue audit. Open optional-provider issues do not make CPU play dependent on their approval or services.

## Optional voice/video remains disabled

- Keys, signing key and invite code are in ignored local configuration and Vercel server Secrets. `LIVE_MODE_ENABLED=false` remains in force; real-provider API use awaits the previously requested bounded-test approval.
- Before enabling it, verify three real-provider matches, connection survival, interruption, audible response, teardown, latency and actual usage. Provider mocks do not prove these results. Actual browser microphone-denial verification is also pending.
- The invitation-only demo uses an in-process guard (10 starts/day, one active session by default), replay prevention and lease expiry. These are not global limits across instances or restarts. General paid access remains gated by #11.
- A free Upstash store was created during setup but is unused and not required by the game. No paid plan or Firewall rule was added by these changes.

Credentials, personal contact details, raw provider errors and conversation data must not appear in the repository, screenshots or public verification records.
