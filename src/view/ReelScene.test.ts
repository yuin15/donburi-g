import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mesh, Scene, ShaderMaterial, Texture, type BufferGeometry, type Material } from 'three';
import type { SpinView, SymbolId } from '../../shared/protocol';
import { SYMBOLS } from './ReelMotion';
import { createSymbolAtlas } from './SymbolAtlas';

const graphics = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), size: vi.fn() }));
// These tests exercise scene scheduling; the GPU bake is checked in Chrome.
vi.mock('./SymbolAtlas', async () => {
  const { WebGLRenderTarget } = await import('three');
  return { createSymbolAtlas: vi.fn(() => new WebGLRenderTarget(3, 1)) };
});
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = { style: {} };
      shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false };
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
function reels(): Mesh<BufferGeometry, ShaderMaterial>[] {
  const meshes: Mesh<BufferGeometry, ShaderMaterial>[] = [];
  scene().traverse(node => {
    if (node instanceof Mesh && node.material instanceof ShaderMaterial && node.name.startsWith('reel-')) meshes.push(node);
  });
  return meshes.sort((a, b) => a.name.localeCompare(b.name));
}
function reelWins() {
  return reels()
    .map(mesh => mesh.material.uniforms.winning.value as number);
}
function coins() {
  const result: Mesh[] = [];
  scene().traverse(node => { if (node instanceof Mesh && node.name === 'win-coin') result.push(node); });
  return result;
}
function reelCenters() {
  return reels()
    .map(m => {
      const { offset, strip, stripLength } = m.material.uniforms;
      if (!Number.isInteger(offset.value)) return null;
      const cell = ((-offset.value % stripLength.value) + stripLength.value) % stripLength.value;
      return SYMBOLS[strip.value[cell]];
    });
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
  it('loads shared artwork and paints idle only once', () => {
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
    const completed = vi.fn(() => expect(reelCenters()).toEqual([...player.symbols, ...rival.symbols]));
    view.play(player, rival, completed);
    frame(819);
    expect(completed).not.toHaveBeenCalled();
    frame(1);
    expect(reelCenters()[0]).toBe('seven');
    expect(reelCenters()[1]).not.toBe('cherry');
    frame(120);
    expect(reelCenters()[1]).toBe('cherry');
    expect(reelCenters()[2]).not.toBe('bell');
    frame(120);
    expect(completed).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
  it('keeps rival symbols square when resizing the PC stage', () => {
    const { host } = setup();
    frame();
    for (const [width, height] of [[1280, 720], [1920, 1080]]) {
      host.clientWidth = width;
      host.clientHeight = height;
      viewport.dispatchEvent(new Event('resize'));
      frame();
      expect(graphics.size).toHaveBeenLastCalledWith(width, height, false);
      const minis = reels().filter(mesh => mesh.material.uniforms.mini.value === 1);
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
  it('overlaps independent spins without a player start or stop clearing the rival win', () => {
    const { view, host } = setup();
    const playerDone = vi.fn(), rivalDone = vi.fn();
    const rival = { ...spin(8, ['seven', 'seven', 'seven'], 1200), side: 'rival' as const };
    view.playSide(rival, rivalDone);
    frame(300);
    view.playSide(spin(1), playerDone);
    expect(host.dataset).toMatchObject({ playerSpinning: 'true', rivalSpinning: 'true' });
    frame(760);
    expect(rivalDone).toHaveBeenCalledOnce();
    expect(playerDone).not.toHaveBeenCalled();
    expect(host.dataset).toMatchObject({ playerSpinning: 'true', rivalSpinning: 'false', rivalRound: '8', rivalWin: 'true' });
    frame(300);
    expect(playerDone).toHaveBeenCalledOnce();
    expect(host.dataset).toMatchObject({ playerRound: '1', rivalRound: '8', rivalWin: 'true' });
    view.playSide(spin(2), vi.fn());
    expect(host.dataset).toMatchObject({ rivalWin: 'true' });
    expect(reelCenters().slice(3)).toEqual(rival.symbols);
    frame(900);
    expect(host.dataset).toMatchObject({ rivalWin: 'false' });
  });
  it('replaces obsolete rounds and ignores duplicate/older updates', () => {
    const { view } = setup();
    const old = vi.fn(), latest = vi.fn(), duplicate = vi.fn();
    view.playSide(spin(1), old);
    frame(300);
    view.playSide(spin(4), latest);
    view.playSide(spin(2), duplicate);
    view.playSide(spin(4), duplicate);
    frame(1100);
    expect(old).not.toHaveBeenCalled();
    expect(duplicate).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });
  it('does no hidden rendering and skips an old celebration after restoring a tab', () => {
    const { view, host } = setup();
    frame();
    const done = vi.fn();
    view.play(spin(1, ['seven', 'seven', 'seven'], 1200), { ...spin(1, ['seven', 'seven', 'seven'], 1200), side: 'rival' }, done);
    page.hidden = true;
    page.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    vi.advanceTimersByTime(25000);
    expect(done).not.toHaveBeenCalled();
    page.hidden = false;
    page.dispatchEvent(new Event('visibilitychange'));
    frame();
    expect(done).toHaveBeenCalledOnce();
    expect(host.dataset).toMatchObject({ spinning: 'false', jackpot: 'false', rivalWin: 'false', rivalJackpot: 'false' });
    expect(reelWins()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(frames.size).toBe(0);
  });
  it('honors reduced motion even when changed during a spin', () => {
    const { view } = setup();
    const done = vi.fn();
    view.playSide(spin(), done);
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
    view.playSide(spin(), done);
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
    expect(coins.filter(c => c.visible)).toHaveLength(12);
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
  it.each([[30, 0], [0, 30], [3, 30]])('lights the correct sides for player %i and rival %i, with independent expiry', (playerPayout, rivalPayout) => {
    const { view, host } = setup();
    const player = spin(1, playerPayout === 30 ? ['seven', 'seven', 'seven'] : playerPayout ? ['cherry', 'cherry', 'cherry'] : ['cherry', 'bell', 'seven'], playerPayout);
    const rival = { ...spin(1, rivalPayout ? ['seven', 'seven', 'seven'] : ['bell', 'cherry', 'seven'], rivalPayout), side: 'rival' as const };
    view.play(player, rival, vi.fn());
    frame(1060);
    expect(reelCenters()).toEqual([...player.symbols, ...rival.symbols]);
    expect(reelWins()).toEqual([playerPayout > 0 ? 1 : 0, playerPayout > 0 ? 1 : 0, playerPayout > 0 ? 1 : 0, rivalPayout > 0 ? 1 : 0, rivalPayout > 0 ? 1 : 0, rivalPayout > 0 ? 1 : 0]);
    expect(host.dataset).toMatchObject({ win: String(playerPayout > 0), rivalWin: String(rivalPayout > 0), rivalJackpot: String(rivalPayout >= 30) });
    expect(coins().filter(coin => coin.visible)).toHaveLength((playerPayout >= 30 ? 12 : 0) + (rivalPayout >= 30 ? 12 : 0));
    frame(650);
    if (playerPayout === 3) expect(reelWins().slice(0, 3)).toEqual([0, 0, 0]);
    if (rivalPayout > 0) expect(reelWins().slice(3)).toEqual([1, 1, 1]);
    frame(550);
    expect(reelWins()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(coins().every(coin => !coin.visible)).toBe(true);
    expect(frames.size).toBe(0);
  });
  it('clears both reel highlights on the next play while a previous player burst keeps its original lifetime', () => {
    const { view, host } = setup();
    view.play(spin(1, ['seven', 'seven', 'seven'], 1200), { ...spin(1, ['seven', 'seven', 'seven'], 1200), side: 'rival' }, vi.fn());
    frame(1060);
    frame(50);
    view.play(spin(2), { ...spin(2), side: 'rival' }, vi.fn());
    frame(16);
    expect(reelWins()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(host.dataset).toMatchObject({ win: 'false', rivalWin: 'false', rivalJackpot: 'false' });
    expect(coins().some(coin => coin.visible)).toBe(true);
    frame(1044); // The following miss stops 90ms before the previous burst ends.
    expect(host.dataset).toMatchObject({ spinning: 'false', round: '2' });
    expect(coins().some(coin => coin.visible)).toBe(true);
    frame(89);
    expect(coins().some(coin => coin.visible)).toBe(true);
    frame(1);
    expect(coins().every(coin => !coin.visible)).toBe(true);
    expect(frames.size).toBe(0);
    view.show(['seven', 'seven', 'seven'], 1200, ['bell', 'cherry', 'seven'], true);
    frame();
    view.play(spin(3), { ...spin(3), side: 'rival' }, vi.fn());
    frame();
    expect(coins().every(coin => !coin.visible)).toBe(true);
  });
  it('bounds rival-only flashes, supports a still preview, and clears them on reset, stop and disposal', () => {
    const { view, host } = setup();
    const symbols: [SymbolId, SymbolId, SymbolId] = ['bell', 'bell', 'bell'];
    view.show(symbols, 0, symbols, false, 6);
    frame();
    expect(reelWins()).toEqual([0, 0, 0, 1, 1, 1]);
    expect(coins().filter(coin => coin.visible)).toHaveLength(6);
    frame(650);
    expect(reelWins()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(frames.size).toBe(0);
    motion.matches = true;
    view.show(symbols, 0, symbols, false, 30);
    frame(180);
    expect(host.dataset).toMatchObject({ rivalWin: 'false', rivalJackpot: 'false' });
    expect(frames.size).toBe(0);
    view.show(symbols, 0, symbols, true, 6);
    frame();
    expect(reelWins().slice(3)).toEqual([1, 1, 1]);
    expect(frames.size).toBe(0);
    view.show(symbols);
    frame();
    expect(reelWins()).toEqual([0, 0, 0, 0, 0, 0]);
    view.show(symbols, 0, symbols, true, 240);
    view.stop();
    frame();
    expect(reelWins()).toEqual([0, 0, 0, 0, 0, 0]);
    view.show(symbols, 0, symbols, true, 240);
    view.dispose();
    expect(host.dataset).toMatchObject({ rivalWin: 'false', rivalJackpot: 'false' });
    expect(frames.size).toBe(0);
  });
  it('routes the rival coins up its own outer edges without touching the face or player payline', () => {
    const { view } = setup();
    view.show(['cherry', 'bell', 'seven'], 0, ['seven', 'seven', 'seven'], false, 1200);
    frame(300);
    const active = coins().filter(coin => coin.visible);
    expect(active).toHaveLength(12);
    const before = active.map(coin => coin.position.clone());
    frame(400);
    active.forEach((coin, i) => {
      expect(coin.position.y).toBeGreaterThan(before[i].y);
      expect(coin.position.x < 1045 || coin.position.x > 1500).toBe(true);
    });
    frame(500);
    expect(coins().every(coin => !coin.visible)).toBe(true);
    expect(frames.size).toBe(0);
  });
  it('disposes all shared resources once, without a late callback or revived loop', () => {
    const { view, host } = setup();
    frame();
    const resources = new Set<{ dispose: () => void }>();
    scene().traverse(n => {
      if (!(n instanceof Mesh)) return;
      resources.add(n.geometry);
      const materials: Material[] = Array.isArray(n.material) ? n.material : [n.material];
      for (const material of materials) {
        resources.add(material);
        if ('map' in material && material.map instanceof Texture) resources.add(material.map);
        // RenderTarget owns its GPU texture and framebuffer; dispose that owner.
        if (material instanceof ShaderMaterial && material.uniforms.atlas) resources.add(vi.mocked(createSymbolAtlas).mock.results[0].value);
      }
    });
    const disposals = [...resources].map(r => vi.spyOn(r, 'dispose'));
    const done = vi.fn();
    view.playSide(spin(), done);
    view.dispose();
    view.dispose();
    view.playSide(spin(2), done);
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
