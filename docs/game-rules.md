# Game rules

## Match

- 1 player vs 1 AI rival.
- 60 seconds.
- A click on **回す** or a **Space** press requests one spin for both sides. Neither side spins without player input.
- Requests are accepted at least 1.1 seconds apart, starting at elapsed 0 and strictly before 60 seconds: at most 55 spins each. The result reports the actual count, including zero.
- During a spin, another press queues one next spin. Further presses do not add more reservations. Holding Space does not repeatedly enqueue. Leaving, hiding the page, ending, or restarting clears the reservation.
- Three reels, one center payline.
- Symbols: cherry, bell, seven.
- Three identical symbols pay: cherry 120, bell 240, seven 1200.
- No wager is deducted. Final cumulative coin total determines the winner; equal totals are a draw.
- The result shows each side's confirmed symbol win counts and payouts, upgrade order, and highest-paying spin. Equal highest payouts retain the first occurrence. Statistics are recorded in the domain and included in snapshots, so delayed rendering cannot discard them.

## Upgrade boundaries

Upgrade windows open at elapsed 20s and 40s. They close at 24s and 44s.

The UI previews each choice for 5 seconds before its window (15–20s and 35–40s). Preview buttons and number keys cannot submit early. The displayed probabilities use the current applied pool plus each proposed upgrade: three identical symbols on the middle line, with independent draws from the same pool. The second preview includes the first applied upgrade. Selection remains limited to the original 4-second window.

Boundary ordering is deterministic:

1. Advance the authoritative clock and process all elapsed upgrade/result deadlines.
2. If still playing and outside the spin cooldown, accept the requested spin.
3. Both sides draw from their current applied pool; their `SpinView.upgrades` records that composition for rendering.

Therefore a request at 24s uses the first applied upgrade, while a spin accepted before 24s retains its earlier composition until it stops. Requests at or after 60s do not draw. A previously accepted final spin settles before the result panel appears.

Unselected or timed-out upgrades default to `steady`.

After the deadline, a short receipt names the applied upgrade and explicitly explains the default when no choice was submitted. It takes effect on the following spin.

- `steady`: add six cherries to that side's reel pool, favoring frequent small payouts.
- `jackpot`: add one seven to that side's reel pool, favoring rare 1,200-point payouts.

Each upgrade choice is final once submitted. Buttons lock after selection; there is no change-of-mind submission. The same definitions drive the game and the UI labels.

Both sides have the same legal choices and number of upgrades. The rival does not receive the player's current pending choice, RNG state, or future results.

## Determinism and authority

Live mode creates its random seed on the server. Player and rival use separate deterministic RNG states derived from that seed. The seed and pools are not sent to the browser.

The browser submits only player intent (`start`, `spin`, `upgrade`, mic audio, snapshot request, close). It cannot submit scores, outcomes, remaining time, or rival changes. Spin command IDs are deduplicated, and server time controls acceptance and cooldown.

`advanceMatch` catches up missed deadlines without creating manual spins. `requestManualSpin` advances those deadlines before accepting a request. The domain retains an explicit automatic simulation mode for balance analysis and previous regression scenarios; both playable CPU and live matches use manual mode.
