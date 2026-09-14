import { describe, expect, it } from 'vitest';
import { isClearlyEnglishTurn } from './conversationLanguage';

describe('isClearlyEnglishTurn', () => {
  it.each([
    ['Absolutely fantastic!', true],
    ['That is fun', true],
    ['I need ten more seconds', true],
    ['Hello', true],
    ['No', true],
    ['Awesome', true],
    ['Bonjour', false],
    ['Merci', false],
    ['Arigato', false],
    ['これは ABC の話', false],
    ['', false],
  ])('classifies %j as %s', (transcript, expected) => {
    expect(isClearlyEnglishTurn(transcript)).toBe(expected);
  });
});
