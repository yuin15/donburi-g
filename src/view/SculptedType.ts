import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import displayFont from './assets/slotchan-display.typeface.json';

const font = new FontLoader().parse(displayFont);

/** Bevels, gold faces and deep lacquer sides lit by the same lights as the cabinet. */
export class SculptedType {
  private readonly geometries = new Map<string, TextGeometry>();
  private readonly face: THREE.MeshStandardMaterial;
  private readonly side: THREE.MeshStandardMaterial;

  constructor(environment: THREE.Texture, color = 0xf3ce78) {
    this.face = new THREE.MeshStandardMaterial({ color, metalness: .76, roughness: .24, envMap: environment, envMapIntensity: 1.1 });
    this.side = new THREE.MeshStandardMaterial({ color: 0x63191b, metalness: .6, roughness: .3, envMap: environment, envMapIntensity: .8 });
  }

  make(text: string, height: number, maxWidth: number, depth = 12, bevel = .022): THREE.Mesh<TextGeometry, THREE.Material[]> {
    const key = `${text}|${height}|${maxWidth}|${depth}|${bevel}`;
    let geometry = this.geometries.get(key);
    if (!geometry) {
      geometry = new TextGeometry(text, { font, size: height, depth, curveSegments: 5, bevelEnabled: true, bevelThickness: height * bevel * (.026 / .022), bevelSize: height * bevel, bevelSegments: 3, steps: 1 });
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox!;
      const scale = Math.min(1, maxWidth / (bounds.max.x - bounds.min.x));
      geometry.translate(-(bounds.min.x + bounds.max.x) / 2, -(bounds.min.y + bounds.max.y) / 2, -depth / 2);
      geometry.scale(scale, scale, 1);
      this.geometries.set(key, geometry);
    }
    const mesh = new THREE.Mesh(geometry, [this.face, this.side]);
    mesh.name = 'sculpted-' + text;
    mesh.castShadow = true;
    return mesh;
  }

  dispose(): void {
    this.geometries.forEach(geometry => geometry.dispose());
    this.face.dispose(); this.side.dispose();
  }
}
