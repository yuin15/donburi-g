import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import source from '../../art-source/houdini/exports/slot-chan-cabinet.obj?raw';
import { STAGE_HEIGHT, STAGE_WIDTH } from './StageLayout';

/** Houdini's complete shell, including its back and optional blank reel drums. */
export class CabinetModel {
  readonly group = new THREE.Group();
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.MeshStandardMaterial[];
  private button: THREE.Mesh | null = null;
  private pressedAt = -Infinity;

  constructor(environment: THREE.Texture, options: { reels?: boolean; frontTexture?: THREE.Texture } = {}) {
    const gold = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: .88, roughness: .24, envMap: environment, envMapIntensity: 1.45 });
    const lacquer = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: .15, roughness: .29, clearcoat: .85, clearcoatRoughness: .20, envMap: environment, envMapIntensity: 1 });
    const inlay = new THREE.MeshPhysicalMaterial({ vertexColors: true, map: options.frontTexture, metalness: .08, roughness: .38, clearcoat: .55, envMap: environment, envMapIntensity: .7 });
    const black = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: .25, roughness: .35, envMap: environment, envMapIntensity: .55 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dfeb, metalness: .96, roughness: .17, envMap: environment, envMapIntensity: 1.4 });
    const ruby = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: .08, roughness: .21, clearcoat: 1, clearcoatRoughness: .10, envMap: environment, envMapIntensity: 1.3 });
    const ivory = new THREE.MeshStandardMaterial({ color: 0xffedcb, metalness: 0, roughness: .46 });
    this.materials = [gold, lacquer, inlay, black, chrome, ruby, ivory];
    const palette: Record<string, number> = {
      cabinet_gold: 0xc28b38, cabinet_highlight: 0xf0c567, cabinet_shadow: 0x714823,
      cabinet_body: 0x321018, cabinet_lacquer: options.frontTexture ? 0xffffff : 0x241619,
      cabinet_black: 0x080a11, cabinet_back: 0x13151b, cabinet_vent: 0x222730,
      cabinet_button: 0xb80822, cabinet_spin_button: 0xb80822,
    };
    const buckets = new Map<string, { material: THREE.MeshStandardMaterial; pieces: THREE.BufferGeometry[] }>();
    new OBJLoader().parse(source).traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      const geometry = node.geometry as THREE.BufferGeometry;
      const isReel = node.name.startsWith('cabinet_reel');
      (Array.isArray(node.material) ? node.material : [node.material]).forEach(value => value.dispose());
      if (isReel && options.reels === false) { geometry.dispose(); return; }
      const color = new THREE.Color(palette[node.name] ?? 0xffffff);
      const positions = geometry.getAttribute('position');
      const colors = new Float32Array(positions.count * 3);
      const uv = new Float32Array(positions.count * 2);
      for (let i = 0; i < positions.count; i++) {
        color.toArray(colors, i * 3);
        uv[i * 2] = (positions.getX(i) * 100 + 530) / STAGE_WIDTH;
        uv[i * 2 + 1] = (positions.getY(i) * 100 + STAGE_HEIGHT - 870) / STAGE_HEIGHT;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      const material = isReel ? ivory : node.name === 'cabinet_chrome' ? chrome
        : node.name.includes('button') ? ruby : node.name === 'cabinet_body' ? lacquer
          : node.name === 'cabinet_lacquer' ? inlay
            : ['cabinet_black', 'cabinet_back', 'cabinet_vent'].includes(node.name) ? black : gold;
      const key = node.name === 'cabinet_spin_button' ? 'spin-button' : String(this.materials.indexOf(material));
      const bucket = buckets.get(key) ?? { material, pieces: [] };
      bucket.pieces.push(geometry);
      buckets.set(key, bucket);
    });
    buckets.forEach(({ material, pieces }, key) => {
      const geometry = mergeGeometries(pieces, false);
      pieces.forEach(piece => piece.dispose());
      if (!geometry) throw new Error('The cabinet export contains incompatible geometry.');
      geometry.computeBoundingSphere();
      this.geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = key === 'spin-button' ? 'cabinet-spin-button' : 'cabinet-finish-' + key;
      if (key === 'spin-button') this.button = mesh;
      this.group.add(mesh);
    });
    this.group.name = 'houdini-slot-cabinet';
  }

  press(now: number): void { this.pressedAt = now; }

  update(now: number, reducedMotion: boolean): boolean {
    const elapsed = now - this.pressedAt;
    const pressing = !reducedMotion && elapsed >= 0 && elapsed < 180;
    if (this.button) this.button.position.z = pressing ? -Math.sin(elapsed / 180 * Math.PI) * .045 : 0;
    return pressing;
  }

  dispose(): void {
    this.geometries.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose());
    this.group.clear();
  }
}
