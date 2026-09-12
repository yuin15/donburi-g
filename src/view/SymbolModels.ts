import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import bellSource from '../../art-source/houdini/exports/slot-chan-bell.obj?raw';
import cherrySource from '../../art-source/houdini/exports/slot-chan-cherry.obj?raw';
import sevenSource from '../../art-source/houdini/exports/slot-chan-seven.obj?raw';

export type WinSymbol = 'bell' | 'cherry' | 'seven';
export type SymbolModels = Record<WinSymbol, THREE.Group> & { dispose: () => void };

/** Reusable, unit-size Houdini meshes. Materials share the coin's light map. */
export function createSymbolModels(environment: THREE.Texture): SymbolModels {
  const gold = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: .72, roughness: .3, envMap: environment, envMapIntensity: .75 });
  const fruit = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0, roughness: .31, clearcoat: .55, clearcoatRoughness: .23, envMap: environment, envMapIntensity: .45 });
  const plant = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: .48, envMap: environment, envMapIntensity: .45 });
  const enamel = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: .02, roughness: .3, clearcoat: .18, clearcoatRoughness: .19, envMap: environment, envMapIntensity: .25 });
  const chrome = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: .92, roughness: .2, envMap: environment, envMapIntensity: 1.2 });
  const outline = new THREE.MeshBasicMaterial({ color: 0x271a0e, side: THREE.BackSide });
  const palette: Record<string, number> = {
    bell_gold: 0xc69542, bell_trim: 0xe9bd63, bell_inner: 0x452304, bell_ridge: 0x684015,
    cherry_fruit: 0xb5071c, cherry_stem: 0x53621b, cherry_leaf: 0x205d20, cherry_vein: 0x8a9e45, cherry_gold: 0xedba54,
    seven_gold: 0xe6b745, seven_border: 0x1b0e08, seven_enamel: 0x9c0410, seven_chrome: 0xe7e9e1,
  };
  const geometries: THREE.BufferGeometry[] = [];
  const build = (source: string, kind: WinSymbol) => {
    const model = new THREE.Group();
    model.name = 'houdini-' + kind;
    const buckets = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>();
    const silhouette: THREE.BufferGeometry[] = [];
    new OBJLoader().parse(source).traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      const geometry = node.geometry as THREE.BufferGeometry;
      const color = new THREE.Color(palette[node.name] ?? 0xffffff);
      const values = new Float32Array(geometry.getAttribute('position').count * 3);
      const positions = geometry.getAttribute('position');
      for (let i = 0; i < values.length; i += 3) {
        const shade = node.name === 'cherry_fruit' ? .62 + .38 * THREE.MathUtils.smoothstep(positions.getY(i / 3), -.96, .12)
          : node.name === 'seven_enamel' ? .65 + .35 * THREE.MathUtils.smoothstep(positions.getY(i / 3), -1.1, 1.1) : 1;
        values[i] = color.r * shade; values[i + 1] = color.g * shade; values[i + 2] = color.b * shade;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
      const material = node.name === 'seven_chrome' ? chrome : kind === 'bell' || ['seven_gold', 'seven_border', 'cherry_gold'].includes(node.name) ? gold : kind === 'seven' ? enamel : node.name === 'cherry_fruit' ? fruit : plant;
      const bucket = buckets.get(material) ?? [];
      bucket.push(geometry);
      buckets.set(material, bucket);
      const hull = geometry.clone();
      const hullPosition = hull.getAttribute('position'), normal = hull.getAttribute('normal');
      for (let i = 0; i < hullPosition.count; i++) {
        hullPosition.setXYZ(i, hullPosition.getX(i) + normal.getX(i) * .022, hullPosition.getY(i) + normal.getY(i) * .022, hullPosition.getZ(i) + normal.getZ(i) * .022);
      }
      silhouette.push(hull);
      (Array.isArray(node.material) ? node.material : [node.material]).forEach(value => value.dispose());
    });
    buckets.forEach((pieces, material) => {
      const geometry = mergeGeometries(pieces, false);
      pieces.forEach(piece => piece.dispose());
      if (!geometry) throw new Error('The exported symbol must contain compatible mesh geometry.');
      geometry.computeBoundingSphere();
      geometries.push(geometry);
      model.add(new THREE.Mesh(geometry, material));
    });
    const contour = mergeGeometries(silhouette, false);
    silhouette.forEach(piece => piece.dispose());
    if (!contour) throw new Error('The symbol silhouette could not be combined.');
    contour.computeBoundingSphere(); geometries.push(contour);
    const ink = new THREE.Mesh(contour, outline);
    ink.name = 'symbol-contour'; model.add(ink);
    return model;
  };
  return {
    bell: build(bellSource, 'bell'), cherry: build(cherrySource, 'cherry'), seven: build(sevenSource, 'seven'),
    dispose: () => { geometries.forEach(geometry => geometry.dispose()); [gold, fruit, plant, enamel, chrome, outline].forEach(material => material.dispose()); },
  };
}
