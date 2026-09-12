import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mesh, Scene, ShaderMaterial, Texture, type BufferGeometry, type Material } from 'three';
import type { SpinView, SymbolId } from '../../shared/protocol';
import { settledOffset } from './ReelMotion';

const graphics = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), size: vi.fn() }));
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = { style: {} };
      info = { render: { calls: 9, triangles: 396, frame: 1 }, memory: { textures: 4, geometries: 9 } };
      setPixelRatio = vi.fn();
      setSize = graphics.size;
      render = graphics.render;
      dispose = graphics.dispose;
    },
    TextureLoader: class {
      load(_url: string, loaded: () => void) { const t = new actual.Texture(); loaded(); return t; }
    },
  };
});
import { ReelScene } from './ReelScene';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let page: EventTarget & { hidden: boolean };
let viewport: EventTarget;
let motion: EventTarget & { matches: boolean };
const views: ReelScene[] = [];

function setup() {
  const host = { clientWidth: 1280, clientHeight: 720, dataset: {}, append: vi.fn(), replaceChildren: vi.fn() };
  const view = new ReelScene(host as unknown as HTMLElement);
  views.push(view);
  return { view, host };
}
function spin(round = 1, symbols: [SymbolId, SymbolId, SymbolId] = ['seven', 'cherry', 'bell'], payout = 0): SpinView {
  return { side: 'player', round, symbols, payout, total: payout };
}
function frame(ms = 16) {
  vi.advanceTimersByTime(ms);
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(performance.now()));
}
function scene(): Scene { return graphics.render.mock.calls.at(-1)![0] as Scene; }
function reelOffsets() {
  return scene().children.filter((n): n is Mesh<BufferGeometry, ShaderMaterial> => n instanceof Mesh && n.material instanceof ShaderMaterial)
    .map(m => m.material.uniforms.offset.value % 3);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  frames = new Map();
  nextFrame = 0;
  page = Object.assign(new EventTarget(), { hidden: false });
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

describe('stage rendering and cleanup', () => {
  it('loads four shared textures and paints idle only once', () => {
    const { view, host } = setup();
    frame();
    expect(graphics.render).toHaveBeenCalledOnce();
    expect(host.dataset).toMatchObject({ artReady: 'true' });
    expect(view.stats().textures).toBe(4);
    expect(frames.size).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(graphics.render).toHaveBeenCalledOnce();
  });
  it('reveals the exact middle symbols before notifying, left then middle then right', () => {
    const { view } = setup();
    frame();
    const player = spin();
    const rival = { ...spin(1, ['bell', 'seven', 'cherry']), side: 'rival' as const };
    const completed = vi.fn(() => expect(reelOffsets()).toEqual([...player.symbols, ...rival.symbols].map(settledOffset)));
    view.play(player, rival, completed);
    frame(819);
    expect(completed).not.toHaveBeenCalled();
    frame(1);
    expect(reelOffsets()[0]).toBe(settledOffset('seven'));
    expect(reelOffsets()[1]).not.toBe(settledOffset('cherry'));
    frame(120);
    expect(reelOffsets()[1]).toBe(settledOffset('cherry'));
    expect(reelOffsets()[2]).not.toBe(settledOffset('bell'));
    frame(120);
    expect(completed).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
  it('keeps rival symbols square inside their wider windows, including mobile layout', () => {
    setup();
    frame();
    for (const mobile of [false, true]) {
      vi.stubGlobal('matchMedia', (query: string) => query.includes('max-width') ? { matches: mobile } : motion);
      viewport.dispatchEvent(new Event('resize'));
      frame();
      const minis = scene().children.filter((n): n is Mesh<BufferGeometry, ShaderMaterial> => n instanceof Mesh && n.material instanceof ShaderMaterial && n.material.uniforms.mini.value === 1);
      expect(minis).toHaveLength(3);
      for (const mesh of minis) {
        mesh.geometry.computeBoundingBox();
        const bounds = mesh.geometry.boundingBox!;
        const cellWidth = (bounds.max.x - bounds.min.x) * mesh.scale.x / mesh.material.uniforms.cellAspect.value;
        const cellHeight = (bounds.max.y - bounds.min.y) * mesh.scale.y;
        expect(cellWidth).toBeCloseTo(cellHeight, 6);
      }
    }
  });
  it('replaces obsolete rounds and ignores duplicate/older updates', () => {
    const { view } = setup();
    const old = vi.fn(), latest = vi.fn(), duplicate = vi.fn();
    view.play(spin(1), spin(1), old);
    frame(300);
    view.play(spin(4), spin(4), latest);
    view.play(spin(2), spin(2), duplicate);
    view.play(spin(4), spin(4), duplicate);
    frame(1100);
    expect(old).not.toHaveBeenCalled();
    expect(duplicate).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });
  it('does no hidden rendering and skips an old celebration after restoring a tab', () => {
    const { view, host } = setup();
    frame();
    const done = vi.fn();
    view.play(spin(1, ['seven', 'seven', 'seven'], 1200), spin(), done);
    page.hidden = true;
    page.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    vi.advanceTimersByTime(25000);
    expect(done).not.toHaveBeenCalled();
    page.hidden = false;
    page.dispatchEvent(new Event('visibilitychange'));
    frame();
    expect(done).toHaveBeenCalledOnce();
    expect(host.dataset).toMatchObject({ spinning: 'false', jackpot: 'false' });
    expect(frames.size).toBe(0);
  });
  it('honors reduced motion even when changed during a spin', () => {
    const { view } = setup();
    const done = vi.fn();
    view.play(spin(), spin(), done);
    frame(140);
    motion.matches = true;
    motion.dispatchEvent(new Event('change'));
    frame();
    expect(done).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
  it('cancels a pending completion and repaints resize without restarting', () => {
    const { view, host } = setup();
    const done = vi.fn();
    view.play(spin(), spin(), done);
    view.stop();
    host.clientWidth = 1920;
    host.clientHeight = 1080;
    viewport.dispatchEvent(new Event('resize'));
    frame(1500);
    expect(done).not.toHaveBeenCalled();
    expect(graphics.size).toHaveBeenLastCalledWith(1920, 1080, false);
    expect(host.dataset).toMatchObject({ win: 'false', jackpot: 'false' });
    expect(frames.size).toBe(0);
  });
  it('uses at most 24 coins in the same scene, bounded to 1.2 seconds', () => {
    const { view } = setup();
    view.show(['seven', 'seven', 'seven'], 1200);
    frame();
    const coins: Mesh[] = [];
    scene().traverse(n => { if (n instanceof Mesh && n.name === 'win-coin') coins.push(n); });
    expect(coins).toHaveLength(24);
    expect(coins.every(c => c.visible)).toBe(true);
    frame(1200);
    expect(coins.every(c => !c.visible)).toBe(true);
    expect(frames.size).toBe(0);
    motion.matches = true;
    view.show(['seven', 'seven', 'seven'], 1200);
    frame();
    expect(coins.every(c => !c.visible)).toBe(true);
    frame(180);
    expect(frames.size).toBe(0);
  });
  it('disposes all shared resources once, without a late callback or revived loop', () => {
    const { view, host } = setup();
    frame();
    const resources = new Set<{ dispose: () => void }>();
    scene().traverse(n => {
      if (!(n instanceof Mesh)) return;
      resources.add(n.geometry);
      const material = n.material as Material;
      resources.add(material);
      if ('map' in material && material.map instanceof Texture) resources.add(material.map);
      if (material instanceof ShaderMaterial && material.uniforms.atlas) resources.add(material.uniforms.atlas.value);
    });
    const disposals = [...resources].map(r => vi.spyOn(r, 'dispose'));
    const done = vi.fn();
    view.play(spin(), spin(), done);
    view.dispose();
    view.dispose();
    view.play(spin(2), spin(2), done);
    view.show(['cherry', 'cherry', 'cherry']);
    view.stop();
    viewport.dispatchEvent(new Event('resize'));
    page.dispatchEvent(new Event('visibilitychange'));
    motion.dispatchEvent(new Event('change'));
    expect(frames.size).toBe(0);
    expect(done).not.toHaveBeenCalled();
    disposals.forEach(d => expect(d).toHaveBeenCalledOnce());
    expect(graphics.dispose).toHaveBeenCalledOnce();
    expect(host.replaceChildren).toHaveBeenCalledOnce();
  });
});
