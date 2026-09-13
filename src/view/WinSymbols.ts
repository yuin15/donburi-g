import * as THREE from 'three';
import type { Side } from '../../shared/protocol';
import { MINI_RECTS, REEL_RECTS, STAGE_HEIGHT } from './StageLayout';
import { createSymbolModels, type SymbolModels, type WinSymbol } from './SymbolModels';
import { createSymbolAtlas } from './SymbolAtlas';
import { SculptedType } from './SculptedType';
import { PAYOUT } from '../domain/game';

const clamp = THREE.MathUtils.clamp;
const smooth = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
type LiftedSymbols = { group: THREE.Group; meshes: THREE.InstancedMesh[] };
export type WinningCell = { row: 0 | 1 | 2; column: 0 | 1 | 2; symbol: WinSymbol };

/** Winning sculptures leave their reels, turn in the light, then return to the drum. */
export class WinSymbols {
  readonly playerGroup = new THREE.Group();
  readonly rivalGroup = new THREE.Group();
  private readonly source: SymbolModels;
  private readonly models: Record<Side, Record<WinSymbol, LiftedSymbols>>;
  private readonly rewards: Record<Side, Record<WinSymbol, THREE.Group>>;
  private readonly rewardKeys: Record<Side, string> = { player: '', rival: '' };
  private readonly typography: SculptedType;
  private readonly obscured: Record<Side, [number, number, number][]> = {
    player: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    rival: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
  };
  private readonly pose = new THREE.Object3D();

  constructor(environment: THREE.Texture) {
    this.source = createSymbolModels(environment);
    this.typography = new SculptedType(environment);
    const copies = (side: Side) => {
      const root = side === 'player' ? this.playerGroup : this.rivalGroup;
      const models = {} as Record<WinSymbol, LiftedSymbols>;
      const rewards = {} as Record<WinSymbol, THREE.Group>;
      for (const kind of ['bell', 'cherry', 'seven'] as const) {
        const lifted = new THREE.Group();
        lifted.name = `${side}-lift-${kind}`;
        lifted.visible = false;
        const meshes: THREE.InstancedMesh[] = [];
        this.source[kind].traverse(node => {
          if (!(node instanceof THREE.Mesh)) return;
          const mesh = new THREE.InstancedMesh(node.geometry, node.material, 9);
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.frustumCulled = false;
          meshes.push(mesh); lifted.add(mesh);
        });
        models[kind] = { group: lifted, meshes };
        root.add(lifted);
        const group = new THREE.Group();
        group.name = `${side}-physical-reward-${kind}`;
        const player = side === 'player';
        const number = this.typography.make('+' + PAYOUT[kind].toLocaleString('en-US'), player ? 90 : 43, player ? 435 : 310, player ? 26 : 12);
        number.position.y = player ? 30 : 12;
        const caption = this.typography.make(kind === 'seven' ? 'BIG WIN' : kind === 'bell' ? 'BELL WIN' : 'CHERRY WIN', player ? 20 : 13, player ? 220 : 160, 5);
        caption.position.set(0, player ? -44 : -29, 4);
        group.add(number, caption);
        group.visible = false;
        root.add(group);
        rewards[kind] = group;
      }
      return { models, rewards };
    };
    const player = copies('player'), rival = copies('rival');
    this.models = { player: player.models, rival: rival.models };
    this.rewards = { player: player.rewards, rival: rival.rewards };
    (['cherry', 'bell', 'seven'] as const).forEach((kind, index) => {
      const icon = this.source[kind].clone(true);
      icon.name = 'paytable-' + kind;
      icon.position.set(221, STAGE_HEIGHT - (746 + index * 30), 148);
      icon.rotation.set(kind === 'bell' ? -.18 : 0, -.12, kind === 'seven' ? -.06 : 0);
      icon.scale.setScalar(kind === 'bell' ? 12 : 11);
      this.playerGroup.add(icon);
    });
  }

  createReelAtlas(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
    return createSymbolAtlas(renderer, this.source);
  }

  reelInkHidden(side: Side, column: number): [number, number, number] { return this.obscured[side][column]; }

  update(side: Side, cells: readonly WinningCell[], primary: WinSymbol | null, totalPayout: number, progress: number, reducedMotion: boolean, liftReels: boolean): void {
    const player = side === 'player';
    const lift = reducedMotion ? 0 : smooth(progress / .19) * (1 - smooth((progress - .65) / .35));
    this.obscured[side] = [0, 1, 2].map(column => ([0, 1, 2].map(row => Number(liftReels && cells.some(cell => cell.column === column && cell.row === row)) as 0 | 1) as [number, number, number])) as [number, number, number][];
    for (const symbol of ['bell', 'cherry', 'seven'] as const) {
      const symbolCells = cells.filter(cell => cell.symbol === symbol);
      this.models[side][symbol].group.visible = symbolCells.length > 0 && liftReels;
      this.rewards[side][symbol].visible = symbol === primary;
      this.models[side][symbol].meshes.forEach(mesh => { mesh.count = symbolCells.length; });
    }
    if (primary) {
      const reward = this.rewards[side][primary];
      this.configureReward(side, primary, totalPayout);
      const entrance = reducedMotion ? 1 : smooth(progress / .22);
      const leave = reducedMotion ? 0 : smooth((progress - .78) / .22);
      reward.position.set(player ? 530 : 1254, STAGE_HEIGHT - (player ? 679 : 646) + (1 - entrance) * -30 + leave * 30, 168 + lift * 55);
      reward.rotation.set(-.21 + (1 - entrance) * .65, -.3 + (1 - entrance) * -.3, player ? .028 : -.015);
      reward.scale.setScalar(Math.max(.001, (.6 + .4 * entrance) * (1 - leave)));
    }
    if (cells.length === 0) return;

    const rects = player ? REEL_RECTS : MINI_RECTS;
    for (const kind of ['bell', 'cherry', 'seven'] as const) {
      const symbolCells = cells.filter(cell => cell.symbol === kind);
      const jackpot = kind === 'seven';
      symbolCells.forEach((cell, index) => {
        const rect = rects[cell.column];
        const model = this.pose;
        const base = player ? kind === 'bell' ? 64 : 60 : kind === 'bell' ? 39 : 36;
        // The center artwork is hidden while the corresponding real mesh occupies its cell.
        const flourish = reducedMotion ? 0 : Math.sin(progress * Math.PI * (kind === 'bell' ? 5 : 3) + cell.column * .6) * lift;
        const row = player ? cell.row - 1 : 0;
        const reelY = player ? this.playerCellY(rect, row) : rect.y + rect.h / 2;
        model.position.set(rect.x + rect.w / 2 + (cell.column - 1) * lift * (player ? 13 : 3), STAGE_HEIGHT - reelY + lift * (player ? 10 : 5), 45 + lift * (player ? 140 : 65));
        model.rotation.set(-.05 - lift * .14, lift * ((cell.column - 1) * .33 - .3), lift * (cell.column - 1) * -.055 + flourish * (kind === 'bell' ? .1 : .028));
        model.scale.setScalar(base * (1 + lift * (player ? jackpot ? .36 : .24 : .12)));
        if (kind === 'seven') model.scale.z *= 1 + lift * .8;
        model.updateMatrix();
        this.models[side][kind].meshes.forEach(mesh => mesh.setMatrixAt(index, model.matrix));
      });
      this.models[side][kind].meshes.forEach(mesh => { mesh.instanceMatrix.needsUpdate = true; });
    }
  }

  private playerCellY(rect: { y: number; h: number }, row: number): number {
    const normalized = .5 - Math.sin(row / 1.53 * Math.asin(.85)) / 1.7;
    return rect.y + rect.h * (1 - normalized);
  }

  private configureReward(side: Side, kind: WinSymbol, payout: number): void {
    const key = `${kind}:${payout}`;
    if (this.rewardKeys[side] === key) return;
    this.rewardKeys[side] = key;
    const player = side === 'player';
    const reward = this.rewards[side][kind];
    reward.clear();
    const number = this.typography.make('+' + payout.toLocaleString('en-US'), player ? 90 : 43, player ? 435 : 310, player ? 26 : 12);
    number.position.y = player ? 30 : 12;
    const caption = this.typography.make(payout >= PAYOUT.seven ? 'BIG WIN' : kind === 'bell' ? 'BELL WIN' : 'CHERRY WIN', player ? 20 : 13, player ? 220 : 160, 5);
    caption.position.set(0, player ? -44 : -29, 4);
    reward.add(number, caption);
  }

  dispose(): void {
    for (const side of ['player', 'rival'] as const) {
      Object.values(this.models[side]).forEach(model => model.meshes.forEach(mesh => mesh.dispose()));
    }
    this.source.dispose(); this.typography.dispose();
    this.playerGroup.clear(); this.rivalGroup.clear();
  }
}
