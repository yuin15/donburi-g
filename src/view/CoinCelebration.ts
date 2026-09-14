import * as THREE from 'three';
import type { Side, SymbolId } from '../../shared/protocol';
import { VICTORY_DURATION } from '../viewmodel/RewardPresentation';
import { OVERLAYS, STAGE_HEIGHT } from './StageLayout';

export type CoinStyle = 'fountain' | 'rain';
type Lane = { mesh: THREE.InstancedMesh; side: Side; started: number; duration: number; count: number; still: boolean; jackpot: boolean };
const clamp = THREE.MathUtils.clamp;
const mix = THREE.MathUtils.lerp;
const smooth = (x: number) => { const p = clamp(x, 0, 1); return p * p * (3 - 2 * p); };
const random = (index: number, salt: number) => { const n = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453; return n - Math.floor(n); };

/** Fixed GPU pools: two overlapping payouts per side, plus one victory shower. */
export class CoinCelebration {
  readonly group = new THREE.Group();
  readonly arrivals: Record<Side, number> = { player: 0, rival: 0 };
  private readonly pose = new THREE.Object3D();
  private readonly lanes: Lane[];
  private readonly victory: THREE.InstancedMesh;
  private victoryStarted = -Infinity;
  private style: CoinStyle = 'fountain';

  constructor(geometry: THREE.BufferGeometry, materials: Record<Side, THREE.MeshStandardMaterial>) {
    const make = (count: number, side: Side) => {
      const mesh = new THREE.InstancedMesh(geometry, materials[side], count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.name = 'win-coin';
      mesh.userData.side = side;
      this.group.add(mesh);
      return mesh;
    };
    this.lanes = (['player', 'player', 'rival', 'rival'] as const).map(side => ({
      mesh: make(side === 'player' ? 54 : 18, side), side, started: -Infinity, duration: 0, count: 0, still: false, jackpot: false,
    }));
    this.victory = make(96, 'player');
    this.victory.userData.victory = true;
  }

  setStyle(style: CoinStyle): void { this.style = style; }

  burst(side: Side, symbol: SymbolId | null, jackpot: boolean, now: number, duration: number, still: boolean): void {
    const candidates = this.lanes.filter(lane => lane.side === side);
    const lane = candidates.find(candidate => now >= candidate.started + candidate.duration) ?? candidates.reduce((a, b) => a.started < b.started ? a : b);
    Object.assign(lane, { started: now, duration, still, jackpot, count: side === 'player' ? jackpot ? 54 : symbol === 'bell' ? 18 : 6 : jackpot ? 18 : symbol === 'bell' ? 9 : 4 });
  }

  celebrate(now: number): void {
    this.stop();
    this.victoryStarted = now;
  }

  stop(side?: Side): void {
    for (const lane of this.lanes) if (!side || lane.side === side) {
      lane.started = -Infinity;
      lane.still = false;
      lane.mesh.visible = false;
      lane.mesh.count = 0;
    }
    if (!side) {
      this.victoryStarted = -Infinity;
      this.victory.visible = false;
      this.victory.count = 0;
    }
  }

  private setCoin(mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, size: number, spin: number): void {
    this.pose.position.set(x, STAGE_HEIGHT - y, z);
    this.pose.rotation.set(.3 + Math.sin(spin * .7) * .38, spin, Math.sin(index * 1.3) + spin * .17);
    this.pose.scale.setScalar(Math.max(.0001, size));
    this.pose.updateMatrix();
    mesh.setMatrixAt(index, this.pose.matrix);
  }

  update(now: number, reducedMotion: boolean): boolean {
    this.arrivals.player = this.arrivals.rival = 0;
    if (reducedMotion) { this.stop(); return false; }
    let active = false;
    for (const lane of this.lanes) {
      const progress = lane.still ? .4 : (now - lane.started) / lane.duration;
      lane.mesh.visible = progress >= 0 && progress < 1;
      lane.mesh.count = lane.mesh.visible ? lane.count : 0;
      if (!lane.mesh.visible) continue;
      active ||= !lane.still;
      const player = lane.side === 'player';
      const score = OVERLAYS[player ? 'playerScore' : 'rivalScore'];
      const endX = score.x + score.w - 38, endY = score.y + score.h * .58;
      for (let i = 0; i < lane.count; i++) {
        const seed = random(i, 1), depth = random(i, 2);
        const right = i % 2 === 1;
        const delay = lane.jackpot ? i < 6 ? i * .03 : .1 + seed * .34 : seed * .13;
        const arrival = .86 + (i % 5) * .025;
        const t = clamp((progress - delay) / (arrival - delay), 0, 1);
        const collect = smooth((t - .63) / .37);
        const launch = smooth(t / .1);
        const fan = clamp(t / .63, 0, 1);
        // The left and right lanes keep the winning reels, timer and face clear.
        const sourceX = player ? right ? 820 : 235 : right ? 1620 : 960;
        const outerX = player ? right ? 870 + seed * 75 : 95 + seed * 75 : right ? 1610 + seed * 25 : 943 + seed * 25;
        let x = mix(sourceX, outerX, Math.sin(fan * Math.PI / 2));
        let y = mix(player ? 690 : 770, player ? 160 + seed * 110 : 132, fan) - Math.sin(fan * Math.PI) * (player ? 170 : 70);
        if (this.style === 'rain' && player && lane.jackpot) {
          x = right ? 830 + seed * 105 : 65 + seed * 135;
          y = 150 + fan * 470 + depth * 80;
        }
        x = mix(x, endX, collect);
        y = mix(y, endY, collect);
        const hero = player && lane.jackpot && i < 6;
        const near = Math.sin(t * Math.PI);
        const size = (hero ? 1.75 + near * 1.1 : (player ? .62 : .43) + depth * .65 + near * .3) * launch * (1 - smooth((t - .88) / .12));
        this.setCoin(lane.mesh, i, x, y, 120 + depth * 110 + near * (hero ? 340 : 160), size, i * .71 + t * (hero ? 5.4 : 10 + seed * 9));
        if (!lane.still) this.arrivals[lane.side] = Math.max(this.arrivals[lane.side], Math.sin(clamp((t - .91) / .09, 0, 1) * Math.PI));
      }
      lane.mesh.instanceMatrix.needsUpdate = true;
    }
    const elapsed = now - this.victoryStarted;
    this.victory.visible = elapsed >= 0 && elapsed < VICTORY_DURATION;
    this.victory.count = this.victory.visible ? 96 : 0;
    if (this.victory.visible) {
      active = true;
      const time = elapsed / 1000;
      for (let i = 0; i < 96; i++) {
        const seed = random(i, 4), depth = random(i, 5);
        const right = i % 2 === 1;
        const fountain = i < 36 && this.style === 'fountain';
        const age = time - (fountain ? seed * .28 : .45 + seed * 1.25);
        const life = fountain ? 1.65 : 1.25;
        const t = clamp(age / life, 0, 1);
        // A coin curtain beside the result, never across the cash or REMATCH.
        const laneX = right ? 842 + seed * 91 : 68 + seed * 132;
        const x = fountain ? mix(right ? 824 : 229, laneX, smooth(t * 2)) : laneX + Math.sin(age * 2 + i) * 14;
        const y = fountain ? 850 - Math.sin(t * Math.PI) * (650 + depth * 135) : 125 + t * 800;
        const envelope = age < 0 || age > life ? 0 : smooth(t / .08) * (1 - smooth((t - .83) / .17));
        const hero = i % 19 === 0;
        const size = (hero ? 2.5 : .58 + depth * .95) * envelope;
        this.setCoin(this.victory, i, x, y, 160 + depth * 260, size, i + age * (hero ? 3.6 : 6 + seed * 5));
      }
      this.victory.instanceMatrix.needsUpdate = true;
    }
    return active;
  }

  dispose(): void {
    this.stop();
    for (const lane of this.lanes) lane.mesh.dispose();
    this.victory.dispose();
  }
}
