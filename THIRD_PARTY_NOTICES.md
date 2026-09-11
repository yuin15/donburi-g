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
