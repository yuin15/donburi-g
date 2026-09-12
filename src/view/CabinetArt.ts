import * as THREE from 'three';

/** Cabinet graphics share the reels' renderer, camera and animation schedule. */
export class CabinetArt {
  readonly group = new THREE.Group();
  private box = new THREE.BoxGeometry(1, 1, 0.2);
  private coinGeometry = new THREE.CylinderGeometry(0.1, 0.1, 0.035, 12);
  private arrowGeometry = new THREE.ConeGeometry(0.11, 0.22, 3);
  private brass = new THREE.MeshStandardMaterial({ color: 0xd4a84f, metalness: 0.75, roughness: 0.28 });
  private backing = new THREE.MeshStandardMaterial({ color: 0x18131b, metalness: 0.2, roughness: 0.6 });
  private lineMaterial = new THREE.MeshBasicMaterial({ color: 0xffd579, transparent: true, opacity: 0.5 });
  private coinMaterial = new THREE.MeshStandardMaterial({ color: 0xffcc61, metalness: 0.7, roughness: 0.25 });
  private panel = new THREE.Mesh(this.box, this.backing);
  private rails = Array.from({ length: 4 }, () => new THREE.Mesh(this.box, this.brass));
  private lines = Array.from({ length: 2 }, () => new THREE.Mesh(this.box, this.lineMaterial));
  private arrows = Array.from({ length: 2 }, () => new THREE.Mesh(this.arrowGeometry, this.lineMaterial));
  private coins = Array.from({ length: 16 }, () => new THREE.Mesh(this.coinGeometry, this.coinMaterial));
  private until = 0;
  private started = 0;
  private jackpot = false;

  constructor() {
    this.group.add(this.panel, ...this.rails, ...this.lines, ...this.arrows, ...this.coins);
    this.panel.position.z = -0.3;
    this.coins.forEach(coin => { coin.visible = false; });
    this.resize(1);
  }

  resize(spread: number): void {
    const half = 2.7 * spread;
    this.panel.scale.set(half * 2 + 0.22, 3.86, 1);
    this.rails.forEach((rail, index) => {
      const horizontal = index < 2;
      rail.scale.set(horizontal ? half * 2 + 0.22 : 0.13, horizontal ? 0.13 : 3.65, 1.5);
      rail.position.set(horizontal ? 0 : (index === 2 ? -half : half), horizontal ? (index === 0 ? 1.82 : -1.82) : 0, 0.15);
    });
    this.lines.forEach((line, index) => {
      line.scale.set(half * 2 - 0.15, 0.012, 0.2);
      line.position.set(0, index === 0 ? 0.54 : -0.54, 0.35);
    });
    this.arrows.forEach((arrow, index) => {
      arrow.position.set(index === 0 ? -half + 0.2 : half - 0.2, 0, 0.38);
      arrow.rotation.z = index === 0 ? -Math.PI / 2 : Math.PI / 2;
    });
  }

  flash(payout: number, now: number, duration: number): void {
    this.started = now;
    this.until = payout > 0 ? now + duration : 0;
    this.jackpot = payout >= 1200;
  }

  stop(): void { this.until = 0; }

  update(now: number, reducedMotion: boolean): boolean {
    const winning = now < this.until;
    this.brass.emissive.setHex(winning ? 0xaa6408 : 0x000000);
    this.lineMaterial.opacity = winning ? 1 : 0.5;
    const animateCoins = winning && this.jackpot && !reducedMotion;
    const elapsed = (now - this.started) / 1000;
    this.coins.forEach((coin, index) => {
      coin.visible = animateCoins;
      if (!animateCoins) return;
      const direction = index / this.coins.length * Math.PI * 2;
      coin.position.set(Math.cos(direction) * (0.4 + elapsed * 2), Math.sin(direction) * 0.4 + elapsed * 2 - elapsed * elapsed * 2, 0.7);
      coin.rotation.set(Math.PI / 2 + elapsed * 5, index + elapsed * 3, 0);
    });
    return animateCoins;
  }

  dispose(): void {
    this.box.dispose();
    this.coinGeometry.dispose();
    this.arrowGeometry.dispose();
    this.brass.dispose();
    this.backing.dispose();
    this.lineMaterial.dispose();
    this.coinMaterial.dispose();
  }
}
