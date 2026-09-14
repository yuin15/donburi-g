import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createEnamelTexture, createFinishDetails } from './FinishTextures';
import source from '../../art-source/houdini/exports/slot-chan-cabinet.obj?raw';

/** Houdini's complete shell, including its back and optional blank reel drums. */
export class CabinetModel {
  readonly group = new THREE.Group();
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.MeshStandardMaterial[];
  private button: THREE.Mesh | null = null;
  private lever = new THREE.Group();
  private sweepPosition = { value: -10 };
  private sweepStrength = { value: 0 };
  private pressedAt = -Infinity;
  private metalDetail = createFinishDetails('metal');
  private paintDetail = createFinishDetails('enamel');
  private stoneDetail = createFinishDetails('stone');
  private enamel = createEnamelTexture();
  private stone = createEnamelTexture(true);
  private viewSlope: number;

  constructor(environment: THREE.Texture, options: { reels?: boolean; viewSlope?: number } = {}) {
    this.viewSlope = options.viewSlope ?? 0;
    const presentation = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, -this.viewSlope, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    const gold = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: .96, roughness: .20,
      roughnessMap: this.metalDetail.roughness, normalMap: this.metalDetail.normal, normalScale: new THREE.Vector2(.16, .16),
      clearcoat: .25, clearcoatRoughness: .06, envMap: environment, envMapIntensity: 1.3 });
    // A thin travelling glint is confined to gold, not painted across the reels.
    gold.onBeforeCompile = shader => {
      shader.uniforms.frameSweepPosition = this.sweepPosition;
      shader.uniforms.frameSweepStrength = this.sweepStrength;
      shader.vertexShader = 'varying vec3 vFinishPosition;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFinishPosition = position;');
      shader.fragmentShader = 'varying vec3 vFinishPosition;\nuniform float frameSweepPosition;\nuniform float frameSweepStrength;\n' + shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float band = exp(-pow((vFinishPosition.x + vFinishPosition.y * .65 - frameSweepPosition) / .10, 2.));
        float edge = .18 + .82 * pow(1. - abs(normal.z), .7);
        totalEmissiveRadiance += vec3(1., .83, .48) * band * edge * frameSweepStrength;`);
    };
    gold.customProgramCacheKey = () => 'cabinet-gold-sweep-v1';
    const lacquer = new THREE.MeshPhysicalMaterial({ vertexColors: true, map: this.enamel, metalness: .22, roughness: .22,
      roughnessMap: this.paintDetail.roughness, normalMap: this.paintDetail.normal, normalScale: new THREE.Vector2(.16, .16),
      clearcoat: 1, clearcoatRoughness: .055, envMap: environment, envMapIntensity: .95 });
    const marble = new THREE.MeshPhysicalMaterial({ map: this.stone, metalness: .03, roughness: .18,
      roughnessMap: this.stoneDetail.roughness, clearcoat: 1, clearcoatRoughness: .075, envMap: environment, envMapIntensity: .9 });
    const black = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: .15, roughness: .19, clearcoat: 1, clearcoatRoughness: .075, envMap: environment, envMapIntensity: .95 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xe6edf8, metalness: 1, roughness: .105, envMap: environment, envMapIntensity: 1.15 });
    const ruby = new THREE.MeshPhysicalMaterial({ vertexColors: true, map: this.enamel, metalness: 0, roughness: .085, ior: 1.9,
      clearcoat: 1, clearcoatRoughness: .045, envMap: environment, envMapIntensity: 1.3 });
    const buttonPaint = lacquer.clone();
    buttonPaint.metalness = .12; buttonPaint.roughness = .16;
    const ivory = new THREE.MeshStandardMaterial({ color: 0xffedcb, metalness: 0, roughness: .46 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0xffeec9, emissive: 0xffbb44, emissiveIntensity: 2, roughness: .3 });
    this.materials = [gold, lacquer, black, chrome, ruby, ivory, lamp, marble, buttonPaint];
    const palette: Record<string, number> = {
      cabinet_gold: 0xd6a246, cabinet_highlight: 0xffdfa1, cabinet_shadow: 0x41280e,
      cabinet_engraving: 0x735328, cabinet_body: 0x6d4d49, cabinet_lacquer: 0xffe9e0,
      cabinet_black: 0x08090e, cabinet_back: 0x121016, cabinet_vent: 0x24232a,
      cabinet_button: 0xffdddd, cabinet_spin_button: 0xffd6db, cabinet_ruby: 0xffe0e5,
    };
    const buckets = new Map<string, { material: THREE.MeshStandardMaterial; pieces: THREE.BufferGeometry[] }>();
    this.lever.name = 'cabinet-lever';
    this.lever.position.set(3.55, 3.15 + .20 * this.viewSlope, -.20);
    this.group.add(this.lever);
    new OBJLoader().parse(source).traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      const geometry = node.geometry as THREE.BufferGeometry;
      const isLever = node.name.startsWith('cabinet_lever_');
      const finishName = node.name.replace('cabinet_lever_', 'cabinet_');
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
      const color = new THREE.Color(palette[finishName] ?? 0xffffff);
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
      const material = isReel ? ivory : node.name === 'cabinet_lamp' ? lamp : finishName === 'cabinet_chrome' ? chrome
        : node.name === 'cabinet_marble' ? marble : node.name.includes('button') ? buttonPaint : finishName === 'cabinet_ruby' ? ruby : ['cabinet_body', 'cabinet_lacquer'].includes(node.name) ? lacquer
            : ['cabinet_black', 'cabinet_back', 'cabinet_vent'].includes(node.name) ? black : gold;
      if (isLever) geometry.translate(-this.lever.position.x, -this.lever.position.y, -this.lever.position.z);
      const key = node.name === 'cabinet_spin_button' ? 'spin-button' : (isLever ? 'lever-' : '') + this.materials.indexOf(material);
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
      mesh.castShadow = !key.startsWith('lever-'); mesh.receiveShadow = true;
      mesh.name = key === 'spin-button' ? 'cabinet-spin-button' : 'cabinet-finish-' + key;
      if (key === 'spin-button') this.button = mesh;
      (key.startsWith('lever-') ? this.lever : this.group).add(mesh);
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
  stop(): void { this.pressedAt = -Infinity; this.update(0, true); this.setSweep(0, 0); }
  setSweep(progress: number, strength: number): void {
    this.sweepPosition.value = -2.8 + Math.min(1, progress / .85) * 11;
    this.sweepStrength.value = strength;
  }

  update(now: number, reducedMotion: boolean): boolean {
    const elapsed = now - this.pressedAt;
    const pressing = !reducedMotion && elapsed >= 0 && elapsed < 180;
    const pulling = !reducedMotion && elapsed >= 0 && elapsed < 720;
    const t = Math.max(0, elapsed / 720);
    const spring = Math.max(0, (t - .42) / .58);
    const pull = t < .32 ? 1 - (1 - t / .32) ** 3 : t < .42 ? 1 : Math.exp(-6 * spring) * (Math.cos(7 * spring) + .3 * Math.sin(7 * spring));
    this.lever.rotation.x = pulling ? pull * 1.05 : 0;
    if (this.button) {
      this.button.position.z = pressing ? -Math.sin(elapsed / 180 * Math.PI) * .045 : 0;
      this.button.position.y = -this.button.position.z * this.viewSlope;
    }
    return pressing || pulling;
  }

  dispose(): void {
    this.geometries.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose());
    this.metalDetail.dispose(); this.paintDetail.dispose(); this.stoneDetail.dispose();
    this.enamel.dispose(); this.stone.dispose();
    this.group.clear();
  }
}
