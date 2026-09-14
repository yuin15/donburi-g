import * as THREE from 'three';

const SIZE = 512;
let enamelPixels: Uint8Array | undefined;
let stonePixels: Uint8Array | undefined;
type Finish = 'metal' | 'enamel' | 'stone';
const detailPixels = new Map<Finish, { roughness: Uint8Array; normal: Uint8Array }>();

/** Linear, tileable surface maps. Color and reflected light stay independent. */
export function createFinishDetails(kind: Finish): { roughness: THREE.DataTexture; normal: THREE.DataTexture; dispose: () => void } {
  const size = 256;
  let pixels = detailPixels.get(kind);
  if (!pixels) {
    const height = new Float32Array(size * size);
    const roughness = new Uint8Array(size * size * 4);
    const normal = new Uint8Array(size * size * 4);
    const hash = (x: number, y: number) => {
      let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
      n = Math.imul(n ^ n >>> 13, 1274126177);
      return ((n ^ n >>> 16) >>> 0) / 4294967295;
    };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const grain = hash(x, y);
      const brush = .5 + .5 * Math.sin(y / size * Math.PI * 2 * 47);
      const flake = Math.max(0, (hash(x >> 1, y >> 1) - .94) / .06);
      const surface = kind === 'metal' ? .64 + brush * .2 + grain * .08
        : kind === 'enamel' ? .67 + grain * .13 - flake * .24 : .78 + grain * .12;
      height[y * size + x] = kind === 'metal' ? brush * .24 + grain * .04
        : kind === 'enamel' ? grain * .035 + flake * .13 : grain * .015;
      const i = (y * size + x) * 4;
      roughness[i] = roughness[i + 1] = roughness[i + 2] = Math.round(surface * 255);
      roughness[i + 3] = 255;
    }
    const at = (x: number, y: number) => height[((y + size) % size) * size + (x + size) % size];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const nx = (at(x - 1, y) - at(x + 1, y)) * 2;
      const ny = (at(x, y - 1) - at(x, y + 1)) * 2;
      const length = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      normal[i] = Math.round((nx / length * .5 + .5) * 255);
      normal[i + 1] = Math.round((ny / length * .5 + .5) * 255);
      normal[i + 2] = Math.round((1 / length * .5 + .5) * 255);
      normal[i + 3] = 255;
    }
    pixels = { roughness, normal };
    detailPixels.set(kind, pixels);
  }
  const make = (data: Uint8Array) => {
    const texture = new THREE.DataTexture(data.slice(), size, size);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  };
  const roughness = make(pixels.roughness), normal = make(pixels.normal);
  return { roughness, normal, dispose: () => { roughness.dispose(); normal.dispose(); } };
}

/** Deterministic material color, not a photograph of a cabinet or a symbol. */
export function createEnamelTexture(stone = false): THREE.DataTexture {
  // Cabinet and symbols use the same pattern. Cache only CPU pixels; every
  // owner still receives its own texture and can dispose it independently.
  if (!enamelPixels || !stonePixels) generateFinishes();
  const data = (stone ? stonePixels! : enamelPixels!).slice();
  const texture = new THREE.DataTexture(data, SIZE, SIZE);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}

function generateFinishes(): void {
  const size = SIZE, enamel = new Uint8Array(size * size * 4), stone = new Uint8Array(size * size * 4);
  const hash = (x: number, y: number) => {
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
    n = Math.imul(n ^ n >>> 13, 1274126177);
    return ((n ^ n >>> 16) >>> 0) / 4294967295;
  };
  const noise = (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    let u = x - ix, v = y - iy;
    u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
    return THREE.MathUtils.lerp(THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), u),
      THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), u), v);
  };
  const fbm = (x: number, y: number) => noise(x, y) * .55 + noise(x * 2, y * 2) * .27 + noise(x * 4, y * 4) * .13 + noise(x * 8, y * 8) * .05;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size * 9, v = y / size * 9;
    const cloud = fbm(u + fbm(u, v) * 4, v + fbm(v + 12, u) * 4);
    const grain = hash(x, y);
    const vein = Math.pow(1 - Math.abs(Math.sin(u * 1.7 + v * .8 + cloud * 22)), 22);
    const t = THREE.MathUtils.clamp(cloud * .85 + grain * .15, 0, 1);
    const i = (y * size + x) * 4;
    stone[i] = 3 + t * 19 + vein * 94;
    stone[i + 1] = 14 + t * 43 + vein * 101;
    stone[i + 2] = 11 + t * 31 + vein * 76;
    const flake = grain > .98 ? (grain - .98) * 900 : 0;
    enamel[i] = 103 + Math.pow(t, 1.1) * 142 + flake;
    enamel[i + 1] = 2 + t * 9 + flake * .6;
    enamel[i + 2] = 7 + t * 18 + flake * .5;
    enamel[i + 3] = stone[i + 3] = 255;
  }
  enamelPixels = enamel;
  stonePixels = stone;
}
