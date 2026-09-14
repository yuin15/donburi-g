# Slot-chan — game jam submission

Team: **donburi**

Playable demo: **https://slot-chan.vercel.app/**

Repository: **https://github.com/yuin15/donburi-g**

Prepared: **September 14, 2026**, against source `b1806b5` (PR #159).

Copy the answer body under each heading into the corresponding form field. Each English answer is below 200 words; counts exclude the heading and count label. Supporting links follow the six answers and are not part of the form text.

## 1. Project description

*Word count: 141 / 200.*

Slot-chan is a desktop browser game where you talk with your AI rival while playing a 60-second slot duel. Keep spinning, choose your bets, and speak to the opponent as the match unfolds. OpenAI voice brings banter, reactions, and spoken requests into the same experience as the game. The appeal is competing with someone you can converse with throughout the round.

Both sides start with $30 in fictional currency. The player spins manually, chooses $1, $3, or $5 bets, and can buy reel upgrades. The rival spins independently; the higher final balance wins. A custom 3D cabinet, expressive character, and coin celebrations make the changing fortunes visible.

Built by team donburi, Slot-chan combines conversation, risk, and a short replayable match. Voice uses an invite and microphone; CPU play remains available without them. All currency is simulated, with no deposits or cash-outs.

## 2. Meaningful use of OpenAI tools — 30%

*Word count: 143 / 200.*

OpenAI voice enables Slot-chan's central experience: playing a game while conversing with the opponent.

GPT-Live streams microphone input, rival speech, and transcripts during active play. Current balances, time, and confirmed outcomes provide context for the conversation. Players can react to a win, challenge the rival, or continue a conversation while their hands operate the controls. The implementation supports interruptions and English/Japanese conversation, so interaction can follow the player's response as well as the match.

Spoken requests for fictional money or extra time can reach validated game actions. A bounded Responses API path classifies replies to a loan offer; game code retains control of money, time, and reel outcomes.

Codex supported voice integration, implementation, debugging, and 3D model development through production scripts, mesh corrections, and Three.js integration. OpenAI image generation contributed artwork and expression variants. These development tools support the shared conversational game experience.

## 3. Originality — 25%

*Word count: 136 / 200.*

Slot-chan combines the immediacy of a slot duel with the social feeling of talking to someone across the table. Conversation happens while the player spins, chooses bets, and watches the rival's progress. A lucky result can become something to celebrate aloud; a losing position can prompt a challenge or a request for more time.

The same opponent both competes and converses, giving the interaction a shared subject and visible stakes. Its independent spins keep the round moving, while voice and changing expressions give the rivalry personality.

Betting and upgrades draw from one limited balance, adding a choice between immediate risk and future chances. Recognizable cherries, bells, and sevens make the rules approachable, while custom 3D celebrations amplify the drama. The memorable moment can be the win, what the rival says about it, or the player's reply.

## 4. Playability / usefulness — 25%

*Word count: 147 / 200.*

The conversational demo lets players keep using the mouse and keyboard for the game while speaking through the microphone. They can respond to the rival without typing or opening another screen. A normal round lasts 60 seconds, making the combination of conversation and competition easy to demonstrate and replay.

To try voice, enter the organizer-provided invite, connect AI voice, allow the microphone, and start. Separate microphone, rival voice, and effects controls help manage the experience. CPU play is also available through PLAY NOW without credentials or microphone access.

Manual spins, three bet sizes, visible paylines, and an upgrade shop expose the choices. The rival spins independently, and round statistics and rematches encourage experimentation. Reduced-motion support limits intense effects.

The demo targets desktop screens of at least 1280×720. Voice depends on configured API access; current verification and remaining human microphone evaluation are documented. All game currency is fictional.

## 5. Execution and technical quality — 20%

*Word count: 148 / 200.*

Slot-chan connects a continuously running game to streaming voice. Its browser microphone and audio playback, server voice connection, transcripts, and current match context work together so conversation can accompany play. Interruption handling manages speech and subtitle state, while server validation bounds changes requested through conversation. API credentials stay server-side and voice sessions have bounded lifetimes.

TypeScript, Vite, Three.js, and MVVM separate game rules, interaction state, and presentation. CPU play and live sessions share the game rules. Blender and Houdini support 3D production, with Codex assisting model scripts, mesh corrections, and integration. Shared geometry and symbol atlases support animated wins and coin effects.

Source assets, setup instructions, architecture notes, and visual evidence are included. Existing GitHub Actions checks cover types, lint, tests, server runtime, and production builds.

The submission prioritizes the experience of talking and playing together. Provider-dependent conversation latency and the latest human microphone evaluation remain documented limitations.

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
