import * as THREE from 'three';
import { STAGE_HEIGHT } from './StageLayout';

/** Foreground light and coins share the stage's renderer. Fine metalwork is baked. */
export class CabinetArt {
  readonly group = new THREE.Group();
  private coinGeometry = new THREE.CylinderGeometry(13, 13, 3, 20);
  private coinMaterial = new THREE.MeshStandardMaterial({ color: 0xf3c058, metalness: 0.72, roughness: 0.22 });
  private coins = Array.from({ length: 24 }, () => new THREE.Mesh(this.coinGeometry, this.coinMaterial));
  private glowMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { strength: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 vUv; uniform float strength;
      void main(){vec2 p=(vUv-.5)*2.; float halo=pow(max(0.,1.-length(p)),2.);
        float line=exp(-abs(p.y)*18.)*(1.-abs(p.x));
        gl_FragColor=vec4(1.,.62,.12,(halo*.55+line*.8)*strength);}`,
  });
  private glow = new THREE.Mesh(new THREE.PlaneGeometry(900, 540), this.glowMaterial);
  private until = 0;
  private started = 0;
  private jackpot = false;

  constructor() {
    this.group.add(this.glow, ...this.coins);
    this.glow.position.set(530, STAGE_HEIGHT - 405, 30);
    this.coins.forEach(coin => { coin.visible = false; });
  }

  flash(payout: number, now: number, duration: number): void {
    this.started = now;
    this.until = payout > 0 ? now + duration : 0;
    this.jackpot = payout >= 1200;
  }

  stop(): void { this.until = 0; }

  update(now: number, reducedMotion: boolean): boolean {
    const winning = now < this.until;
    const elapsed = Math.max(0, (now - this.started) / 1000);
    this.glowMaterial.uniforms.strength.value = winning ? (this.jackpot ? 0.9 : 0.3) * Math.min(1, (this.until - now) / 280) : 0;
    const animateCoins = winning && this.jackpot && !reducedMotion;
    this.coins.forEach((coin, index) => {
      coin.visible = animateCoins;
      if (!animateCoins) return;
      const angle = index * 2.39996;
      const speed = 140 + (index % 6) * 40;
      coin.position.set(530 + Math.cos(angle) * (50 + elapsed * speed), STAGE_HEIGHT - 390 + 120 * Math.sin(angle) + elapsed * 460 - elapsed ** 2 * 420, 40 + index);
      coin.rotation.set(Math.PI / 2 + elapsed * 6, index + elapsed * 4, angle);
      coin.scale.setScalar(0.65 + (index % 4) * 0.27);
    });
    return winning;
  }

  dispose(): void {
    this.coinGeometry.dispose();
    this.coinMaterial.dispose();
    this.glow.geometry.dispose();
    this.glowMaterial.dispose();
  }
}
