# Third-party notices

Reviewed September 14, 2026 against the submission source and `package-lock.json`. This document identifies components and their respective licenses; it does not relicense them or apply a blanket license to Slot-chan's own code or artwork. The repository currently has no project-wide open-source license.

## Runtime and development components

Versions below are the resolved versions in the reviewed lockfile. License texts distributed with the installed packages remain applicable, including those of transitive dependencies.

| Component | Version | Use | License / upstream |
| --- | --- | --- | --- |
| Three.js | 0.180.0 | 3D rendering, loaders, geometry and font utilities | [MIT](https://github.com/mrdoob/three.js/blob/r180/LICENSE) |
| Vite | 7.3.6 | Development server and production bundling | [MIT](https://github.com/vitejs/vite/blob/main/LICENSE) |
| TypeScript | 5.9.3 | Typed application and server code | [Apache-2.0](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt) |
| Vitest | 3.2.7 | Existing automated tests | [MIT](https://github.com/vitest-dev/vitest/blob/main/LICENSE) |
| ESLint | 9.39.5 | Static code checks | [MIT](https://github.com/eslint/eslint/blob/main/LICENSE) |
| Express | 5.2.1 | Server support | [MIT](https://github.com/expressjs/express/blob/master/LICENSE) |
| ws | 8.21.3 | WebSocket transport | [MIT](https://github.com/websockets/ws/blob/master/LICENSE) |
| Zod | 4.6.2 | Runtime message validation | [MIT](https://github.com/colinhacks/zod/blob/main/LICENSE) |
| LiveKit client | 2.22.3 | Retained optional avatar audio/video playback | [Apache-2.0](https://github.com/livekit/client-sdk-js/blob/main/LICENSE) |
| ELD | 2.1.0 | Language detection, including its bundled language profiles | [Apache-2.0](https://github.com/nitotm/efficient-language-detector-js/blob/main/LICENSE) |

See [`package.json`](package.json) and [`package-lock.json`](package-lock.json) for the complete direct and transitive dependency graph, including type definitions and build-tool dependencies. No separate dataset was collected for model training, and this project does not train or fine-tune a model.

## HeyGen voice/avatar reference

[`heygen-com/liveavatar-gpt-live-demos`](https://github.com/heygen-com/liveavatar-gpt-live-demos) is an architectural and protocol reference for:

- LiveAvatar LITE session token/start/stop flow.
- Forwarding GPT-Live PCM16 24 kHz audio to the media-server WebSocket.
- Waiting for `session.state_updated: connected` before sending avatar speech.
- Keeping provider API keys on the server.
- Rendering retained avatar playback through LiveKit.

The reference repository uses the [MIT license](https://github.com/heygen-com/liveavatar-gpt-live-demos/blob/master/LICENSE). Slot-chan does not adopt its tutor UI, tutor prompts, or bundled GSAP. The current demo hides the video option; voice-only sessions do not need LiveAvatar.

## Font

`src/view/assets/slotchan-display.typeface.json` is a renamed subset of **Optimer Bold**, distributed in the Three.js examples. It is named **Slotchan Display** and includes selected uppercase letters, numbers, punctuation, and currency glyphs for 3D game labels.

This font has a separate **MgOpen/MAGENTA font license**, not the Three.js MIT license. The copyright and permission notice are retained in [`FONT-LICENSE.txt`](src/view/assets/FONT-LICENSE.txt) and in the typeface metadata. See the [upstream font license](https://github.com/mrdoob/three.js/blob/r180/examples/fonts/LICENSE). The font license's modification, naming, notice-retention, and standalone-sale conditions continue to apply.

## 3D production tools and assets

3D production used **Blender and Houdini**. Codex assisted production scripts, geometry corrections, export, and Three.js integration. The checked-in [scripts and exported models](art-source/houdini/) document the procedural generation of the cherries, bell, seven, coin, and cabinet with Houdini Apprentice 22.0.429. Neither authoring application nor personal license files are distributed in this repository.

**Blender** is GNU GPL software. Its binary distributions use GPL-3.0-or-later; the software license does not automatically apply to artwork exported with it. See the [Blender license](https://www.blender.org/about/license/) for the software, artwork, and script distinctions. This does not remove restrictions attached to source assets or other tools in the production workflow.

Houdini is proprietary software. Apprentice is restricted to **non-commercial projects** under [SideFX's Apprentice conditions](https://www.sidefx.com/get/try-houdini/) and [license agreement](https://www.sidefx.com/legal/license-agreement/). These assets are documented as part of a non-commercial game-jam demo; this notice does not assert commercial-use clearance or an unrestricted asset license.

## Generated artwork and sound

Backgrounds, symbol imagery, and the fictional adult rival were generated for this project using OpenAI image tools. The expanded expression atlas combines the existing original expression with 17 variants generated through Vercel AI Gateway. [Artwork provenance](docs/visual-assets.md), [expression provenance](docs/rival-expressions.md), and [art-direction references](docs/art-reference/README.md) record the workflow.

The user's original concept images and their depicted person are not redistributed. Final artwork exports do not retain the source image metadata. Sound effects are original Web Audio oscillator cues; there is no external sound library or music dataset.

## Hosted services and development tools

These services are not open-source components licensed to this repository. Their applicable account agreements, service terms, and content conditions govern their use:

- **OpenAI:** Codex development assistance, GPT-Live voice, Responses API classification, and image generation. See [Terms of Use](https://openai.com/policies/row-terms-of-use/), [Services Agreement](https://openai.com/policies/services-agreement/), and [Service Terms](https://openai.com/policies/service-terms/), as applicable to the account and product.
- **Vercel:** Hosting and AI Gateway for the expanded expression artwork. See [Vercel Terms](https://vercel.com/legal/terms).
- **HeyGen / LiveAvatar:** Retained avatar service integration. See [HeyGen Terms](https://www.heygen.com/terms).
- **GitHub:** Repository hosting and Actions. See [GitHub Terms](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service).

No provider API keys, invitations, private account details, microphone recordings, or actual conversation transcripts are included in the submission materials.
