# Reel Forge

**しゃべるAIライバルに60秒で勝ちきれ。**

Game jam project by team **donburi**. Browser MVP built with Vite, TypeScript, Three.js, GPT-Live and HeyGen LiveAvatar LITE.

## Play loop

1. Start a match.
2. Both sides auto-spin every 2 seconds for 60 seconds.
3. At 20s and 40s, choose one reel upgrade: **steady** adds cherries; **jackpot** adds 7s.
4. The AI rival chooses its own upgrades and reacts to jackpots, lead changes, your speech and the final result.
5. Highest confirmed coin total at 60 seconds wins.

The game rules are authoritative on the server in live mode. The browser never decides payouts, future spins, the timer, or the rival's score.

## Modes

### Practice mode

Runs fully in the browser and does not call paid APIs. Useful for UI/gameplay iteration.

```bash
npm install
npm run dev
```

### Live AI mode

Live mode requires server-side environment variables. Copy `.env.example` to a local ignored environment file and fill it locally, or configure the variables in Vercel. **Never commit real values.**

Required for live mode:

- `OPENAI_API_KEY`
- `LIVEAVATAR_API_KEY`
- `SESSION_SIGNING_KEY` (24+ random characters)
- `MVP_INVITE_CODE`
- `RATE_LIMIT_STORE_URL` / `RATE_LIMIT_STORE_TOKEN` (shared Redis-compatible REST store such as Upstash)
- `LIVE_MODE_ENABLED=true`

Optional:

- `LIVEAVATAR_AVATAR_ID` — otherwise the first active public avatar is used
- `ALLOWED_ORIGINS` — comma-separated allowed browser origins
- `RIVAL_REASONING_MODEL` — default `gpt-5.6-luna`
- `GPT_LIVE_MODEL` — default `gpt-live-1`
- `GPT_LIVE_VOICE` — default `marin`
- `MAX_DAILY_SESSIONS` — default `100`
- `MAX_CONCURRENT_SESSIONS` — default `5`

Live path:

`browser mic → /api/ws → GPT-Live → LiveAvatar media server → LiveKit → browser`

The same WebSocket owns the authoritative match and the voice/avatar session. If it drops, the MVP aborts that match instead of trying to resume it.

## Commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Vercel

The repository includes `vercel.json`. WebSocket live mode uses the Node.js `ws` server exported from `api/ws.ts` and is intended for Vercel Fluid compute WebSocket support. Configure all secrets as server-side Vercel environment variables before enabling live mode.

## Security

This repository is public. **Never commit API keys, access tokens, passwords, private keys, service-account credentials, invite codes, or real conversation data.**

See [SECURITY.md](./SECURITY.md) and [docs/operations.md](./docs/operations.md).

## Documentation

- [Game rules](./docs/game-rules.md)
- [Wire protocol](./docs/protocol.md)
- [Live voice integration](./docs/voice-spike.md)
- [Operations / limits](./docs/operations.md)
- [MVP verification](./docs/mvp-verification.md)

## Third-party reference

The LiveAvatar/GPT-Live bridge design is based on HeyGen's MIT-licensed reference implementation `heygen-com/liveavatar-gpt-live-demos`. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
