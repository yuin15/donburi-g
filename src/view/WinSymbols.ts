import * as THREE from 'three';
import type { Side } from '../../shared/protocol';
import { STAGE_HEIGHT } from './StageLayout';
import { createSymbolModels, type SymbolModels, type WinSymbol } from './SymbolModels';
import { createSymbolAtlas } from './SymbolAtlas';

/** Small 3D rewards between the WIN label and amount, clear of the payline. */
export class WinSymbols {
  readonly group = new THREE.Group();
  private readonly source: SymbolModels;
  private readonly models: Record<Side, Record<WinSymbol, THREE.Group>>;
  private readonly materials: Record<Side, THREE.MeshStandardMaterial[]>;

  constructor(environment: THREE.Texture) {
    this.source = createSymbolModels(environment);
    const copies = (side: Side) => {
      const materials = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>();
      const copy = (kind: WinSymbol) => {
        const group = this.source[kind].clone(true);
        group.name = side + '-win-' + kind;
        group.visible = false;
        group.traverse(node => {
          if (!(node instanceof THREE.Mesh)) return;
          const original = node.material as THREE.MeshStandardMaterial;
          let material = materials.get(original);
          if (!material) {
            material = original.clone();
            material.transparent = true;
            materials.set(original, material);
          }
          node.material = material;
        });
        this.group.add(group);
        return group;
      };
      const models = { bell: copy('bell'), cherry: copy('cherry'), seven: copy('seven') };
      return { models, materials: [...materials.values()] };
    };
    const player = copies('player'), rival = copies('rival');
    this.models = { player: player.models, rival: rival.models };
    this.materials = { player: player.materials, rival: rival.materials };
  }

  createReelAtlas(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
    return createSymbolAtlas(renderer, this.source);
  }

  update(side: Side, kind: WinSymbol | null, progress: number, opacity: number, reducedMotion: boolean): void {
    const models = this.models[side];
    models.bell.visible = kind === 'bell';
    models.cherry.visible = kind === 'cherry';
    models.seven.visible = kind === 'seven';
    if (!kind) return;
    const model = models[kind];
    const player = side === 'player';
    const motion = reducedMotion ? 0 : Math.sin(progress * Math.PI * 4) * Math.exp(-progress * 3);
    const pop = reducedMotion ? 1 : 1 + Math.sin(Math.min(1, progress * 3) * Math.PI) * .14;
    model.position.set(player ? 554 : 1280, STAGE_HEIGHT - (player ? 204 : 658) + (reducedMotion ? 0 : Math.sin(progress * Math.PI) * 3), 65);
    model.rotation.set(kind === 'bell' ? -.34 : -.1, -.22 + motion * .18, (kind === 'bell' ? .1 : -.1) + motion * (kind === 'bell' ? .28 : .13));
    model.scale.setScalar((player ? 32 : 23) * (kind === 'bell' ? 1.12 : 1) * pop);
    this.materials[side].forEach(material => { material.opacity = reducedMotion ? 1 : opacity; });
  }

  dispose(): void {
    this.source.dispose();
    [...this.materials.player, ...this.materials.rival].forEach(material => material.dispose());
    this.group.clear();
  }
}
