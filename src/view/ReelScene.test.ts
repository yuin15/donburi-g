import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mesh, Scene, Sprite } from 'three';

const graphics = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), size: vi.fn() }));
vi.mock('three', async (importOriginal) => ({
  ...await importOriginal<typeof import('three')>(),
  WebGLRenderer: class {
    domElement = { style: {} };
    setPixelRatio = vi.fn();
    setSize = graphics.size;
    render = graphics.render;
    dispose = graphics.dispose;
  },
}));
import { ReelScene } from './ReelScene';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let page: EventTarget & { hidden: boolean };
let viewport: EventTarget;
let motion: EventTarget & { matches: boolean };
const views: ReelScene[] = [];

function setup() {
  const host = { clientWidth: 720, clientHeight: 330, dataset: {}, append: vi.fn(), replaceChildren: vi.fn() };
  const view = new ReelScene(host as unknown as HTMLElement);
  views.push(view);
  return { view, host };
}

function frame() {
  vi.advanceTimersByTime(16);
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(performance.now()));
}

function scene(): Scene {
  return graphics.render.mock.calls.at(-1)![0] as Scene;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  frames = new Map();
  nextFrame = 0;
  page = Object.assign(new EventTarget(), { hidden: false, createElement: () => {
    const canvas = { width: 0, height: 0, glyph: '', getContext: () => ({ fillText: (text: string) => { canvas.glyph = text; } }) };
    return canvas;
  } });
  viewport = new EventTarget();
  motion = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('document', page);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('matchMedia', () => motion);
  vi.stubGlobal('addEventListener', viewport.addEventListener.bind(viewport));
  vi.stubGlobal('removeEventListener', viewport.removeEventListener.bind(viewport));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => {
  views.splice(0).forEach(view => view.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reel rendering and cleanup', () => {
  it('paints idle reels once instead of keeping a frame loop alive', () => {
    setup();
    frame();
    expect(graphics.render).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(graphics.render).toHaveBeenCalledOnce();
  });

  it('animates a spin, paints the confirmed middle symbols and then becomes idle', () => {
    const { view } = setup();
    frame();
    view.spin();
    frame();
    expect(frames.size).toBe(1);
    view.show(['seven', 'cherry', 'bell'], 120);
    frame();
    const labels = scene().children.filter((node): node is Sprite => node instanceof Sprite);
    const middle = labels.filter((_, index) => index % 3 === 1);
    expect(middle.map(label => label.material.map?.image.glyph)).toEqual(['7', '🍒', '🔔']);
    expect(middle.every(label => Math.abs(label.position.y) < 0.001 && label.material.opacity === 1)).toBe(true);
    expect(frames.size).toBe(0);
    expect(new Set(labels.map(label => label.material.map)).size).toBe(3);
  });

  it('settles even if no result update follows the animation', () => {
    const { view } = setup();
    view.spin();
    for (let count = 0; count < 40; count += 1) frame();
    expect(frames.size).toBe(0);
    expect(graphics.render.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops rendering while hidden, then paints the latest result when visible', () => {
    const { view } = setup();
    frame();
    view.spin();
    page.hidden = true;
    page.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    view.show(['seven', 'seven', 'seven'], 1200);
    expect(frames.size).toBe(0);
    const before = graphics.render.mock.calls.length;
    page.hidden = false;
    page.dispatchEvent(new Event('visibilitychange'));
    frame();
    expect(graphics.render.mock.calls.length).toBe(before + 1);
    expect(frames.size).toBe(0);
  });

  it('respects reduced motion and reacts to preference changes mid-spin', () => {
    const { view } = setup();
    frame();
    view.spin();
    frame();
    motion.matches = true;
    motion.dispatchEvent(new Event('change'));
    frame();
    expect(frames.size).toBe(0);
    view.spin();
    frame();
    expect(frames.size).toBe(0);
  });

  it('repaints a resize and stops a cancelled spin and win highlight', () => {
    const { view, host } = setup();
    frame();
    host.clientWidth = 480;
    viewport.dispatchEvent(new Event('resize'));
    frame();
    expect(graphics.size).toHaveBeenLastCalledWith(480, 330, false);
    expect(frames.size).toBe(0);
    view.show(['seven', 'seven', 'seven'], 1200);
    view.spin();
    view.stop();
    frame();
    expect(host.dataset).toMatchObject({ win: 'false', jackpot: 'false' });
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
  });

  it('disposes shared textures, geometry and materials once and cannot restart', () => {
    const { view, host } = setup();
    frame();
    const resources = new Set<{ dispose: () => void }>();
    for (const node of scene().children) {
      if (node instanceof Mesh) {
        resources.add(node.geometry);
        if (!Array.isArray(node.material)) resources.add(node.material);
      }
      if (node instanceof Sprite) {
        resources.add(node.material);
        if (node.material.map) resources.add(node.material.map);
      }
    }
    const disposals = [...resources].map(resource => vi.spyOn(resource, 'dispose'));
    view.show(['seven', 'seven', 'seven'], 1200);
    view.spin();
    view.dispose();
    view.dispose();
    view.spin();
    view.show(['cherry', 'cherry', 'cherry']);
    view.stop();
    viewport.dispatchEvent(new Event('resize'));
    page.dispatchEvent(new Event('visibilitychange'));
    motion.dispatchEvent(new Event('change'));
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    disposals.forEach(dispose => expect(dispose).toHaveBeenCalledOnce());
    expect(graphics.dispose).toHaveBeenCalledOnce();
    expect(host.replaceChildren).toHaveBeenCalledOnce();
  });
});
