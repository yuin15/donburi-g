# Slot-chan — game jam submission

Team: **donburi**

Playable demo: **https://slot-chan.vercel.app/**

Repository: **https://github.com/yuin15/donburi-g**

Prepared: **September 14, 2026**, against source `b1806b5` (PR #159).

Copy the answer body under each heading into the corresponding form field. Each English answer is below 200 words; counts exclude the heading and count label. Supporting links follow the six answers and are not part of the form text.

## 1. Project description

*Word count: 139 / 200.*

Slot-chan is a desktop browser game that turns a 60-second slot duel into a rivalry with personality. Both players start with $30 in fictional currency. Choose $1, $3, or $5 bets, spin manually, and decide whether to preserve your balance or buy upgrades that change your reel composition. Your opponent keeps spinning independently, and the higher final balance wins.

An ornate 3D cabinet, cherries, bells, sevens, sculpted reward text, and showers of coins make each win tangible. The rival responds visually through 18 expressions. Optional OpenAI voice conversation adds banter and spoken requests during the match, while the complete CPU game remains playable without a microphone or API access.

Built by team donburi with TypeScript, Three.js, and custom 3D assets, Slot-chan combines a short, replayable game with an expressive opponent. All currency is simulated, with no deposits or cash-outs.

## 2. Meaningful use of OpenAI tools — 30%

*Word count: 141 / 200.*

OpenAI supports both the playable rival and the development of the game's 3D world.

GPT-Live receives current match context and streams conversational speech and transcripts. Players can talk while spinning, with interruption handling and English/Japanese language support. Spoken requests can reach validated game actions; a Responses API path classifies replies to a bounded loan offer. Game code retains control of money, time, and reel outcomes.

Codex assisted 3D model development for the cabinet, cherries, bell, seven, and coin. It supported production scripts, mesh corrections, export optimization, and Three.js integration. Feedback from the actual game screen guided improvements to shapes, materials, lighting, and animation. Included generation scripts and exported meshes support further iteration.

Codex also assisted implementation, refactoring, and debugging. OpenAI image generation contributed artwork and expression variants. Voice is optional, keeping the underlying game accessible when an AI connection is unavailable.

## 3. Originality — 25%

*Word count: 143 / 200.*

Slot-chan makes a familiar slot machine feel like a face-to-face rivalry. The player controls when to spin and how much to risk, while an opponent continues independently. Upgrades compete with bets for the same limited balance, creating a decision between improving future chances and protecting the money needed to win.

The rival is also a character: changing expressions, reacting to momentum, and optionally speaking with the player. Small social moments, such as requests for fictional money or extra time, sit inside the match rather than in a separate chat screen.

The presentation combines lavish arcade energy with recognizable cherries, bells, sevens, and English controls. Custom procedural models support physical celebrations: symbols emerge from the reels, the cabinet moves, and coins travel through the scene. The result is a compact duel where both a payout and an opponent's reaction can become the memorable moment.

## 4. Playability / usefulness — 25%

*Word count: 151 / 200.*

Players can open the browser demo and select PLAY NOW without signing in, providing credentials, or granting microphone access. A normal round lasts 60 seconds, making it easy to understand, demonstrate, and replay at a game jam.

Mouse and keyboard controls support manual spins and three bet sizes. Active paylines, visible balances, and an upgrade shop expose the important choices. The rival's independent spins sustain pressure even when the player pauses. Round statistics and immediate rematches support experimentation with timing, bets, and upgrades.

AI voice can be added through an invite, but CPU play is a complete experience on its own. Separate microphone, voice, and effects controls help players manage the presentation. Reduced-motion support limits intense effects.

The demo targets desktop screens of at least 1280×720. It is designed for short, expressive play sessions, not mobile use or real-money gambling. Current verification and remaining microphone evaluation are documented alongside the submission.

## 5. Execution and technical quality — 20%

*Word count: 145 / 200.*

Slot-chan is implemented in TypeScript with Vite and Three.js. MVVM separates game rules, interaction state, and presentation, allowing visual changes without rewriting payout logic. CPU play and live sessions use shared game rules, while live actions are validated by the server.

3D production uses Blender and Houdini. Codex supported modeling, production scripts, mesh corrections, export optimization, and runtime integration. Shared geometry, materials, and an atlas rendered from the symbol models reduce repeated work; actual meshes animate during wins. Layered coin effects, sculpted text, lighting, and sound reinforce the outcome.

The repository includes source assets, architecture notes, setup instructions, and visual evidence. Existing GitHub Actions checks cover types, lint, tests, server runtime, and production builds. API credentials remain server-side, and voice connections have bounded lifetimes.

The submission prioritizes a playable, visually expressive demo. Provider-dependent conversation latency and the latest human microphone evaluation remain explicitly documented limitations.

## 6. Existing code, open source, datasets, and third-party tools

*Word count: 170 / 200.*

Development continued in the existing donburi-g repository. HeyGen's liveavatar-gpt-live-demos (MIT) informed the voice/avatar protocol architecture; its tutor interface, prompts, and bundled GSAP were not adopted.

Three.js, Vite, Vitest, ESLint, Express, ws, and Zod use MIT licenses. TypeScript, LiveKit's JavaScript client, and ELD use Apache-2.0. ELD supplies bundled language-detection data; no separate training dataset or custom model training was used. The modified Optimer Bold subset retains its separate MgOpen/MAGENTA font license and is renamed Slotchan Display.

Codex and OpenAI voice/image services were used under their applicable service terms. Vercel provides hosting and was used as the gateway for expression generation. The retained LiveAvatar integration is subject to HeyGen's terms; its video option is currently hidden.

3D production used Blender (GNU GPL) and Houdini Apprentice (SideFX non-commercial terms). Blender's software license does not automatically apply to exported artwork. Background and character artwork was generated for this project; sound effects are synthesized. Third-party licenses do not grant a blanket license to project-owned code or artwork. Sources and notices are documented in the repository.

---

## Supporting material — outside the form answers

| Claim | Repository evidence |
| --- | --- |
| Current rules and purchase costs | [Game model](../src/domain/game.ts), [shared prices](../shared/shop.ts), [game rules](game-rules.md) |
| Streaming voice and match context | [GPT-Live client](../server/gptLive.ts), [match session](../server/matchSession.ts), [language handling](../server/conversationLanguage.ts) |
| Bounded Responses API use | [Loan reply classification](../server/rivalBrain.ts); direct borrowing and time extension have local handlers |
| Codex-assisted 3D development | [Procedural production source](../art-source/houdini/README.md), [cabinet and seven script](../art-source/houdini/build_cabinet.py), [symbols](../art-source/houdini/build_symbols.py), [coin](../art-source/houdini/build_coin.py), [OBJ exporter](../art-source/houdini/obj_export.py) |
| Runtime models and presentation | [Symbol models](../src/view/SymbolModels.ts), [cabinet model](../src/view/CabinetModel.ts), [symbol atlas](../src/view/SymbolAtlas.ts), [win symbols](../src/view/WinSymbols.ts), [coin celebration](../src/view/CoinCelebration.ts), [victory title](../src/view/VictoryTitle.ts) |
| Artwork and expressions | [Artwork provenance](visual-assets.md), [18 expressions](rival-expressions.md) |
| Existing code, licenses, service terms | [Third-party notices](../THIRD_PARTY_NOTICES.md), [locked dependencies](../package-lock.json), [font notice](../src/view/assets/FONT-LICENSE.txt) |
| Actual verification and limits | [Submission verification](submission-verification.md), [earlier voice evidence](voice-spike.md), [CI workflow](../.github/workflows/ci.yml) |

The current visible optional AI feature is **voice**. LiveAvatar code is retained, but the video selection is hidden. Legacy `chooseRivalUpgrade` code does not describe the current rival's behavior. This submission does not claim a new foundation model, custom training, a fully LLM-controlled opponent, or unrestricted commercial licensing.
