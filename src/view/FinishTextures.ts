import * as THREE from 'three';

/** Deterministic material color, not a photograph of a cabinet or a symbol. */
export function createEnamelTexture(stone = false): THREE.DataTexture {
  const size = 512, data = new Uint8Array(size * size * 4);
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
    if (stone) {
      data[i] = 3 + t * 19 + vein * 94;
      data[i + 1] = 14 + t * 43 + vein * 101;
      data[i + 2] = 11 + t * 31 + vein * 76;
    } else {
      const flake = grain > .96 ? (grain - .96) * 170 : 0;
      data[i] = 94 + Math.pow(t, 1.1) * 151 + flake;
      data[i + 1] = 2 + t * 9 + flake * .6;
      data[i + 2] = 7 + t * 18 + flake * .5;
    }
    data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}
