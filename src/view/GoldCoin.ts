import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import coinSource from '../../art-source/houdini/exports/slot-chan-coin.obj?raw';

/** One Houdini mesh is shared by every coin. No model download during a win. */
export function createGoldCoinGeometry(): THREE.BufferGeometry {
  const source = new OBJLoader().parse(coinSource);
  const pieces: THREE.BufferGeometry[] = [];
  source.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    const geometry = node.geometry as THREE.BufferGeometry;
    const color = new THREE.Color(node.name.includes('seven') ? 0xffdd81
      : node.name.includes('rim') ? 0xffc65b
        : node.name.includes('reeds') ? 0xeab146 : 0xc98b2d);
    const values = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let i = 0; i < values.length; i += 3) color.toArray(values, i);
    geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
    pieces.push(geometry);
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach(material => material.dispose());
  });
  const geometry = mergeGeometries(pieces, false);
  pieces.forEach(piece => piece.dispose());
  if (!geometry) throw new Error('The exported coin must contain compatible mesh geometry.');
  geometry.scale(22, 22, 22);
  geometry.computeBoundingSphere();
  return geometry;
}

export function createGoldCoinMaterial(environment: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true, metalness: .86, roughness: .27,
    envMap: environment, envMapIntensity: 1.6, transparent: true,
  });
}

/** Small studio light map: soft white panels, a cool rim and a dark lower fill. */
export function createGoldCoinEnvironment(): THREE.DataTexture {
  const width = 128, height = 64;
  const pixels = new Float32Array(width * height * 4);
  const panel = (u: number, v: number, x: number, y: number, w: number, h: number) => {
    const dx = Math.min(Math.abs(u - x), 1 - Math.abs(u - x));
    return Math.exp(-((dx / w) ** 6 + ((v - y) / h) ** 6));
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width, v = y / height;
      const fill = .035 + Math.sin(v * Math.PI) * .07;
      const key = panel(u, v, .12, .48, .06, .31) * 3.2;
      const rim = panel(u, v, .62, .45, .027, .36) * 2.5;
      const top = panel(u, v, .83, .81, .19, .045) * 1.8;
      const i = (y * width + x) * 4;
      pixels[i] = fill + key + rim * .7 + top;
      pixels[i + 1] = fill + key * .94 + rim * .87 + top * .82;
      pixels[i + 2] = fill + key * .84 + rim + top * .55;
      pixels[i + 3] = 1;
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
