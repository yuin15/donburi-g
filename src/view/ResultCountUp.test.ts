import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResultCountUp } from './ResultCountUp';

type FakeElement = { node: HTMLElement; attrs: Map<string, string> };

function makeElement(): FakeElement {
  const attrs = new Map<string, string>();
  const node = {
    textContent: '',
    setAttribute: (name: string, value: string) => { attrs.set(name, value); },
    removeAttribute: (name: string) => { attrs.delete(name); },
  } as unknown as HTMLElement;
  return { node, attrs };
}

function makeHarness() {
  const documentListeners = new Set<() => void>();
  const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
  const frames = new Map<number, FrameRequestCallback>();
  const mediaState = { matches: false };
  let nextFrame = 1;
  const documentRef = {
    hidden: false,
    addEventListener: vi.fn((_type: string, listener: EventListener) => { documentListeners.add(listener as () => void); }),
    removeEventListener: vi.fn((_type: string, listener: EventListener) => { documentListeners.delete(listener as () => void); }),
  } as unknown as Document;
  const media = {
    get matches() { return mediaState.matches; },
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => { mediaListeners.add(listener); }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => { mediaListeners.delete(listener); }),
  } as unknown as MediaQueryList;
  vi.stubGlobal('document', documentRef);
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id); }));
  return {
    documentRef,
    media,
    mediaState,
    emitVisibility: () => documentListeners.forEach(listener => listener()),
    emitMedia: () => mediaListeners.forEach(listener => listener({ matches: media.matches } as MediaQueryListEvent)),
    advance: (timestamp: number) => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(timestamp));
    },
    pendingFrames: () => frames.size,
  };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('counts both sides on one eased timeline and finishes with exact currency', () => {
  const h = makeHarness();
  const player = makeElement();
  const rival = makeElement();
  const count = new ResultCountUp();
  count.start(player.node, rival.node, { player: 1200, rival: 600 });
  expect(player.attrs.get('aria-label')).toBe('$1,200');
  expect(rival.attrs.get('aria-label')).toBe('$600');
  expect(player.node.textContent).toBe('$0');
  h.advance(0);
  h.advance(900);
  expect(player.node.textContent).toBe('$1,050');
  expect(rival.node.textContent).toBe('$525');
  h.advance(1800);
  expect(player.node.textContent).toBe('$1,200');
  expect(rival.node.textContent).toBe('$600');
  expect(h.pendingFrames()).toBe(0);
  count.dispose();
});

it('settles on stop, hidden state, and reduced motion without reviving', () => {
  const h = makeHarness();
  const player = makeElement();
  const rival = makeElement();
  const count = new ResultCountUp();
  count.start(player.node, rival.node, { player: 1200, rival: 600 });
  h.advance(0);
  count.stop();
  expect(player.node.textContent).toBe('$1,200');
  expect(h.pendingFrames()).toBe(0);
  h.advance(5000);
  expect(player.node.textContent).toBe('$1,200');

  count.start(player.node, rival.node, { player: 900, rival: 300 });
  h.advance(0);
  (h.documentRef as unknown as { hidden: boolean }).hidden = true;
  h.emitVisibility();
  expect(player.node.textContent).toBe('$900');
  (h.documentRef as unknown as { hidden: boolean }).hidden = false;
  h.advance(5000);
  expect(player.node.textContent).toBe('$900');

  h.mediaState.matches = true;
  count.start(player.node, rival.node, { player: 700, rival: 200 });
  expect(player.node.textContent).toBe('$700');
  expect(h.pendingFrames()).toBe(0);
  h.mediaState.matches = false;
  h.emitMedia();
  h.advance(5000);
  expect(player.node.textContent).toBe('$700');
  count.dispose();
  count.dispose();
  expect(h.documentRef.removeEventListener).toHaveBeenCalledTimes(1);
  expect(h.media.removeEventListener).toHaveBeenCalledTimes(1);
});

it('cancels a previous rematch run before the new values can finish over it', () => {
  const h = makeHarness();
  const player = makeElement();
  const rival = makeElement();
  const count = new ResultCountUp();
  count.start(player.node, rival.node, { player: 1200, rival: 600 });
  h.advance(0);
  count.start(player.node, rival.node, { player: 55, rival: 12 });
  h.advance(10);
  h.advance(1810);
  expect(player.node.textContent).toBe('$55');
  expect(rival.node.textContent).toBe('$12');
  h.advance(9999);
  expect(player.node.textContent).toBe('$55');
  expect(rival.node.textContent).toBe('$12');
  expect(h.pendingFrames()).toBe(0);
  count.dispose();
});
