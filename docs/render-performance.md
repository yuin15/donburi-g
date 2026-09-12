# Three.js rendering and lifecycle

The reels, cabinet background plate, metallic frame, payout lines/arrows, win lighting and jackpot coins use one Three.js renderer and camera. HTML/CSS continues to provide readable text, scores, controls and page layout. The optional avatar SDK loads only when attaching a voice/video avatar.

## Rendering policy

- Repaint on new symbols, resize, visibility restoration or motion preference changes.
- Schedule successive animation frames only during reel motion or the bounded jackpot coin animation.
- Stop the loop when settled, including the result/entry screen; hidden documents do not render.
- Exit stops reel motion and the win effect. Disposal is idempotent and removes frame callbacks, timers, listeners, shared textures, geometry and materials.
- Three cached symbol textures and shared cabinet/coin geometry avoid allocating artwork per spin. Jackpot coins are limited to 16 and stop within the win effect's 900ms window; reduced motion uses a short static highlight.

## Evidence (2026-09-12)

Eight renderer lifecycle tests use real Three.js scene objects with a stub WebGL renderer. They cover idle scheduling, confirmed middle symbols, bounded animation, hidden/latest-result recovery, reduced motion, resizing/cancellation, coin animation, and exact resource disposal. They verify scheduling and ownership, not real GPU speed.

A browser's CDP Performance counters were sampled for five idle seconds after startup:

| Build | ScriptDuration delta | TaskDuration delta | JS heap delta |
| --- | ---: | ---: | ---: |
| Public `7be8000`, continuous rendering | 47.086ms | 114.432ms | +329,052 bytes |
| Local production build, on-demand rendering | 0ms | 0.358ms | 0 bytes |

These are individual samples on the same Windows/in-app Chromium setup, not a cross-device FPS, battery or GPU benchmark. The local sample preceded the cabinet artwork migration, which uses the same idle scheduling policy. Repeat on the final public deployment before claiming a production improvement.

Before the SDK split, the initial JavaScript bundle was 1,073.38KB (279.16KB gzip). Moving the avatar SDK to a dynamic import reduced it to 514.47KB (132.74KB gzip); the 561.21KB SDK chunk is optional. The cabinet artwork may change these byte counts slightly; the final build output/PR records the delivered sizes. No API key or microphone is needed for CPU play.
