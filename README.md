# Slot-chan

**リールを改造して、CPUライバルに60秒で勝ちきれ。**

Game jam project by team **donburi**. The core game uses Vite, TypeScript and Three.js. GPT voice and LiveAvatar video are optional additions.

## Play loop

1. Click **CPUライバルと対戦**. No key, invitation, microphone, or external AI service is needed.
2. Both sides auto-spin every 2 seconds for 60 seconds.
3. At 20s and 40s, choose one reel upgrade: **steady** adds cherries; **jackpot** adds 7s.
4. The CPU chooses its own legal upgrades. In optional voice/video mode, the rival can also respond to speech and game events.
5. Highest confirmed coin total at 60 seconds wins.

Only the highlighted **middle line** pays; the faded upper/lower symbols are visual decoration. The scoreboard shows the point difference, while the rival panel shows both upgrade histories. The cabinet shows when the next upgrade becomes available. Results stay below the cabinet so the final symbols remain visible.

The game rules are authoritative on the server in live mode. The browser never decides payouts, future spins, the timer, or the rival's score.

## Modes

### Normal CPU match (no external APIs)

Runs fully in the browser without API calls. It is the normal game, including both upgrades, results and rematch. Short synthesized effects distinguish spins, wins, jackpots, lead changes and the last ten seconds; **効果音 ON/OFF** controls them separately from optional AI speech.

```bash
npm ci
npm run dev
```

### Optional voice and video

Open **音声・映像もつける（任意）** only when you want that addition. If permission or initial connection fails, a CPU match is prepared instead. Once connected, a voice/video failure closes the media and microphone, cancels pending AI reasoning, and keeps the same match running with CPU upgrade choices. The core game's completion does not depend on real-provider voice/video validation.

Live mode requires server-side environment variables. Copy `.env.example` to a local ignored environment file and fill it locally, or configure the variables in Vercel. **Never commit real values.**

Required for live mode:

- `OPENAI_API_KEY`
- `LIVEAVATAR_API_KEY`
- `SESSION_SIGNING_KEY` (24+ random characters)
- `MVP_INVITE_CODE`
- `LIVE_MODE_ENABLED=true`

Optional:

- `LIVEAVATAR_AVATAR_ID` — otherwise the first active public avatar is used
- `ALLOWED_ORIGINS` — comma-separated allowed browser origins
- `RIVAL_REASONING_MODEL` — default `gpt-5.6-luna`
- `GPT_LIVE_MODEL` — default `gpt-live-1`
- `GPT_LIVE_VOICE` — default `marin`
- `MAX_DAILY_SESSIONS` — default `10`, per running process
- `MAX_CONCURRENT_SESSIONS` — default `1`, per running process

This is a small invitation-only demo hosted on Vercel. No Redis/Upstash account or database is required. Connection limits are in memory: they reset on process restart and are independent across Vercel instances, so they are not a global spending cap. Provider sessions still stop after at most 120 seconds; normal completion and browser exit release their resources. Keep the invitation private and enable live mode only for the demo. Vercel Firewall rate limiting can be configured separately if wider sharing is needed.

Live path:

`browser mic → /api/ws → GPT-Live → LiveAvatar media server → LiveKit → browser`

The game WebSocket carries authoritative match updates independently of optional voice/video health. Losing that game transport itself aborts the match with a visible explanation; the app never silently substitutes a new match or seed. Optional media failure preserves the existing timer, score, upgrades, and result.

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

- [Game rules](./docs/game-rules.md)
- [Balance measurements](./docs/game-balance.md)
- [Wire protocol](./docs/protocol.md)
- [Live voice integration](./docs/voice-spike.md)
- [Operations / limits](./docs/operations.md)
- [MVP verification](./docs/mvp-verification.md)

## Third-party reference

Reels, cabinet background/frame, payout lines, win lighting and jackpot coins share one Three.js renderer. It redraws only while animating or when the visible state changes; settled/hidden screens have no continuous render loop. Text and controls use HTML/CSS. The avatar SDK is loaded only for the optional voice/video path. See [rendering verification](./docs/render-performance.md).

Geometry and UI are generated locally. Sound effects are original Web Audio oscillator cues; they contain no third-party recordings. Symbol glyphs use the browser/system font. Initial supported environments are desktop Chrome and Edge at 1280×720 or larger; a phone-specific layout is outside this demo's scope.

The LiveAvatar/GPT-Live bridge design is based on HeyGen's MIT-licensed reference implementation `heygen-com/liveavatar-gpt-live-demos`. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
