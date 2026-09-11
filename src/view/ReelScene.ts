import * as THREE from 'three';
import type { SymbolId } from '../../shared/protocol';

const GLYPH: Record<SymbolId, string> = { cherry: '🍒', bell: '🔔', seven: '7' };

export class ReelScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  private reels: THREE.Mesh[] = [];
  private labels: THREE.Sprite[] = [];
  private frame = 0;
  private spinUntil = 0;
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.append(this.renderer.domElement);
    this.camera.position.set(0, 0, 7);
    this.scene.add(new THREE.AmbientLight(0xffd9a3, 2));
    const key = new THREE.PointLight(0xffb347, 70);
    key.position.set(2, 3, 4);
    this.scene.add(key);
    for (let i = 0; i < 3; i += 1) {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.82, 0.82, 1.15, 48),
        new THREE.MeshStandardMaterial({ color: 0xf5e6c8, metalness: 0.15, roughness: 0.42 }),
      );
      mesh.rotation.z = Math.PI / 2;
      mesh.position.x = (i - 1) * 1.75;
      this.scene.add(mesh);
      this.reels.push(mesh);
      const sprite = this.makeLabel('🍒');
      sprite.position.set(mesh.position.x, 0, 1);
      this.scene.add(sprite);
      this.labels.push(sprite);
    }
    this.resize();
    addEventListener('resize', this.resize);
    this.loop();
  }

  spin(): void {
    this.spinUntil = performance.now() + (this.reducedMotion ? 120 : 520);
  }

  show(symbols: [SymbolId, SymbolId, SymbolId], payout = 0): void {
    symbols.forEach((symbol, index) => this.setLabel(this.labels[index], GLYPH[symbol]));
    this.host.dataset.win = payout > 0 ? 'true' : 'false';
    this.host.dataset.jackpot = payout >= 1200 ? 'true' : 'false';
    window.setTimeout(() => {
      this.host.dataset.win = 'false';
      this.host.dataset.jackpot = 'false';
    }, this.reducedMotion ? 250 : 900);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    removeEventListener('resize', this.resize);
    for (const reel of this.reels) {
      reel.geometry.dispose();
      const material = reel.material as THREE.Material;
      material.dispose();
    }
    for (const label of this.labels) {
      const material = label.material as THREE.SpriteMaterial;
      material.map?.dispose();
      material.dispose();
    }
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  private makeLabel(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas_context_unavailable');
    context.fillStyle = '#fff7e6';
    context.fillRect(0, 0, 256, 256);
    context.fillStyle = '#8b1118';
    context.font = 'bold 150px system-ui';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 128, 128);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));
    sprite.scale.set(1.25, 1.25, 1);
    return sprite;
  }

  private setLabel(sprite: THREE.Sprite, text: string): void {
    const old = sprite.material as THREE.SpriteMaterial;
    old.map?.dispose();
    const next = this.makeLabel(text);
    old.map = (next.material as THREE.SpriteMaterial).map;
    old.needsUpdate = true;
    (next.material as THREE.SpriteMaterial).dispose();
  }

  private resize = (): void => {
    const width = this.host.clientWidth || 640;
    const height = this.host.clientHeight || 420;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  private loop = (): void => {
    if (performance.now() < this.spinUntil) {
      this.reels.forEach((reel, index) => {
        reel.rotation.x += this.reducedMotion ? 0.05 : 0.25 + index * 0.025;
      });
    }
    this.frame = requestAnimationFrame(this.loop);
    this.renderer.render(this.scene, this.camera);
  };
}
