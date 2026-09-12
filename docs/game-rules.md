# Game rules

## Match

- One player vs one CPU rival, for 60 seconds.
- Click **回す** or press **Space** to spin only your reels. Holding Space does not repeat.
- Player requests are accepted at least 1.1 seconds apart, from elapsed 0 and strictly before 60: at most 55 spins.
- While spinning, another press queues one next spin. Further presses do not grow the queue. Hiding the page, leaving, ending or restarting clears it.
- The rival independently spins at 2, 4, …, 60 seconds: 30 spins, regardless of player input.
- Both sides use three reels and one center payline. The fixed base pool contains 4 cherries, 3 bells and 2 sevens.
- Three matching symbols pay: cherry 120, bell 240, seven 1200. No wager is deducted.
- Highest cumulative coin total wins; equal totals draw. An idle player still faces the rival's real spins and scores.
- Upgrades are currently paused: no timed choices, previews, defaults, added symbols or AI upgrade decisions.

## Independent stopping and result

Each side starts, animates and settles independently. A spin or miss on one side never cancels the other side's animation, payout or win lighting. Scores become visible only after that side's final reel stops.

At 60 seconds the model first draws the final scheduled rival spin, then determines the result and rejects further player requests. The result panel waits for both sides' latest accepted spins to settle, including a zero-spin player. It shows both actual spin counts, symbol wins and payouts, and the first highest-paying hit.

## Determinism and authority

Live mode creates its random seed on the server. Player and rival have separate RNG states: extra clicks cannot change the rival's random sequence or spin schedule. Seeds, hidden pools and future results are never sent to the browser.

The browser submits intent (`start`, `spin`, mic audio, snapshot, close). It cannot submit scores, outcomes, time or rival changes. The server deduplicates spin command IDs and enforces time and cooldown. Former `upgrade` requests are rejected.

`advanceMatch` catches up elapsed rival spins and the final deadline without creating player spins. `requestManualSpin` advances that clock first, then accepts an eligible player draw. Snapshots include `rounds.player` and `rounds.rival`; the retained `round` field aliases the player count.

Historical automatic simulations and an explicit `{ upgrades: true }` test option retain old rule fixtures and balance comparisons. Playable CPU and live sessions always use manual player input, automatic rival input, and no upgrades.
