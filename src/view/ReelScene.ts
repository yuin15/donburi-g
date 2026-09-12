import * as THREE from 'three';
import type { SymbolId } from '../../shared/protocol';

const GLYPH: Record<SymbolId, string> = { cherry: '🍒', bell: '🔔', seven: '7' };

export class ReelScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  private reels: THREE.Mesh[] = [];
  private labels: THREE.Sprite[] = [];
  private textures = new Map<string, THREE.CanvasTexture>();
  private frame = 0;
  private spinUntil = 0;
  private motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  private winTimer = 0;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    Object.assign(this.renderer.domElement.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block',
    });
    host.append(this.renderer.domElement);
    this.camera.position.set(0, 0, 7);
    this.scene.add(new THREE.AmbientLight(0xfff5dd, 2));
    const key = new THREE.PointLight(0xffecd0, 45);
    key.position.set(2, 3, 4);
    this.scene.add(key);
    for (let i = 0; i < 3; i += 1) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 3.4, 0.25),
        new THREE.MeshStandardMaterial({ color: 0xf5e6c8, metalness: 0.25, roughness: 0.35 }),
      );
      mesh.position.x = (i - 1) * 1.75;
      this.scene.add(mesh);
      this.reels.push(mesh);
      for (let row = 0; row < 3; row += 1) {
        const sprite = this.makeLabel(['🔔', '🍒', '7'][row]);
        sprite.position.set(mesh.position.x, (1 - row) * 1.08, 0.2);
        this.scene.add(sprite);
        this.labels.push(sprite);
      }
    }
    this.resize();
    addEventListener('resize', this.resize);
    this.loop();
  }

  spin(): void {
    this.spinUntil = performance.now() + (this.motionPreference.matches ? 120 : 520);
  }

  show(symbols: [SymbolId, SymbolId, SymbolId], payout = 0): void {
    // Only the middle row represents the authoritative spin; outer rows are decoration.
    const order: SymbolId[] = ['cherry', 'bell', 'seven'];
    symbols.forEach((symbol, index) => {
      const at = order.indexOf(symbol);
      for (let row = 0; row < 3; row += 1) {
        this.setLabel(this.labels[index * 3 + row], GLYPH[order[(at + row + 2) % 3]]);
      }
    });
    this.spinUntil = 0;
    this.host.dataset.win = payout > 0 ? 'true' : 'false';
    this.host.dataset.jackpot = payout >= 1200 ? 'true' : 'false';
    clearTimeout(this.winTimer);
    this.winTimer = window.setTimeout(() => {
      this.host.dataset.win = 'false';
      this.host.dataset.jackpot = 'false';
    }, this.motionPreference.matches ? 250 : 900);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.winTimer);
    removeEventListener('resize', this.resize);
    for (const reel of this.reels) {
      reel.geometry.dispose();
      const material = reel.material as THREE.Material;
      material.dispose();
    }
    for (const label of this.labels) {
      const material = label.material as THREE.SpriteMaterial;
      material.dispose();
    }
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  private makeLabel(text: string): THREE.Sprite {
    let texture = this.textures.get(text);
    if (!texture) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas_context_unavailable');
    context.fillStyle = '#b01528';
    context.font = text === '7' ? 'bold italic 205px Georgia' : '170px system-ui';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 128, 138);
    texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(text, texture);
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, toneMapped: false }));
    sprite.scale.set(1.15, 1.05, 1);
    return sprite;
  }

  private setLabel(sprite: THREE.Sprite, text: string): void {
    const old = sprite.material as THREE.SpriteMaterial;
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
    const spread = Math.min(1.5, Math.max(1, this.camera.aspect / 1.5));
    this.reels.forEach((reel, index) => {
      reel.scale.x = spread;
      reel.position.x = (index - 1) * 1.75 * spread;
      for (let row = 0; row < 3; row += 1) this.labels[index * 3 + row].position.x = reel.position.x;
    });
    // Keep all three reels visible on narrow viewports and at high pixel ratios.
    this.camera.position.z = 0.2 + Math.max(2.7 * spread / this.camera.aspect, 1.8) / Math.tan(THREE.MathUtils.degToRad(19));
    this.camera.updateProjectionMatrix();
  };

  private loop = (): void => {
    const spinning = performance.now() < this.spinUntil && !this.motionPreference.matches;
    this.labels.forEach((label, index) => {
      const base = (1 - index % 3) * 1.08;
      const travel = spinning ? (performance.now() / 90 + Math.floor(index / 3) * 0.2) % 3.24 : 0;
      label.position.y = ((base + travel + 4.86) % 3.24) - 1.62;
      label.material.opacity = spinning ? 0.7 : index % 3 === 1 ? 1 : 0.48;
    });
    this.frame = requestAnimationFrame(this.loop);
    this.renderer.render(this.scene, this.camera);
  };
}
