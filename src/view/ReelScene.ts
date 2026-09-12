import * as THREE from 'three';
import type { SymbolId } from '../../shared/protocol';
import { CabinetArt } from './CabinetArt';

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
  private disposed = false;
  private cabinet = new CabinetArt();

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    Object.assign(this.renderer.domElement.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block',
    });
    host.append(this.renderer.domElement);
    this.camera.position.set(0, 0, 7);
    this.scene.background = new THREE.Color(0x090c13);
    this.scene.add(this.cabinet.group);
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
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.motionPreference.addEventListener('change', this.requestRender);
  }

  spin(): void {
    if (this.disposed) return;
    this.spinUntil = performance.now() + (this.motionPreference.matches ? 120 : 520);
    this.requestRender();
  }

  show(symbols: [SymbolId, SymbolId, SymbolId], payout = 0): void {
    if (this.disposed) return;
    // Only the middle row represents the authoritative spin; outer rows are decoration.
    const order: SymbolId[] = ['cherry', 'bell', 'seven'];
    symbols.forEach((symbol, index) => {
      const at = order.indexOf(symbol);
      for (let row = 0; row < 3; row += 1) {
        this.setLabel(this.labels[index * 3 + row], GLYPH[order[(at + row + 2) % 3]]);
      }
    });
    this.spinUntil = 0;
    this.cabinet.flash(payout, performance.now(), this.motionPreference.matches ? 250 : 900);
    this.host.dataset.win = payout > 0 ? 'true' : 'false';
    this.host.dataset.jackpot = payout >= 1200 ? 'true' : 'false';
    clearTimeout(this.winTimer);
    if (payout > 0) {
      this.winTimer = window.setTimeout(() => {
        this.host.dataset.win = 'false';
        this.host.dataset.jackpot = 'false';
        this.requestRender();
      }, this.motionPreference.matches ? 250 : 900);
    }
    this.requestRender();
  }

  stop(): void {
    if (this.disposed) return;
    this.cabinet.stop();
    this.spinUntil = 0;
    clearTimeout(this.winTimer);
    this.host.dataset.win = 'false';
    this.host.dataset.jackpot = 'false';
    // Settle the visible symbols once, without keeping a background render loop.
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.winTimer);
    removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.motionPreference.removeEventListener('change', this.requestRender);
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
    this.cabinet.dispose();
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
    // All three glyph textures were prepared in the constructor.
    sprite.material.map = this.textures.get(text)!;
  }

  private resize = (): void => {
    if (this.disposed) return;
    const width = this.host.clientWidth || 640;
    const height = this.host.clientHeight || 420;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    const spread = Math.min(1.5, Math.max(1, this.camera.aspect / 1.5));
    this.cabinet.resize(spread);
    this.reels.forEach((reel, index) => {
      reel.scale.x = spread;
      reel.position.x = (index - 1) * 1.75 * spread;
      for (let row = 0; row < 3; row += 1) this.labels[index * 3 + row].position.x = reel.position.x;
    });
    // Keep all three reels visible on narrow viewports and at high pixel ratios.
    this.camera.position.z = 0.35 + Math.max(2.95 * spread / this.camera.aspect, 2.02) / Math.tan(THREE.MathUtils.degToRad(19));
    this.camera.updateProjectionMatrix();
    this.requestRender();
  };

  private requestRender = (): void => {
    if (this.disposed || document.hidden || this.frame) return;
    this.frame = requestAnimationFrame(this.loop);
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    } else {
      this.requestRender();
    }
  };

  private loop = (): void => {
    this.frame = 0;
    if (this.disposed || document.hidden) return;
    const spinning = performance.now() < this.spinUntil && !this.motionPreference.matches;
    const animating = this.cabinet.update(performance.now(), this.motionPreference.matches);
    this.labels.forEach((label, index) => {
      const base = (1 - index % 3) * 1.08;
      const travel = spinning ? (performance.now() / 90 + Math.floor(index / 3) * 0.2) % 3.24 : 0;
      label.position.y = ((base + travel + 4.86) % 3.24) - 1.62;
      label.material.opacity = spinning ? 0.7 : index % 3 === 1 ? 1 : 0.48;
    });
    this.renderer.render(this.scene, this.camera);
    if (spinning || animating) this.requestRender();
  };
}
