import * as THREE from 'three';
import type { SymbolModels } from './SymbolModels';

/** Print the same sculpted symbols onto the reel strip once at scene startup. */
export function createSymbolAtlas(renderer: THREE.WebGLRenderer, models: SymbolModels): THREE.WebGLRenderTarget {
  const size = 512;
  const target = new THREE.WebGLRenderTarget(size * 3, size, {
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: true,
  });
  target.texture.colorSpace = THREE.LinearSRGBColorSpace;
  target.texture.name = 'houdini-reel-symbols';
  const previous = {
    target: renderer.getRenderTarget(), viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()), scissorTest: renderer.getScissorTest(),
    clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(),
    shadows: renderer.shadowMap.enabled, shadowType: renderer.shadowMap.type,
  };
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1.20, 1.20, 1.20, -1.20, .1, 15);
  camera.position.z = 6;
  const light = new THREE.DirectionalLight(0xfff3dd, 2.8);
  light.position.set(-3, 4, 8);
  light.castShadow = true;
  light.shadow.mapSize.set(512, 512);
  Object.assign(light.shadow.camera, { left: -1.5, right: 1.5, top: 1.5, bottom: -1.5, near: .1, far: 18 });
  light.shadow.bias = -.0008;
  light.shadow.normalBias = .005;
  light.shadow.radius = 3;
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshBasicMaterial({ color: 0xffe2ac }));
  paper.position.z = -.58;
  scene.add(paper, light, new THREE.AmbientLight(0xe7edff, .3));
  try {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setRenderTarget(target);
    renderer.setScissorTest(true);
    renderer.setClearColor(0xffeed2, 1);
    (['cherry', 'bell', 'seven'] as const).forEach((kind, index) => {
      const symbol = models[kind].clone(true);
      symbol.rotation.set(kind === 'bell' ? -.18 : -.025, -.10, kind === 'seven' ? -.055 : 0);
      symbol.position.y = kind === 'bell' ? -.035 : -.02;
      symbol.scale.setScalar(kind === 'bell' ? 1.10 : .99);
      symbol.traverse(node => { if (node instanceof THREE.Mesh) { node.castShadow = true; node.receiveShadow = true; } });
      scene.add(symbol);
      // Shadow rendering restores the render target's own viewport/scissor.
      target.viewport.set(index * size, 0, size, size);
      target.scissor.copy(target.viewport);
      target.scissorTest = true;
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      scene.remove(symbol);
    });
  } catch (error) {
    target.dispose();
    throw error;
  } finally {
    renderer.setRenderTarget(previous.target);
    renderer.setViewport(previous.viewport);
    renderer.setScissor(previous.scissor);
    renderer.setScissorTest(previous.scissorTest);
    renderer.setClearColor(previous.clear, previous.alpha);
    renderer.shadowMap.enabled = previous.shadows;
    renderer.shadowMap.type = previous.shadowType;
    light.shadow.dispose();
    paper.geometry.dispose();
    paper.material.dispose();
    scene.clear();
  }
  return target;
}
