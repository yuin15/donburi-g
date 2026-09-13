import { describe, expect, it } from 'vitest';
import { shouldToggleAiDebug } from './AiDebug';

type ToggleEvent = Parameters<typeof shouldToggleAiDebug>[0];

function key(overrides: Partial<ToggleEvent> = {}): ToggleEvent {
  return {
    code: 'KeyD', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
    repeat: false, isComposing: false, defaultPrevented: false, target: null,
    ...overrides,
  };
}

describe('AI DEBUG keyboard toggle guard', () => {
  it('accepts only an unmodified, fresh D key outside editable content', () => {
    expect(shouldToggleAiDebug(key())).toBe(true);
    expect(shouldToggleAiDebug(key({ code: 'KeyF' }))).toBe(false);
    expect(shouldToggleAiDebug(key({ repeat: true }))).toBe(false);
    expect(shouldToggleAiDebug(key({ isComposing: true }))).toBe(false);
    expect(shouldToggleAiDebug(key({ defaultPrevented: true }))).toBe(false);
  });

  it.each(['ctrlKey', 'altKey', 'metaKey', 'shiftKey'] as const)('ignores %s shortcuts', modifier => {
    expect(shouldToggleAiDebug(key({ [modifier]: true }))).toBe(false);
  });

  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('ignores %s editing targets', tagName => {
    expect(shouldToggleAiDebug(key({ target: { tagName } as unknown as EventTarget }))).toBe(false);
  });

  it('ignores contenteditable elements and their descendants', () => {
    expect(shouldToggleAiDebug(key({ target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget }))).toBe(false);
    const editor = { isContentEditable: true };
    const child = { tagName: 'SPAN', closest: () => editor };
    expect(shouldToggleAiDebug(key({ target: child as unknown as EventTarget }))).toBe(false);
  });
});
