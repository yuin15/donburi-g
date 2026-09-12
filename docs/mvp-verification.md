# MVP verification

## Automated checks

CI must pass:

- TypeScript
- ESLint
- unit tests
- production build
- tracked-file secret-pattern scan

Game-domain tests cover deterministic seeds, 30 spin completion, delayed timer catch-up, upgrade boundaries, duplicate/late upgrade rejection and safe snapshot shape.

## Core CPU-game pass (Issue #12 / #23)

Run without API keys and verify:

1. page opens with no paid connection
2. The primary CPU battle button starts the countdown without an invite, microphone, or external API
3. 60-second match completes
4. upgrade prompts appear twice
5. keyboard 1/2 and pointer work
6. win/loss/draw result UI is readable
7. rematch resets score/upgrades/text
8. resize to 1280×720 and 1920×1080 keeps core controls readable
9. reduced-motion preference avoids strong reel motion
10. independent effect mute works, exit stops sounds, and re-entry preserves mute
11. optional voice/video is collapsed by default; failure before play falls back to CPU entry
12. during a connected match, optional voice/video failure preserves the match, upgrades, and final score (Issue #24); losing the game WebSocket itself is reported separately

## Optional live-provider release gate

These checks gate enabling voice/video. They do not block the default CPU game.

Before public live access, perform at least three end-to-end sessions on the Vercel candidate deployment and record only non-sensitive measurements listed in `voice-spike.md`.

Also test:

- invalid invite code
- microphone denial before paid connection
- duplicate start/rematch click
- quota exhaustion / kill switch
- tab close during match
- OpenAI or LiveAvatar connection failure
- rival reasoning timeout
- browser background then snapshot resync

## Playtest gate

Have at least three first-time players answer, without coaching:

- What is the win condition?
- What do the two upgrade choices change?
- Did the rival feel like an opponent rather than a narrator?
- Was there enough time to understand and choose an upgrade?
- Would you immediately rematch?

Change the common rule configuration rather than adding hidden outcome manipulation.
