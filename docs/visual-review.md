# Cabinet and battle presentation review

## Scope

Issue #26 follows the supplied concept images' cabinet, middle payout line, opposing score panels and visible rival reactions. The current Slot-chan name, 60-second automatic play and optional voice/video remain unchanged. The reference images themselves are not shipped assets; cabinet and crest shapes use local CSS/geometry, and symbol glyphs use system fonts.

## Changes

- Three vertical reels show a clear middle payout line. The faded rows above/below are decoration, derived from the confirmed symbol and never used for scoring. The caption explicitly states that only the middle line counts.
- Red/blue score bars show each side's share of the current total, with a numeric point gap. At 0–0 each starts at half. They are not win probabilities.
- Both upgrade histories, the next upgrade time and a CPU rival crest/status are visible during play.
- The final score sits beside replay, leaving the final reel symbols visible.
- Countdown permits clicking Exit, and cancelling the countdown prevents the pending start.
- Three symbol textures are reused and disposed when the view closes. Reduced-motion mode shows settled symbols without vertical scrolling.

## Verification (2026-09-12)

- 63 existing unit/integration tests, lint, TypeScript/build and emitted Node ESM startup checks passed.
- Real browser play at 1280×720: 60-second match, first upgrade selected with keyboard 1, second left to default, score difference and both two-entry upgrade histories, final result 600 vs 1,680. The middle row matched the final displayed cherry / seven / cherry result.
- Screenshots and DOM bounds checked at 1280×720 and 1920×1080 (up to one-pixel browser rounding). Reels, score, rival, result and replay fit without overlap. Full-page capture was needed for the larger emulated viewport.
- Countdown Exit returned to the entry screen and stayed there past the scheduled start.
- Edge, human-perceived sound quality and first-time playability remain tracked in #5 / #12. No paid API or real microphone was used.
