# Third-party notices

## HeyGen LiveAvatar × GPT-Live reference implementation

Reference: `https://github.com/heygen-com/liveavatar-gpt-live-demos`

Used as an architectural and protocol reference for:

- LiveAvatar LITE session token/start/stop flow
- forwarding GPT-Live PCM16 24kHz audio to the LiveAvatar media-server WebSocket
- waiting for `session.state_updated: connected` before sending avatar speech
- keeping API keys on the server
- rendering the avatar to the browser through LiveKit

The upstream repository is MIT licensed. This project does not copy the upstream demo UI or Japanese-tutor prompts.

LiveAvatar, LiveKit, Three.js, OpenAI APIs and other dependencies remain subject to their respective terms and licenses.

## Project artwork

The cabinet background, original fictional adult rival, slot symbols and gold coin were newly generated for Slot-chan. User-supplied concept images and their depicted person are not redistributed. Files, dimensions and generation prompts are documented in [visual-assets.md](./docs/visual-assets.md). The final WebP exports do not retain source image metadata. Sound effects are original Web Audio oscillator cues.
