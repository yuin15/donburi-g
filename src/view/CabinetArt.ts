import * as THREE from 'three';
import { STAGE_HEIGHT } from './StageLayout';

/** Foreground light and coins share the stage's renderer. Fine metalwork is baked. */
export class CabinetArt {
  readonly group = new THREE.Group();
  private coinGeometry = new THREE.PlaneGeometry(44, 44);
  private coinMaterial: THREE.MeshBasicMaterial;
  private coins: THREE.Mesh[];
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
  private still = false;
  private resultCelebration = false;

  constructor(coinTexture: THREE.Texture) {
    this.coinMaterial = new THREE.MeshBasicMaterial({ map: coinTexture, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.coinMaterial.forceSinglePass = true;
    this.coins = Array.from({ length: 24 }, () => new THREE.Mesh(this.coinGeometry, this.coinMaterial));
    this.group.add(this.glow, ...this.coins);
    this.glow.position.set(530, STAGE_HEIGHT - 405, 30);
    this.coins.forEach(coin => { coin.visible = false; coin.name = 'win-coin'; });
  }

  flash(payout: number, now: number, duration: number, still = false): void {
    this.resultCelebration = false;
    this.started = now;
    this.until = payout > 0 ? now + duration : 0;
    this.jackpot = payout >= 1200;
    this.still = still && payout > 0;
  }

  celebrateResult(now: number): void {
    this.started = now;
    this.until = now + 2200;
    this.still = false;
    this.resultCelebration = true;
  }

  stop(): void { this.until = 0; this.still = false; this.resultCelebration = false; }

  update(now: number, reducedMotion: boolean): boolean {
    if (this.resultCelebration && reducedMotion) this.stop();
    if (this.still) now = this.started + 300;
    const winning = now < this.until;
    const elapsed = Math.max(0, (now - this.started) / 1000);
    const result = winning && this.resultCelebration;
    const progress = Math.min(1, elapsed / 2.2);
    this.glowMaterial.uniforms.strength.value = winning && !result ? (this.jackpot ? 0.9 : 0.3) * Math.min(1, (this.until - now) / 280) : 0;
    this.coinMaterial.opacity = result ? Math.min(1, elapsed / .12, (this.until - now) / 550) : 1;
    const animateCoins = winning && (this.jackpot || result) && !reducedMotion;
    this.coins.forEach((coin, index) => {
      coin.visible = animateCoins;
      if (!animateCoins) return;
      if (result) {
        // Keep the coins outside the result card, with a short outward lift.
        const angle = index / this.coins.length * Math.PI * 2;
        const x = Math.cos(angle);
        const y = Math.sin(angle);
        const edge = 1 / Math.max(Math.abs(x), Math.abs(y));
        const spread = 1 - (1 - progress) ** 3;
        const flutter = Math.sin(elapsed * 5 + index) * 8;
        coin.position.set(
          530 + x * edge * (438 + spread * 35) + flutter,
          STAGE_HEIGHT - 405 + y * edge * (265 + spread * 25) + Math.sin(progress * Math.PI) * 28 - progress ** 2 * 55,
          40 + index,
        );
        coin.rotation.set(.18 * Math.sin(index + elapsed), index * .47 + elapsed * 3.6, angle + elapsed * (index % 2 ? .7 : -.7));
        coin.scale.setScalar(.7 + (index % 5) * .16);
        return;
      }
      const angle = index * 2.39996;
      const radius = 215 + elapsed * 240 + (index % 3) * 15;
      coin.position.set(530 + Math.cos(angle) * radius, STAGE_HEIGHT - 405 + Math.sin(angle) * radius * .7 + elapsed * 100 - elapsed ** 2 * 220, 40 + index);
      coin.rotation.set(.2 * Math.sin(index + elapsed), index + elapsed * 4, angle + elapsed);
      coin.scale.setScalar(.7 + (index % 4) * .28);
    });
    return winning && !this.still;
  }

  dispose(): void {
    this.stop();
    this.coinGeometry.dispose();
    this.coinMaterial.dispose();
    this.glow.geometry.dispose();
    this.glowMaterial.dispose();
  }
}
