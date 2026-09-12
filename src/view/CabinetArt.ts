import * as THREE from 'three';
import type { Side } from '../../shared/protocol';
import { STAGE_HEIGHT, STAGE_WIDTH } from './StageLayout';
import { createGoldCoinEnvironment, createGoldCoinGeometry, createGoldCoinMaterial } from './GoldCoin';
import { PAYOUT } from '../domain/game';
import { WinSymbols } from './WinSymbols';
import type { WinSymbol } from './SymbolModels';

type Burst = { started: number; until: number; jackpot: boolean; still: boolean; symbol: WinSymbol | null };
const emptyBurst = (): Burst => ({ started: 0, until: 0, jackpot: false, still: false, symbol: null });
const sides: Side[] = ['player', 'rival'];

/** Two independent win lanes, sharing one renderer and 24 reusable 3D coins. */
export class CabinetArt {
  readonly group = new THREE.Group();
  private coinGeometry = createGoldCoinGeometry();
  private coinEnvironment = createGoldCoinEnvironment();
  private winSymbols = new WinSymbols(this.coinEnvironment);
  private bulbGeometry = new THREE.SphereGeometry(4.2, 8, 6);
  private coinMaterials: Record<Side, THREE.MeshStandardMaterial>;
  private coins: THREE.Mesh[];
  private bursts: Record<Side, Burst> = { player: emptyBurst(), rival: emptyBurst() };
  private glows: Record<Side, THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>>;
  private bulbs: Record<Side, THREE.InstancedMesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>>;
  private sparkleGeometry = new THREE.PlaneGeometry(1, 1);
  private sparkles: Record<Side, THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial>>;
  private particle = new THREE.Object3D();
  private lampColor = new THREE.Color();
  private finalSeconds = 0;
  private timerGeometry = new THREE.PlaneGeometry(14, 4);
  private timerLights: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private finalGlow: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private resultStarted = 0;
  private resultUntil = 0;

  constructor() {
    this.coinMaterials = {
      player: createGoldCoinMaterial(this.coinEnvironment),
      rival: createGoldCoinMaterial(this.coinEnvironment),
    };
    this.coins = Array.from({ length: 24 }, (_, index) => {
      const mesh = new THREE.Mesh(this.coinGeometry, this.coinMaterials[index < 12 ? 'player' : 'rival']);
      mesh.visible = false; mesh.name = 'win-coin';
      return mesh;
    });
    this.glows = { player: this.makeGlow('player'), rival: this.makeGlow('rival') };
    this.bulbs = { player: this.makeBulbs('player'), rival: this.makeBulbs('rival') };
    this.sparkles = { player: this.makeSparkles('player'), rival: this.makeSparkles('rival') };
    this.timerLights = this.makeTimerLights();
    this.finalGlow = this.makeFinalGlow();
    this.group.add(this.timerLights, this.finalGlow, this.glows.player, this.glows.rival, this.bulbs.player, this.bulbs.rival, this.sparkles.player, this.sparkles.rival, this.winSymbols.group, ...this.coins);
  }

  setFinalSeconds(seconds: number): void { this.finalSeconds = seconds; }

  hideWinSymbol(side: Side): void { this.bursts[side].symbol = null; }

  private makeTimerLights(): THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
    const lights = new THREE.InstancedMesh(this.timerGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false }), 10);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 10; i++) lights.setMatrixAt(i, matrix.makeTranslation(754 + i * 17.7, STAGE_HEIGHT - 156, 32));
    lights.instanceMatrix.needsUpdate = true;
    lights.name = 'final-seconds-lights';
    lights.visible = false;
    return lights;
  }

  private makeFinalGlow(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { strength: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `varying vec2 vUv; uniform float strength;
        void main(){vec2 p=abs(vUv-.5)*2.; float edge=pow(clamp((max(p.x,p.y)-.8)/.2,0.,1.),2.);
          gl_FragColor=vec4(1.,.19,.045,edge*strength);}`,
    });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(STAGE_WIDTH, STAGE_HEIGHT), material);
    glow.position.set(STAGE_WIDTH / 2, STAGE_HEIGHT / 2, 35);
    glow.visible = false;
    return glow;
  }

  private makeGlow(side: Side): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
    const player = side === 'player';
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { strength: { value: 0 }, progress: { value: 0 }, jackpot: { value: 0 }, tint: { value: new THREE.Color(player ? 0xffbf45 : 0x83caff) } },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `varying vec2 vUv; uniform float strength; uniform float progress; uniform float jackpot; uniform vec3 tint;
        void main(){vec2 p=(vUv-.5)*2.; float radius=length(p);
          float halo=pow(max(0.,1.-radius),3.);
          float line=exp(-abs(p.y)*38.)*max(0.,1.-abs(p.x));
          float angle=atan(p.y,p.x);
          float rays=pow(max(0.,cos(angle*16.+progress*1.8)),18.)
            *smoothstep(.24,.42,radius)*(1.-smoothstep(.6,1.,radius));
          float ring=exp(-abs(radius-(.25+progress*.72))*60.)*(1.-progress);
          gl_FragColor=vec4(tint,(halo*.26+line*.9+(rays*.26+ring*.25)*jackpot)*strength);}`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(player ? 980 : 610, player ? 690 : 290), material);
    mesh.position.set(player ? 530 : 1250, STAGE_HEIGHT - (player ? 405 : 740), 30);
    return mesh;
  }

  private makeBulbs(side: Side): THREE.InstancedMesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> {
    const player = side === 'player';
    const bounds = player ? { x: 258, y: 241, w: 550, h: 330 } : { x: 1033, y: 689, w: 435, h: 103 };
    const points: Array<[number, number]> = [];
    for (let i = 0; i < 8; i++) {
      const x = bounds.x + bounds.w * i / 7;
      points.push([x, bounds.y], [x, bounds.y + bounds.h]);
    }
    const vertical = player ? 6 : 2;
    for (let i = 1; i <= vertical; i++) {
      const y = bounds.y + bounds.h * i / (vertical + 1);
      points.push([bounds.x, y], [bounds.x + bounds.w, y]);
    }
    const material = new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, depthWrite: false });
    const lamps = new THREE.InstancedMesh(this.bulbGeometry, material, points.length);
    lamps.name = side + '-win-lights';
    lamps.visible = false;
    const matrix = new THREE.Matrix4();
    points.forEach(([x, y], index) => lamps.setMatrixAt(index, matrix.makeTranslation(x, STAGE_HEIGHT - y, 32)));
    lamps.instanceMatrix.needsUpdate = true;
    return lamps;
  }

  private makeSparkles(side: Side): THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { opacity: { value: 0 }, tint: { value: new THREE.Color(side === 'player' ? 0xffd477 : 0xaee2ff) } },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.);}',
      fragmentShader: `varying vec2 vUv; uniform float opacity; uniform vec3 tint;
        void main(){vec2 p=abs((vUv-.5)*2.);
          float core=pow(max(0.,1.-length(p)),6.);
          float star=pow(max(0.,1.-p.x),22.)*pow(max(0.,1.-p.y),2.)
            +pow(max(0.,1.-p.y),22.)*pow(max(0.,1.-p.x),2.);
          gl_FragColor=vec4(tint,min(1.,core+star)*opacity);}`,
    });
    const mesh = new THREE.InstancedMesh(this.sparkleGeometry, material, 18);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.name = side + '-win-sparkles';
    return mesh;
  }

  flash(payout: number, now: number, duration: number, still = false, side: Side = 'player'): void {
    this.resultUntil = 0;
    this.bursts[side] = {
      started: now, until: payout > 0 ? now + duration : 0, jackpot: payout >= PAYOUT.seven, still: still && payout > 0,
      symbol: payout === PAYOUT.bell ? 'bell' : payout === PAYOUT.cherry ? 'cherry' : null,
    };
  }

  celebrateResult(now: number): void {
    this.stop();
    this.resultStarted = now;
    this.resultUntil = now + 2200;
  }

  stop(side?: Side): void {
    for (const target of side ? [side] : sides) this.bursts[target] = emptyBurst();
    if (!side) this.resultUntil = 0;
  }

  update(now: number, reducedMotion: boolean): boolean {
    if (reducedMotion) this.resultUntil = 0;
    const result = now < this.resultUntil;
    const finale = this.finalSeconds > 0;
    this.timerLights.visible = this.finalGlow.visible = finale;
    if (finale) {
      const pulse = reducedMotion ? 0 : Math.sin(now / 160) * .025;
      this.finalGlow.material.uniforms.strength.value = .12 + (10 - this.finalSeconds) * .01 + pulse;
      for (let i = 0; i < 10; i++) {
        this.lampColor.set(i < this.finalSeconds ? 0xffb359 : 0x27120d);
        this.timerLights.setColorAt(i, this.lampColor);
      }
      if (this.timerLights.instanceColor) this.timerLights.instanceColor.needsUpdate = true;
    }
    let animating = result || finale && !reducedMotion;
    for (const side of sides) {
      const burst = this.bursts[side];
      const time = burst.still ? burst.started + (burst.until - burst.started) * .36 : now;
      const winning = time < burst.until;
      const fade = Math.min(1, Math.max(0, (burst.until - time) / 200));
      this.glows[side].material.uniforms.strength.value = winning ? (burst.jackpot ? side === 'player' ? 1.15 : .7 : .45) * fade : 0;
      this.glows[side].material.uniforms.jackpot.value = Number(burst.jackpot);
      this.bulbs[side].visible = winning;
      this.bulbs[side].material.opacity = winning ? fade : 0;
      if (winning) {
        const lamps = this.bulbs[side];
        for (let index = 0; index < lamps.count; index++) {
          const chase = reducedMotion ? 1 : .5 + .5 * Math.cos(index * .9 - (time - burst.started) / 110);
          this.lampColor.setRGB(1, .57 + chase * .43, .18 + chase * .67);
          lamps.setColorAt(index, this.lampColor);
        }
        if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
      }
      this.coinMaterials[side].opacity = result ? Math.min(1, (this.resultUntil - now) / 450) : fade;
      animating ||= winning && !burst.still;
      const duration = burst.until - burst.started;
      const progress = duration > 0 ? Math.max(0, (time - burst.started) / duration) : 1;
      this.winSymbols.update(side, winning ? burst.symbol : null, progress, fade, reducedMotion);
      this.glows[side].material.uniforms.progress.value = progress;
      const sparkle = this.sparkles[side];
      sparkle.visible = winning && !reducedMotion;
      sparkle.material.uniforms.opacity.value = fade;
      if (sparkle.visible) {
        sparkle.count = burst.jackpot ? 18 : 8;
        for (let i = 0; i < sparkle.count; i++) {
          const angle = i * 2.39996;
          const spread = 1 - (1 - Math.min(1, progress)) ** 3;
          const radius = 110 + spread * (80 + i % 5 * 28);
          this.particle.position.set(
            (side === 'player' ? 534 : 1252) + Math.cos(angle) * radius * (side === 'player' ? 1.6 : .85),
            STAGE_HEIGHT - (side === 'player' ? 400 : 740) + Math.sin(angle) * radius * (side === 'player' ? .83 : .28),
            38,
          );
          this.particle.rotation.set(0, 0, angle + progress * .6);
          this.particle.scale.setScalar((burst.jackpot ? 25 : 14) + (i % 4) * 8);
          this.particle.updateMatrix();
          sparkle.setMatrixAt(i, this.particle.matrix);
        }
        sparkle.instanceMatrix.needsUpdate = true;
      }
      for (let i = 0; i < 12; i++) {
        const coin = this.coins[i + (side === 'player' ? 0 : 12)];
        coin.visible = !reducedMotion && (result || winning && i < (burst.jackpot ? 12 : 4));
        if (!coin.visible) continue;
        if (result) {
          const index = this.coins.indexOf(coin);
          const elapsed = (now - this.resultStarted) / 1000;
          const p = Math.min(1, elapsed / 2.2);
          const angle = index / 24 * Math.PI * 2;
          const x = Math.cos(angle), y = Math.sin(angle);
          const edge = 1 / Math.max(Math.abs(x), Math.abs(y));
          const spread = 1 - (1 - p) ** 3;
          coin.position.set(530 + x * edge * (438 + spread * 35), STAGE_HEIGHT - 405 + y * edge * (265 + spread * 25) - p ** 2 * 55, 40 + index);
          coin.rotation.set(.18 * Math.sin(index + elapsed), index * .47 + elapsed * 3.6, angle + elapsed * .7);
          coin.scale.setScalar(.7 + (index % 5) * .16);
          continue;
        }
        // Travel outside the center payline and face, ending at the score's outer edge.
        const right = i % 2 === 1;
        const player = side === 'player';
        const startX = player ? right ? 825 : 245 : right ? 1500 : 1028;
        const endX = player ? right ? 680 : 104 : right ? 1584 : 990;
        const controlX = player ? right ? 950 + i % 6 * 12 : 70 - i % 6 * 9 : right ? 1630 : 975;
        const startY = (player ? 520 : 748) + (i % 6) * (player ? 24 : 13);
        const delay = (i % 6) * .032;
        const t = Math.min(1, Math.max(0, (progress - delay) / (1 - delay)));
        const u = 1 - t;
        const x = u * u * startX + 2 * u * t * controlX + t * t * endX;
        const y = u * u * startY + 2 * u * t * (player ? 20 + i % 6 * 33 : 380) + t * t * (player ? 112 + i % 6 * 24 : 112);
        coin.position.set(x, STAGE_HEIGHT - y, 40 + i);
        coin.rotation.set(.32 + Math.sin(i + t * 4) * .18, i * .62 + t * 5.6, (right ? 1 : -1) * (.3 + t));
        coin.scale.setScalar((player && burst.jackpot ? 1.35 : .85) + (i % 3) * .23);
      }
    }
    return animating;
  }

  dispose(): void {
    this.stop();
    this.coinGeometry.dispose();
    this.winSymbols.dispose();
    this.coinEnvironment.dispose();
    this.bulbGeometry.dispose();
    this.sparkleGeometry.dispose();
    this.timerGeometry.dispose();
    this.timerLights.material.dispose();
    this.finalGlow.geometry.dispose();
    this.finalGlow.material.dispose();
    for (const side of sides) {
      this.coinMaterials[side].dispose();
      this.glows[side].geometry.dispose();
      this.glows[side].material.dispose();
      this.bulbs[side].material.dispose();
      this.sparkles[side].material.dispose();
    }
  }
}
