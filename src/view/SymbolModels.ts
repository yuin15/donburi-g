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
  const gold = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: .82, roughness: .25, envMap: environment, envMapIntensity: 1.5 });
  const fruit = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: .02, roughness: .24, clearcoat: 1, clearcoatRoughness: .16, envMap: environment, envMapIntensity: 1.2 });
  const plant = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: .04, roughness: .43, envMap: environment, envMapIntensity: 1.1 });
  const enamel = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: .03, roughness: .2, clearcoat: .8, clearcoatRoughness: .17, envMap: environment, envMapIntensity: .7 });
  const palette: Record<string, number> = {
    bell_gold: 0xd39a38, bell_trim: 0xffd674, bell_inner: 0x7b4b13,
    cherry_fruit: 0xb90725, cherry_stem: 0x645226, cherry_leaf: 0x245c1c, cherry_vein: 0x70902e,
    seven_gold: 0xf0c477, seven_border: 0x624328, seven_enamel: 0xc0061f,
  };
  const geometries: THREE.BufferGeometry[] = [];
  const build = (source: string, kind: WinSymbol) => {
    const model = new THREE.Group();
    model.name = 'houdini-' + kind;
    const buckets = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>();
    new OBJLoader().parse(source).traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      const geometry = node.geometry as THREE.BufferGeometry;
      const color = new THREE.Color(palette[node.name] ?? 0xffffff);
      const values = new Float32Array(geometry.getAttribute('position').count * 3);
      for (let i = 0; i < values.length; i += 3) color.toArray(values, i);
      geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
      const material = kind === 'bell' || ['seven_gold', 'seven_border'].includes(node.name) ? gold : kind === 'seven' ? enamel : node.name === 'cherry_fruit' ? fruit : plant;
      const bucket = buckets.get(material) ?? [];
      bucket.push(geometry);
      buckets.set(material, bucket);
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
    return model;
  };
  return {
    bell: build(bellSource, 'bell'), cherry: build(cherrySource, 'cherry'), seven: build(sevenSource, 'seven'),
    dispose: () => { geometries.forEach(geometry => geometry.dispose()); [gold, fruit, plant, enamel].forEach(material => material.dispose()); },
  };
}
