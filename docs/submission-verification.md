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

This earlier CPU gameplay image is an actual **1280×720** browser capture from that second round at **0:07 remaining**, showing **$17 versus $32**, the selected $3 bet, and the purchased cherry upgrade. It is not a generated mockup, development fixture, live microphone transcript, or proof of the deployed source revision. The CPU caption is a built-in game line. It remains here as playthrough evidence; the README now features the 3D win gallery below.

## README 3D gallery

The README's three new images were captured on **September 14, 2026**, from a local checkout of [`5ed1d69`](https://github.com/yuin15/donburi-g/commit/5ed1d69cb34e419dfef7aefe5d6ebceede22a60a) (PR #163). This is the same game implementation as the submission source above, with the subsequent documentation updates included.

These are **actual Chrome captures of the game's Three.js rendering and DOM interface**, at **1920×1080**, exported directly as WebP. Existing development review controls reproduce the outcomes and hide the review panel. The seven and bell scenes hold their celebration poses; the victory image captures the running title animation. The default coin style is used. No compositing, generated replacement screen, model change, API call, or microphone session was used to make this gallery.

| Image | Local review example | Visible scene |
| --- | --- | --- |
| [Seven win](evidence/readme-3d-2026-09-14/seven-win-1920.webp) | `jackpot` | Raised red-and-gold sevens, +30 payout text, coins in front of and behind the cabinet; $54 versus $18, 0:21 remaining. |
| [Bell win](evidence/readme-3d-2026-09-14/bell-win-1920.webp) | `bell-cherry` | Player's raised bells and +6 payout, rival's raised cherries and +3 payout; $30 versus $23, 0:38 remaining. |
| [Match victory](evidence/readme-3d-2026-09-14/victory-1920.webp) | `session-best` | The large 3D YOU WIN title during its entrance, light rays and coins; final balances $42 versus $24. |

To reproduce, run the local development server and open `/?visual-review&example=jackpot&clean-frame`, substituting the example name from the table. For the animated victory, use the review panel's **自己ベスト・3連勝** button, press **Escape** to hide the panel, and capture during the first three seconds. These review scenes are development-only and do not run on the hosted production build.

All three selected captures were visually inspected for complete framing, symbol depth, payout/title visibility, and absence of the review tools. Fixed scene balances and CPU captions illustrate the presentation; they are not evidence of random match outcomes or live voice responses. The README identifies the images as local review captures and links to this record.

## Automated and document checks

- Source synchronization completed without uncommitted changes. Dependency installation and `npm run build` passed before this documentation update.
- The source commit's [GitHub Actions run](https://github.com/yuin15/donburi-g/actions/runs/34830294455) completed successfully. The existing workflow runs type checks, lint, tests, the Node server-runtime check, and a production build.
- Each of the six answer bodies was counted separately. Both whitespace-delimited counts and a more conservative count splitting hyphens/slashes stay under 200 words. Count labels and evidence links sit outside the copyable answers.
- Relative documentation links and the README screenshot are checked for existence. New submission documents are scanned for personal email addresses and common secret patterns before commit.
- Dependency names, resolved versions, and license identifiers are taken from `package-lock.json`; the font's separate permission notice is retained. The reference repository and provider terms are linked in [third-party notices](../THIRD_PARTY_NOTICES.md).

## Hosted demo and remaining evaluation

The [hosted demo](https://slot-chan.vercel.app/) returned HTTP 200 during this review. Its HTML referenced `index-KVAxwZZq.js` and `index-B6Gifkq2.css`. This is an availability check; no new deployment or equivalence claim between that bundle and the local screenshot is made by this documentation update.

Earlier [real-provider voice checks](voice-spike.md) are available as historical evidence. The latest human microphone responsiveness, interruptions, and conversation-driven transfers were not re-tested here. Unmerged PRs and historical functionality are not presented as completed features of this source snapshot. Mobile support, a commercial service, and unrestricted commercial clearance for Apprentice assets are outside the claimed scope.
