# Slot-chan

**Spin fast. Beat your rival in 60 seconds.**

Game jam project by team **donburi**. The core game uses Vite, TypeScript and Three.js. GPT voice and LiveAvatar video are optional additions.

**PC only — landscape browser viewport 1280×720 or larger, mouse and keyboard.** Smaller windows keep the desktop composition with scrolling; smartphone layouts and touch optimization are outside the scope. Play at [slot-chan.vercel.app](https://slot-chan.vercel.app). See [current status and remaining checks](./docs/current-status.md).

## Play loop

1. Click **PLAY NOW**. No key, invitation, microphone, or external AI service is needed.
2. Click **SPIN** or press **Space** to spin your reels. Press during a spin to queue the next one; repeated presses keep at most one reservation. Player spins are accepted at least 1.1 seconds apart.
3. The rival automatically spins every 2 seconds, even when you do nothing. Your input never triggers or delays its spins.
4. Highest confirmed coin total at 60 seconds wins. Both final animations settle before the result appears.

Only the highlighted **middle line** pays. Both sides keep the same base reel composition for the entire match; upgrades and timed choices are currently removed. Reels move downward and stop independently. The result compares each side's actual spin count, symbol payouts and first highest-paying spin.

The rival completes 30 spins; the player can complete 0–55 depending on input. CPU dialogue reacts to the side that just stopped without repeating the other side's previous payout. See [independent duel verification](./docs/independent-duel.md).

The English game screen puts **YOU / RIVAL** scores first and keeps the title out of the visible play area. Wins use gold lights, separate payout amounts and coins traveling toward the winning side’s score. **BIG WIN** is reserved for three sevens; lead changes wait for both pending spins to settle. See [win presentation and screen checks](./docs/english-win-presentation.md).

The game rules are authoritative on the server in live mode. The browser never decides payouts, future spins, the timer, or the rival's score.

## Modes

### Normal CPU match (no external APIs)

Runs fully in the browser without API calls. It is the normal game, including independent rival spins, results and rematch. Short synthesized effects distinguish spins, wins, jackpots, lead changes and the last ten seconds; **SOUND ON/OFF** controls them separately from optional AI speech.

```bash
npm ci
npm run dev
```

### Optional voice and video

Open **ADD AI VOICE · OPTIONAL** to talk to the rival. Voice plays directly in the browser by default; LiveAvatar is not contacted. Select **Add live video** only for the optional avatar stream, which uses LiveAvatar credits. If permission or initial connection fails, a CPU match is prepared instead. Once connected, a voice/video failure closes the media and microphone, cancels pending AI reasoning, and keeps the same match running with the independent CPU rival. The core game's completion does not depend on real-provider voice/video validation.

Live mode requires server-side environment variables. Copy `.env.example` to a local ignored environment file and fill it locally, or configure the variables in Vercel. **Never commit real values.**

Required for live mode:

- `OPENAI_API_KEY`
- `SESSION_SIGNING_KEY` (24+ random characters)
- `MVP_INVITE_CODE`
- `LIVE_MODE_ENABLED=true`

Optional:

- `LIVEAVATAR_API_KEY` — required only when live video is selected
- `LIVEAVATAR_AVATAR_ID` — for live video; otherwise the first active public avatar is used
- `ALLOWED_ORIGINS` — comma-separated allowed browser origins
- `GPT_LIVE_MODEL` — default `gpt-live-1`
- `GPT_LIVE_VOICE` — default `marin`
- `MAX_DAILY_SESSIONS` — default `10`, per running process
- `MAX_CONCURRENT_SESSIONS` — default `1`, per running process

This is a small invitation-only demo hosted on Vercel. No Redis/Upstash account or database is required. Connection limits are in memory: they reset on process restart and are independent across Vercel instances, so they are not a global spending cap. Provider sessions still stop after at most 120 seconds; normal completion and browser exit release their resources. Keep the invitation private and enable live mode only for the demo. Vercel Firewall rate limiting can be configured separately if wider sharing is needed.

Voice path:

`browser mic → /api/ws → GPT-Live → /api/ws → browser PCM playback`

Optional video path:

`GPT-Live → LiveAvatar media server → LiveKit → browser`

The game WebSocket carries authoritative match updates independently of optional voice/video health. Losing that game transport itself aborts the match with a visible explanation; the app never silently substitutes a new match or seed. Optional media failure preserves the existing timer, scores, spins, and result.

## Commands

```bash
npm run typecheck
npm run lint
npm test
npm run check:server-runtime
npm run build
```

## Vercel

The repository includes `vercel.json`. WebSocket live mode uses the Node.js `ws` server exported from `api/ws.ts` and is intended for Vercel Fluid compute WebSocket support. Configure all secrets as server-side Vercel environment variables before enabling live mode.

## Security

This repository is public. **Never commit API keys, access tokens, passwords, private keys, service-account credentials, invite codes, or real conversation data.**

See [SECURITY.md](./SECURITY.md) and [docs/operations.md](./docs/operations.md).

## Documentation

- [MVVM architecture and change locations](./docs/architecture.md)
- [Game rules](./docs/game-rules.md)
- [Balance measurements](./docs/game-balance.md)
- [Wire protocol](./docs/protocol.md)
- [Live voice integration](./docs/voice-spike.md)
- [Operations / limits](./docs/operations.md)
- [MVP verification](./docs/mvp-verification.md)

## Third-party reference

Reels, cabinet background/frame, payout lines, win lighting and jackpot coins share one Three.js renderer. It redraws only while animating or when the visible state changes; settled/hidden screens have no continuous render loop. Text and controls use HTML/CSS. The avatar SDK is loaded only when live video is selected. See [rendering verification](./docs/render-performance.md).

Cabinet, character expressions, symbols and coin art were generated for this project and are served locally as four shared WebP textures. Reels move downward with continuous UV scrolling and stop left, middle, then right; score and reaction updates follow the settled frame. Text and controls remain accessible HTML. Sound effects are original Web Audio oscillator cues. The fixed landscape composition is verified at 1280×720 and 1920×1080; rival symbols retain their square proportions. Actual Edge and human play/sound evaluation remain pending. See [visual assets](./docs/visual-assets.md) and [visual verification](./docs/visual-redesign-verification.md).

The LiveAvatar/GPT-Live bridge design is based on HeyGen's MIT-licensed reference implementation `heygen-com/liveavatar-gpt-live-demos`. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
