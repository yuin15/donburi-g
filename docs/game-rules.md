# Game rules

## Match

- 1 player vs 1 AI rival.
- 60 seconds.
- Both sides complete one spin every 2 seconds: 30 spins each.
- Three reels, one center payline.
- Symbols: cherry, bell, seven.
- Three identical symbols pay: cherry 120, bell 240, seven 1200.
- No wager is deducted. Final cumulative coin total determines the winner; equal totals are a draw.
- The result shows each side's confirmed symbol win counts and payouts, upgrade order, and highest-paying spin. Equal highest payouts retain the first occurrence. Statistics are recorded in the domain and included in snapshots, so delayed rendering cannot discard them.

## Upgrade boundaries

Upgrade windows open at elapsed 20s and 40s. They close at 24s and 44s.

The UI previews each choice for 5 seconds before its window (15–20s and 35–40s). Preview buttons and number keys cannot submit early. The displayed probabilities use the current applied pool plus each proposed upgrade: three identical symbols on the middle line, with independent draws from the same pool. The second preview includes the first applied upgrade. Selection remains limited to the original 4-second window.

Boundary ordering is deterministic:

1. Complete the spin whose completion time is the boundary.
2. Open or close/apply the upgrade window for that boundary.
3. Subsequent spins use the updated reel pool.

Therefore the spin completing at 24s uses the pre-upgrade pool; the next spin uses the newly applied pool.

Unselected or timed-out upgrades default to `steady`.

After the deadline, a short receipt names the applied upgrade and explicitly explains the default when no choice was submitted. It takes effect on the following spin.

- `steady`: add six cherries to that side's reel pool, favoring frequent small payouts.
- `jackpot`: add one seven to that side's reel pool, favoring rare 1,200-point payouts.

Each upgrade choice is final once submitted. Buttons lock after selection; there is no change-of-mind submission. The same definitions drive the game and the UI labels.

Both sides have the same legal choices and number of upgrades. The rival does not receive the player's current pending choice, RNG state, or future results.

## Determinism and authority

Live mode creates its random seed on the server. Player and rival use separate deterministic RNG states derived from that seed. The seed and pools are not sent to the browser.

The browser submits only player intent (`start`, `upgrade`, mic audio, snapshot request, close). It cannot submit scores, outcomes, remaining time, or rival changes.

`advanceMatch` catches up all missed boundaries if a timer is delayed, preventing browser backgrounding or event-loop stalls from dropping or duplicating spins.
