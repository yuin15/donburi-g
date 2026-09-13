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
    const color = new THREE.Color(node.name.includes('enamel') ? 0xb51023 : node.name.includes('border') ? 0x170907 : node.name.includes('chrome') ? 0xe2ddd1 : node.name.includes('seven') ? 0xffdd81
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
  return new THREE.MeshPhysicalMaterial({
    vertexColors: true, metalness: .96, roughness: .15,
    clearcoat: .3, clearcoatRoughness: .065,
    envMap: environment, envMapIntensity: 1.9, transparent: true,
  });
}

/** HDR strip lights: crisp white reflections, warm gold edges and dark gaps. */
export function createGoldCoinEnvironment(): THREE.DataTexture {
  const width = 512, height = 256;
  const pixels = new Float32Array(width * height * 4);
  const panel = (u: number, v: number, x: number, y: number, w: number, h: number) => {
    const dx = Math.min(Math.abs(u - x), 1 - Math.abs(u - x));
    return Math.exp(-((dx / w) ** 6 + ((v - y) / h) ** 6));
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width, v = y / height;
      const fill = .018 + Math.sin(v * Math.PI) * .035;
      const key = panel(u, v, .12, .48, .041, .30) * 4.4;
      const rim = panel(u, v, .62, .47, .012, .34) * 5.5;
      const top = panel(u, v, .83, .81, .15, .023) * 3.5;
      const window = panel(u, v, .77, .57, .023, .075) * 1.25;
      const strip = panel(u, v, .87, .49, .007, .29) * 6.5
        + panel(u, v, .34, .44, .010, .25) * 5.0;
      const lower = panel(u, v, .72, .22, .12, .016) * 2.1;
      const i = (y * width + x) * 4;
      pixels[i] = fill + key + rim * .76 + top + window + strip + lower;
      pixels[i + 1] = fill + key * .95 + rim * .90 + top * .85 + window * .96 + strip * .92 + lower * .65;
      pixels[i + 2] = fill + key * .86 + rim + top * .59 + window * .91 + strip * .77 + lower * .26;
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
