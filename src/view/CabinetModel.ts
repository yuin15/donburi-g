import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createEnamelTexture } from './FinishTextures';
import source from '../../art-source/houdini/exports/slot-chan-cabinet.obj?raw';

/** Fine, repeatable machining marks; all faces use the same material map. */
function brushedFinish(): THREE.DataTexture {
  const size = 128, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const grain = ((y * 1664525 + 1013904223) >>> 8) % 31;
    for (let x = 0; x < size; x++) {
      const n = 198 + grain + ((x * 13 + y * 7) % 9);
      const i = (y * size + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = n;
      pixels[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Houdini's complete shell, including its back and optional blank reel drums. */
export class CabinetModel {
  readonly group = new THREE.Group();
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.MeshStandardMaterial[];
  private button: THREE.Mesh | null = null;
  private pressedAt = -Infinity;
  private grain = brushedFinish();
  private enamel = createEnamelTexture();
  private stone = createEnamelTexture(true);
  private viewSlope: number;

  constructor(environment: THREE.Texture, options: { reels?: boolean; viewSlope?: number } = {}) {
    this.viewSlope = options.viewSlope ?? 0;
    const presentation = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, -this.viewSlope, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    const gold = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: .88, roughness: .3, roughnessMap: this.grain, bumpMap: this.grain, bumpScale: .0014, envMap: environment, envMapIntensity: 1.0 });
    const lacquer = new THREE.MeshPhysicalMaterial({ vertexColors: true, map: this.enamel, metalness: .15, roughness: .28, clearcoat: 1, clearcoatRoughness: .12, envMap: environment, envMapIntensity: .8 });
    const marble = new THREE.MeshPhysicalMaterial({ map: this.stone, metalness: .05, roughness: .3, clearcoat: .75, clearcoatRoughness: .14, envMap: environment, envMapIntensity: .7 });
    const black = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: .2, roughness: .28, clearcoat: .5, clearcoatRoughness: .3, envMap: environment, envMapIntensity: .65 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dfeb, metalness: .96, roughness: .17, envMap: environment, envMapIntensity: 1.4 });
    const ruby = new THREE.MeshPhysicalMaterial({ vertexColors: true, map: this.enamel, metalness: .1, roughness: .20, clearcoat: 1, clearcoatRoughness: .12, envMap: environment, envMapIntensity: .7 });
    const ivory = new THREE.MeshStandardMaterial({ color: 0xffedcb, metalness: 0, roughness: .46 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0xffeec9, emissive: 0xffbb44, emissiveIntensity: 2, roughness: .3 });
    this.materials = [gold, lacquer, black, chrome, ruby, ivory, lamp, marble];
    const palette: Record<string, number> = {
      cabinet_gold: 0xb5823b, cabinet_highlight: 0xe7c488, cabinet_shadow: 0x41280e,
      cabinet_engraving: 0x735328, cabinet_body: 0x6d4d49, cabinet_lacquer: 0xffe9e0,
      cabinet_black: 0x08090e, cabinet_back: 0x121016, cabinet_vent: 0x24232a,
      cabinet_button: 0xffdddd, cabinet_spin_button: 0xffd6db, cabinet_ruby: 0xffe0e5,
    };
    const buckets = new Map<string, { material: THREE.MeshStandardMaterial; pieces: THREE.BufferGeometry[] }>();
    new OBJLoader().parse(source).traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      const geometry = node.geometry as THREE.BufferGeometry;
      const isReel = node.name.startsWith('cabinet_reel');
      (Array.isArray(node.material) ? node.material : [node.material]).forEach(value => value.dispose());
      if (isReel && options.reels === false) { geometry.dispose(); return; }
      // Elevate the game view without distorting the printed reel columns.
      geometry.applyMatrix4(presentation);
      // The distant upper shell has a shallower roof. Keep the arched front
      // silhouette visible instead of projecting a large blank wedge above it.
      const displayed = geometry.getAttribute('position');
      const displayedNormals = geometry.getAttribute('normal');
      for (let i = 0; i < displayed.count; i++) if (displayed.getZ(i) < 0) {
        displayed.setY(i, displayed.getY(i) + displayed.getZ(i) * this.viewSlope * .70);
        const n = new THREE.Vector3(displayedNormals.getX(i), displayedNormals.getY(i), displayedNormals.getZ(i) - displayedNormals.getY(i) * this.viewSlope * .70).normalize();
        displayedNormals.setXYZ(i,n.x,n.y,n.z);
      }
      const color = new THREE.Color(palette[node.name] ?? 0xffffff);
      const positions = geometry.getAttribute('position');
      const normals = geometry.getAttribute('normal');
      const colors = new Float32Array(positions.count * 3);
      const uv = new Float32Array(positions.count * 2);
      for (let i = 0; i < positions.count; i++) {
        const patina = node.name === 'cabinet_gold' ? .85 + .15 * Math.sin(positions.getY(i) * 2.8 + positions.getX(i) * 1.3) ** 2 : 1;
        colors[i * 3] = color.r * patina; colors[i * 3 + 1] = color.g * patina; colors[i * 3 + 2] = color.b * patina;
        const nx = Math.abs(normals.getX(i)), ny = Math.abs(normals.getY(i)), nz = Math.abs(normals.getZ(i));
        uv[i * 2] = (nx > nz ? positions.getZ(i) : positions.getX(i)) * .42;
        uv[i * 2 + 1] = (ny > nz && ny > nx ? positions.getZ(i) : positions.getY(i)) * .42;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      const material = isReel ? ivory : node.name === 'cabinet_lamp' ? lamp : node.name === 'cabinet_chrome' ? chrome
        : node.name === 'cabinet_marble' ? marble : node.name.includes('button') || node.name === 'cabinet_ruby' ? ruby : ['cabinet_body', 'cabinet_lacquer'].includes(node.name) ? lacquer
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
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.name = key === 'spin-button' ? 'cabinet-spin-button' : 'cabinet-finish-' + key;
      if (key === 'spin-button') this.button = mesh;
      this.group.add(mesh);
    });
    const glassGeometry = new THREE.PlaneGeometry(5.72, 3.75);
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xd4e3ec, roughness: .10, metalness: .05, transparent: true, opacity: .025, depthWrite: false, envMap: environment, envMapIntensity: .3 });
    const window = new THREE.Mesh(glassGeometry, glass);
    window.name = 'cabinet-glass';
    window.position.set(-.02, 4.195 - .51 * this.viewSlope, .51);
    this.group.add(window);
    this.geometries.push(glassGeometry);
    this.materials.push(glass);
    this.group.name = 'houdini-slot-cabinet';
  }

  press(now: number): void { this.pressedAt = now; }

  update(now: number, reducedMotion: boolean): boolean {
    const elapsed = now - this.pressedAt;
    const pressing = !reducedMotion && elapsed >= 0 && elapsed < 180;
    if (this.button) {
      this.button.position.z = pressing ? -Math.sin(elapsed / 180 * Math.PI) * .045 : 0;
      this.button.position.y = -this.button.position.z * this.viewSlope;
    }
    return pressing;
  }

  dispose(): void {
    this.geometries.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose());
    this.grain.dispose();
    this.enamel.dispose(); this.stone.dispose();
    this.group.clear();
  }
}
