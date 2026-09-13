import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MINI_RECTS, PORTRAIT, REEL_RECTS, STAGE_HEIGHT, type Rect } from './StageLayout';

function rounded(path: THREE.Path, w: number, h: number, r: number): void {
  const x = -w / 2, y = -h / 2;
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y); path.quadraticCurveTo(x + w, y, x + w, y + r);
  path.lineTo(x + w, y + h - r); path.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  path.lineTo(x + r, y + h); path.quadraticCurveTo(x, y + h, x, y + h - r);
  path.lineTo(x, y + r); path.quadraticCurveTo(x, y, x + r, y);
}

/** Physical frames and reel wells replace the frames painted in the old backdrop. */
export class CasinoStage {
  readonly group = new THREE.Group();
  readonly playerGroup = new THREE.Group();
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[];

  constructor(environment: THREE.Texture) {
    const gold = new THREE.MeshStandardMaterial({ color: 0xad7630, metalness: .88, roughness: .27, envMap: environment, envMapIntensity: .95 });
    const edge = new THREE.MeshStandardMaterial({ color: 0xcfad72, metalness: .92, roughness: .22, envMap: environment, envMapIntensity: 1.1 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x090b11, metalness: .25, roughness: .38, envMap: environment, envMapIntensity: .3 });
    const silver = new THREE.MeshStandardMaterial({ color: 0x7792a8, metalness: .85, roughness: .27, envMap: environment, envMapIntensity: .8 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0xffd68c, emissive: 0xffb745, emissiveIntensity: 2, metalness: .1, roughness: .3 });
    this.materials = [gold, edge, dark, silver, lamp];
    const pieces = new Map<string, { material: THREE.Material; root: THREE.Group; geometries: THREE.BufferGeometry[] }>();
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
      if (geometry.index) { const source = geometry; geometry = source.toNonIndexed(); source.dispose(); }
      geometry.translate(x, STAGE_HEIGHT - y, z);
      const root = x < 900 && y > 150 ? this.playerGroup : this.group;
      const key = material.uuid + root.uuid;
      const bucket = pieces.get(key) ?? { material, root, geometries: [] };
      bucket.geometries.push(geometry); pieces.set(key, bucket);
    };
    const ring = (rect: Rect, border: number, depth: number, radius: number, material: THREE.Material, z: number) => {
      const shape = new THREE.Shape(), hole = new THREE.Path();
      rounded(shape, rect.w, rect.h, radius);
      rounded(hole, rect.w - border * 2, rect.h - border * 2, Math.max(1, radius - border));
      shape.holes.push(hole);
      add(new THREE.ExtrudeGeometry(shape, { depth, steps: 1, bevelEnabled: true, bevelSegments: 3, bevelSize: 1, bevelThickness: 1, curveSegments: 5 }), material, rect.x + rect.w / 2, rect.y + rect.h / 2, z);
    };
    const surround = (rect: Rect) => {
      const { x, y, w, h } = rect;
      add(new RoundedBoxGeometry(w + 26, h + 26, 14, 3, 12), dark, x + w / 2, y + h / 2, -8);
      ring({ x: x - 12, y: y - 12, w: w + 24, h: h + 24 }, 4, 9, 12, silver, 2);
      ring({ x: x - 3, y: y - 3, w: w + 6, h: h + 6 }, 1.2, 3, 4, silver, 8);
      for (const px of [x - 7, x + w + 7]) for (const py of [y - 7, y + h + 7]) {
        add(new THREE.SphereGeometry(2.6, 10, 6), silver, px, py, 13);
      }
    };
    surround(PORTRAIT);
    const ruby = new THREE.MeshStandardMaterial({ color: 0x280812, metalness: .55, roughness: .28, envMap: environment, envMapIntensity: .4 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x061528, metalness: .55, roughness: .28, envMap: environment, envMapIntensity: .4 });
    this.materials.push(ruby, blue);
    for (const [rect, material] of [
      [{ x: 56, y: 22, w: 649, h: 108 }, ruby],
      [{ x: 966, y: 22, w: 649, h: 108 }, blue],
      [{ x: 725, y: 22, w: 222, h: 108 }, dark],
    ] as const) {
      add(new RoundedBoxGeometry(rect.w, rect.h, 17, 3, 17), material, rect.x + rect.w / 2, 76, 18);
      ring(rect, 4, 10, 17, gold, 26);
      ring({ x: rect.x + 7, y: rect.y + 7, w: rect.w - 14, h: rect.h - 14 }, 1, 2, 11, edge, 30);
      for (const x of [rect.x + 16, rect.x + rect.w - 16]) for (const y of [38, 114]) {
        add(new THREE.SphereGeometry(2.2, 8, 6), edge, x, y, 34);
      }
    }
    const first = MINI_RECTS[0], last = MINI_RECTS[2];
    surround({ x: first.x - 5, y: first.y - 5, w: last.x + last.w - first.x + 10, h: first.h + 10 });
    // The recessed well and separators are part of the game geometry.
    add(new RoundedBoxGeometry(572, 381, 12, 3, 10), dark, 528, 458.5, -10);
    for (let i = 0; i < 2; i++) {
      const x = (REEL_RECTS[i].x + REEL_RECTS[i].w + REEL_RECTS[i + 1].x) / 2;
      add(new RoundedBoxGeometry(7, 373, 14, 3, 3), gold, x, 458.5, 18);
      add(new RoundedBoxGeometry(1.5, 365, 2, 2, .5), edge, x - 1.4, 458.5, 25);
      const miniX = (MINI_RECTS[i].x + MINI_RECTS[i].w + MINI_RECTS[i + 1].x) / 2;
      add(new RoundedBoxGeometry(4, 90, 8, 2, 1.5), gold, miniX, first.y + first.h / 2, 8);
    }
    for (const x of [240, 817]) {
      const arrow = new THREE.Shape();
      const side = x < 500 ? 1 : -1;
      arrow.moveTo(-side * 4, -7); arrow.lineTo(side * 5, 0); arrow.lineTo(-side * 4, 7); arrow.closePath();
      add(new THREE.ExtrudeGeometry(arrow, { depth: 2, bevelEnabled: true, bevelSize: .6, bevelThickness: .6, bevelSegments: 2 }), edge, x, 458.5, 69);
    }
    const glass = new THREE.MeshPhysicalMaterial({color:0xffdeb0,transparent:true,opacity:.18,metalness:.1,roughness:.12,clearcoat:1,envMap:environment,envMapIntensity:1.6,depthWrite:false});
    this.materials.push(glass);
    for (const x of [205, 852]) {
      add(new THREE.CylinderGeometry(10, 10, 240, 32), lamp, x, 461, 66);
      add(new THREE.CylinderGeometry(21, 21, 238, 32, 1, true), glass, x, 461, 64);
      for (const y of [337, 345, 577, 585]) add(new THREE.CylinderGeometry(24,24,8,40), gold, x, y, 64);
      for (const dx of [-13,13]) add(new THREE.CylinderGeometry(1.4,1.4,235,8), edge, x+dx,461,82);
    }
    pieces.forEach(({ geometries, material, root }) => {
      const geometry = mergeGeometries(geometries, false);
      geometries.forEach(piece => piece.dispose());
      if (!geometry) throw new Error('Stage frame geometry could not be combined.');
      this.geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = material !== lamp; mesh.receiveShadow = material !== lamp;
      root.add(mesh);
    });
    const glowMaterial = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'varying vec2 vUv;void main(){vec2 p=abs(vUv-.5)*2.;float a=exp(-p.x*p.x*7.)*pow(max(0.,1.-p.y*p.y),1.4);gl_FragColor=vec4(1.,.47,.12,a*.34);}',
    });
    const glowGeometry = new THREE.PlaneGeometry(103, 298);
    for (const x of [205, 852]) {
      const glow = new THREE.Mesh(glowGeometry, glowMaterial);
      glow.position.set(x, STAGE_HEIGHT - 461, 92); this.playerGroup.add(glow);
    }
    this.materials.push(glowMaterial); this.geometries.push(glowGeometry);
    const shadowMaterial = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'varying vec2 vUv;void main(){vec2 p=(vUv-.5)*2.;float a=pow(max(0.,1.-p.x*p.x),.6)*exp(-p.y*p.y*7.);gl_FragColor=vec4(.004,.003,.008,a*.7);}',
    });
    const shadowGeometry = new THREE.PlaneGeometry(1020, 115);
    const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
    shadow.position.set(523, STAGE_HEIGHT - 896, -370);
    this.group.add(shadow);
    this.geometries.push(shadowGeometry); this.materials.push(shadowMaterial);
    this.group.name = 'casino-stage-frames';
  }

  dispose(): void {
    this.geometries.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose());
    this.group.clear();
    this.playerGroup.clear();
  }
}
