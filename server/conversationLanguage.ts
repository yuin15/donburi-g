export type ConversationLanguage = 'ja' | 'en';

export interface LocalizedLine {
  readonly ja: string;
  readonly en: string;
}

const SHORT_ENGLISH_REPLIES = new Set([
  'yes', 'no', 'hello', 'hi', 'hey', 'okay', 'ok', 'sure', 'yeah', 'yep', 'nope',
  'thanks', 'thank you', 'good', 'great', 'nice', 'please',
]);

const COMMON_ENGLISH_WORDS = new Set([
  'a', 'an', 'and', 'are', 'be', 'can', 'do', 'for', 'good', 'great', 'hello', 'hey',
  'hi', 'i', 'is', 'it', 'let', 'like', 'me', 'more', 'my', 'no', 'not', 'now', 'of',
  'okay', 'ok', 'please', 'really', 'so', 'some', 'sure', 'thank', 'thanks', 'that',
  'the', 'this', 'time', 'to', 'want', 'we', 'well', 'yes', 'you', 'your', 'game',
  'spin', 'loan', 'lend', 'money', 'cash', 'borrow', 'extend', 'extra', 'win', 'lose',
]);

/**
 * Switch only for a complete, plainly English spoken turn.  Japanese scripts
 * always win so an English token embedded in Japanese cannot flip the match.
 */
export function isClearlyEnglishTurn(transcript: string): boolean {
  const normalized = transcript.normalize('NFKC').trim();
  if (!normalized || /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/.test(normalized)) return false;
  const words = normalized.toLowerCase().match(/[a-z]+(?:['’][a-z]+)?/g) ?? [];
  if (words.length === 0) return false;
  const remaining = normalized.replace(/[a-zA-Z0-9\s'’.,!?$%:;()-]/g, '');
  if (remaining.length > 0) return false;
  const phrase = words.join(' ');
  if (SHORT_ENGLISH_REPLIES.has(phrase)) return true;
  if (words.length === 1) {
    const [word] = words;
    // A normal single English word is a clear reply; all-caps abbreviations
    // such as ABC stay Japanese until the player says something unambiguous.
    return word.length >= 4 && /[aeiouy]/.test(word) && normalized !== normalized.toUpperCase();
  }
  return words.length >= 2 && words.some(word => COMMON_ENGLISH_WORDS.has(word));
}

export function localized(line: LocalizedLine, language: ConversationLanguage): string {
  return line[language];
}
