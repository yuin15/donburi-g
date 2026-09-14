export type ConversationLanguage = 'ja' | 'en';

export interface LocalizedLine {
  readonly ja: string;
  readonly en: string;
}

const SHORT_ENGLISH_REPLIES = new Set([
  'yes', 'no', 'hello', 'hi', 'hey', 'okay', 'ok', 'sure', 'yeah', 'yep', 'nope',
  'thanks', 'thank you', 'good', 'great', 'nice', 'please', 'absolutely', 'definitely',
  'awesome', 'congratulations', 'perfect', 'brilliant', 'fantastic', 'wonderful',
]);

/**
 * Switch only for a complete, plainly English spoken turn.  Japanese scripts
 * always win so an English token embedded in Japanese cannot flip the match.
 */
export function isClearlyEnglishTurn(transcript: string): boolean {
  const normalized = transcript.normalize('NFKC').trim();
  if (!normalized || /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/.test(normalized)) return false;
  const phrase = normalized.toLowerCase().replace(/^[\s"'“”]+|[\s.!?,]+$/g, '');
  if (SHORT_ENGLISH_REPLIES.has(phrase)) return true;
  return eld.detect(normalized).language === 'en';
}

export function localized(line: LocalizedLine, language: ConversationLanguage): string {
  return line[language];
}
import { eld } from 'eld/medium';
