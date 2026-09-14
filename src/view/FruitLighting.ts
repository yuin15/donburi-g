import * as THREE from 'three';

/** Round softboxes, not the long strip lights used on the cabinet's metal.
 * Spherical Gaussian lobes have one bright center and a smooth falloff: no
 * bright rectangle borders or repeated bands wrapping around the fruit. */
export function createFruitEnvironment(): THREE.DataTexture {
  const width = 256, height = 128;
  const pixels = new Float32Array(width * height * 4);
  const key = new THREE.Vector3(-.7, .85, 1).normalize();
  const rim = new THREE.Vector3(-1, .25, -.55).normalize();
  const fill = new THREE.Vector3(.7, .8, -.2).normalize();
  const direction = new THREE.Vector3();
  for (let y = 0; y < height; y++) {
    const latitude = (y / (height - 1) - .5) * Math.PI;
    for (let x = 0; x < width; x++) {
      const longitude = (x / width - .5) * Math.PI * 2;
      direction.set(Math.cos(longitude) * Math.cos(latitude), Math.sin(latitude), Math.sin(longitude) * Math.cos(latitude));
      const softbox = Math.exp((direction.dot(key) - 1) / .038) * 3.2;
      const edge = Math.exp((direction.dot(rim) - 1) / .045) * 1.8;
      const room = .045 + Math.exp((direction.dot(fill) - 1) / .24) * .18;
      const i = (y * width + x) * 4;
      pixels[i] = room + softbox + edge * .9;
      pixels[i + 1] = room + softbox * .97 + edge * .96;
      pixels[i + 2] = room + softbox * .92 + edge;
      pixels[i + 3] = 1;
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.name = 'fruit-softbox-reflections';
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
