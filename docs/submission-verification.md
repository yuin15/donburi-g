# Submission source and verification

Reviewed on **September 14, 2026** for the English submission answers and bilingual README.

## Source and scope

- Source: `main` at [`b1806b52925ef01ac0dca03264ee18e27e6df300`](https://github.com/yuin15/donburi-g/commit/b1806b52925ef01ac0dca03264ee18e27e6df300), including PR #159.
- Scope: documentation, license/source attribution, and a fresh screenshot. This update does not change game code, models, API settings, or deployment configuration.
- Current implementation facts were checked in the game model, shared shop prices, ViewModel, game template, voice/session handlers, model-generation scripts, and locked dependencies.
- Historical documents preserve their original measurements. For example, the original shop review used $5/$10/$15; the submission source uses **$10/$15/$20** in `shared/shop.ts`. The current game-rules document was corrected accordingly.
- The prior README's visible LiveAvatar video instructions were removed: the current game template hides that option. Voice-only play remains available when configured.

## Local browser observation

The source was served through Vite at a loopback address and checked in desktop Chrome. No AI voice connection, microphone capture, or external generation request was initiated.

Observed through normal game controls:

- The entry screen offered PLAY NOW and optional AI voice, with no visible LiveAvatar checkbox.
- PLAY NOW started a CPU round at $30 each. The rival continued independently while the player did not spin.
- Selecting BET $3 and clicking SPIN produced a complete round: **player 1 spin / $27, rival 30 spins / $30**, followed by the result and REMATCH.
- REMATCH restored $30 balances, BET $1, no purchases, and the 60-second clock.
- Purchasing six cherries deducted $10 and updated the shop to **10 cherries, 1/3 purchased, next price $15**. The seven remained at its initial $10 price.
- Selecting BET $3 and spinning after that purchase showed $17 before any payout. This verifies the instructions against the current price and input flow.

![Actual CPU gameplay, 1280×720](evidence/submission-2026-09-14/gameplay-1280.webp)

The README image is an actual **1280×720** browser capture from that second round at **0:07 remaining**, showing **$17 versus $32**, the selected $3 bet, and the purchased cherry upgrade. It is not a generated mockup, development fixture, live microphone transcript, or proof of the deployed source revision. The CPU caption is a built-in game line.

## Automated and document checks

- Source synchronization completed without uncommitted changes. Dependency installation and `npm run build` passed before this documentation update.
- The source commit's [GitHub Actions run](https://github.com/yuin15/donburi-g/actions/runs/34830294455) completed successfully. The existing workflow runs type checks, lint, tests, the Node server-runtime check, and a production build.
- Each of the six answer bodies was counted separately. Both whitespace-delimited counts and a more conservative count splitting hyphens/slashes stay under 200 words. Count labels and evidence links sit outside the copyable answers.
- Relative documentation links and the README screenshot are checked for existence. New submission documents are scanned for personal email addresses and common secret patterns before commit.
- Dependency names, resolved versions, and license identifiers are taken from `package-lock.json`; the font's separate permission notice is retained. The reference repository and provider terms are linked in [third-party notices](../THIRD_PARTY_NOTICES.md).

## Hosted demo and remaining evaluation

The [hosted demo](https://slot-chan.vercel.app/) returned HTTP 200 during this review. Its HTML referenced `index-KVAxwZZq.js` and `index-B6Gifkq2.css`. This is an availability check; no new deployment or equivalence claim between that bundle and the local screenshot is made by this documentation update.

Earlier [real-provider voice checks](voice-spike.md) are available as historical evidence. The latest human microphone responsiveness, interruptions, and conversation-driven transfers were not re-tested here. Unmerged PRs and historical functionality are not presented as completed features of this source snapshot. Mobile support, a commercial service, and unrestricted commercial clearance for Apprentice assets are outside the claimed scope.
