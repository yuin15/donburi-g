# Game rules

## Match

- One player vs one CPU rival, for 60 seconds.
- Click **回す** or press **Space** to spin only your reels. Holding Space does not repeat.
- Player requests are accepted at least 1.1 seconds apart, from elapsed 0 and strictly before 60: at most 55 spins.
- While spinning, another press queues one next spin. Further presses do not grow the queue. Hiding the page, leaving, ending or restarting clears it.
- The rival independently tries to spin at 2, 4, …, 60 seconds. It stops when its cash cannot cover the $1 cost.
- Both sides use three reels and one center payline. The fixed base pool contains 4 cherries, 3 bells and 2 sevens.
- Both sides start with $30. Each accepted spin immediately costs $1; three matching center-line symbols pay cherry $3, bell $6, or seven $30.
- Highest cash balance at 60 seconds wins; equal balances draw. A player with no cash can watch the rival finish its eligible spins.
- Upgrades are currently paused: no timed choices, previews, defaults, added symbols or AI upgrade decisions.

## Independent stopping and result

Each side starts, animates and settles independently. An accepted spin immediately shows its $1 cost; the payout appears after that side's final reel stops. A spin or miss on one side never cancels the other side's animation, payout or win lighting.

At 60 seconds the model first draws the final scheduled rival spin, then determines the result and rejects further player requests. The result panel waits for both sides' latest accepted spins to settle, including a zero-spin player. It shows both actual spin counts, symbol wins and payouts, and the first highest-paying hit.

## Determinism and authority

Live mode creates its random seed on the server. Player and rival have separate RNG states: extra clicks cannot change the rival's random sequence or spin schedule. Seeds, hidden pools and future results are never sent to the browser.

The browser submits intent (`start`, `spin`, mic audio, snapshot, close). It cannot submit cash balances, outcomes, time or rival changes. The server deduplicates spin command IDs, enforces time and cooldown, and rejects a spin when the player cannot pay $1. Upgrade messages remain available only to the retained legacy upgrade mode.

`advanceMatch` catches up elapsed rival spins and the final deadline without creating player spins. `requestManualSpin` advances that clock first, then accepts an eligible player draw. Snapshots include `rounds.player` and `rounds.rival`; the retained `round` field aliases the player count.

Historical automatic simulations and an explicit `{ upgrades: true }` test option retain the upgrade path. Those spins use the same $30 bankroll, $1 cost, and $3/$6/$30 payouts. Playable CPU and live sessions always use manual player input, automatic rival input, and no upgrades.
