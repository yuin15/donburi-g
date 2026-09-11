/**
 * Every piece of model-facing text, in one place.
 *
 * Two kinds live here, and the split is the point:
 *
 * - **Persona** — who the avatar is and how it opens. Loaded from the markdown
 *   files in `server/prompts/`, which is where you customize this demo: edit
 *   `instructions.md` and `greeting.md` and restart. (The `GPT_LIVE_*` env
 *   vars override even those.)
 * - **Mechanics** — the directives that make delegation and tools work at all.
 *   These are wiring, not flavor: change them and visuals stop appearing or
 *   the avatar starts narrating its own tool calls. They stay in code.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function promptFile(name: string, fallback: string): string {
  try {
    return readFileSync(
      fileURLToPath(new URL(`../prompts/${name}`, import.meta.url)),
      "utf8",
    ).trim();
  } catch {
    return fallback;
  }
}

// ── persona (edit server/prompts/*.md, not these fallbacks) ──────────────────

export const DEFAULT_INSTRUCTIONS = promptFile(
  "instructions.md",
  "You are Rina, a friendly Japanese-speaking slot companion in a live voice conversation. " +
    "Keep every reply short and natural. Never invent game results you cannot see.",
);

export const DEFAULT_GREETING = promptFile(
  "greeting.md",
  "Introduce yourself as Rina in Japanese and ask what slot machine the user is playing.",
);

// ── mechanics ─────────────────────────────────────────────────────────────────

// The v3 speak-first mechanism: one `session.instructions.append` carrying an
// explicit speak-now directive plus the opening (OpenAI's tested phrasing —
// 500/500 sessions spoke first). `response.create` is a backend command in
// this API and never starts a voice turn. Whole append must stay under 500
// tokens, greeting.md included.
export const GREETING_PREAMBLE =
  "The session just started. The user is listening but has not spoken yet. " +
  "Immediately speak first to open the conversation; do not wait for the user to speak. " +
  "After the opening, pause and listen. Opening: ";

// Unblocks a client-target delegation. This starter runs in responses mode
// and should never see one; if one arrives the model is blocked waiting on
// us, so answer rather than let the session freeze on "one sec".
export const CLIENT_DELEGATION_STUB =
  "(No additional information available; answer directly and briefly.)";

/**
 * Appended to the live model's instructions. Delegation steering lives HERE,
 * at startup — not in mid-session appends. Measured, twice: prose asking the
 * live model to delegate its own teaching moments never fired once
 * (backend_model_usage: []), while an explicit learner request ("teach me the
 * word for respect") delegated instantly. So the directive claims only the
 * trigger that works. Mid-session appends are avoided for pacing too: an
 * append lands as new context the model acts on IMMEDIATELY, cutting off
 * whatever practice loop it was running.
 */
export const LIVE_DIRECTIVE =
  "\n\nStay in Japanese unless the user asks for another language. Keep the spoken conversation " +
  "moving naturally. If you do not know the current reel result, ask the user instead of inventing it.";

/**
 * Instructions for the delegated Responses model — the one that holds the
 * tools. The "answer in words AND call the tool in the same reply" clause is
 * load-bearing: a tool-only reply leaves the avatar silent while the live
 * voice waits on the delegation.
 */
export const RESPONSES_INSTRUCTIONS =
  "Reply in natural spoken Japanese as Rina, a friendly slot companion. Always include spoken " +
  "text, keep it to one or two sentences, and never invent a game result that was not provided.";

// ── lesson script ─────────────────────────────────────────────────────────────

/**
 * The opening curriculum. The whole plan is stated ONCE, in the startup
 * instructions (LESSON_DIRECTIVE below) — the model owns the pacing from
 * there. It used to be prompted one word at a time with mid-session appends,
 * and that broke the conversation cycle: an append lands as new context the
 * model acts on immediately, so "say it again: こんにちは" became "Now, goodbye
 * is さようなら" in the same breath, the practice loop cut off mid-word.
 *
 * The card data is here because the SERVER pushes each term card when the
 * tutor is heard saying the word (session.ts) — the model is never asked to
 * delegate for words we already hold. Measured, not assumed: a full session
 * of "delegate this teaching" prompts closed with `backend_model_usage: []`.
 * GPT-Live's delegation is trained for capability gaps (current information,
 * deep reasoning), and teaching "hello" is within its own ability, so it
 * answers directly no matter what the prose says.
 */
export interface LessonWord {
  english: string;
  term: string;
  reading: string;
  meaning: string;
}

export const LESSON_WORDS: readonly LessonWord[] = [];

/**
 * The lesson plan as startup instructions, appended after LIVE_DIRECTIVE
 * (gptlive.ts). Pacing rules are explicit — one word per turn, wait for the
 * echo — because the model owns the cycle now and nothing will correct it
 * mid-session.
 */
export const LESSON_DIRECTIVE = "";

/**
 * Instruction append when nobody has said anything for a while (the silence
 * watchdog in session.ts). Kills the flow "Avatar: yep, I hear you. — You:
 * why aren't you saying anything?"
 */
export const SILENCE_CHECKIN =
  "Nobody has spoken for a while. Speak now in Japanese and warmly ask whether the user is still " +
  "there or what happened on the latest spin. Keep it brief and do not invent a result.";

/**
 * Instruction append that triggers the periodic review via DELEGATION
 * (session.ts, every RECAP_EVERY_WORDS new words). Deliberately carries no
 * word list: the backend's show_learned_words call renders the panel, and its
 * tool result hands back the exact words on it — so the walkthrough is
 * synchronized with the screen by the conversation itself, not by a timer
 * guessing at speech cadence. A fallback in session.ts pushes the panel
 * directly if the model never delegates.
 */
export const REVIEW_BREAK_PROMPT =
  "Time for a short review break. Finish the current exchange first — if you just asked the " +
  "learner to say a word back, respond to their attempt before anything else. Then announce the " +
  "break in your own words, something in the spirit of: 'let's take a quick break — I'll pull up " +
  "the cards we've seen so far', and hand this turn to your backend: it will put the review on " +
  "screen and return the exact words to walk through. This review is the ONE time you may " +
  "mention the cards on screen. Afterwards, pick the conversation back up where you left off.";

// followUpSpeech (the silent-tool-call safety net) is gone on purpose: tool
// results are returned via response.item.create + response.create, and
// the backend CONTINUES its reply after receiving them — its own continuation
// is the speech the safety net used to fake, and both firing would
// double-speak.
