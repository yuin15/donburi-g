import * as THREE from 'three';
import type { Side, SpinView, SymbolId, UpgradeId } from '../../shared/protocol';
import { CabinetArt } from './CabinetArt';
import { planTravel, settledOffset, symbolAtOffset, SYMBOLS, travelAt, type ReelTravel } from './ReelMotion';
import { buildReelStrip, MAX_REEL_STRIP_LENGTH } from './ReelStrip';
import { MINI_RECTS, PORTRAIT, REEL_RECTS, STAGE_HEIGHT, STAGE_WIDTH, type Rect } from './StageLayout';

export type RivalExpression = 'neutral' | 'confident' | 'surprised' | 'frustrated';
const EXPRESSIONS: RivalExpression[] = ['neutral', 'confident', 'surprised', 'frustrated'];
const vertexShader = 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';
const fragmentShader = `
  varying vec2 vUv;
  uniform sampler2D atlas;
  uniform float offset;
  uniform float winning;
  uniform float mini;
  uniform float cellAspect;
  uniform float stripLength;
  uniform float strip[${MAX_REEL_STRIP_LENGTH}];
  void main(){
    // UVs are a continuous display strip. Increasing offset moves ink DOWN.
    float row = mini > .5 ? (.5-vUv.y) : asin((.5-vUv.y)*1.7)/asin(.85)*1.53;
    float position = row-offset;
    int cellIndex = int(mod(floor(position+.5),stripLength));
    float symbol = strip[cellIndex];
    float cell = fract(position+.5);
    // The small window is wider than one square symbol: keep ivory margins,
    // rather than stretching the atlas cell to the full window width.
    float x = (vUv.x-.5)*(mini>.5?cellAspect:1.3)+.5;
    vec4 ivory = texture2D(atlas,vec2(.002,.99));
    vec4 ink = texture2D(atlas,vec2((symbol+clamp(x,.003,.997))/3.,1.-cell));
    float inside = step(0.,x)*step(x,1.);
    gl_FragColor = mix(ivory,ink,inside);
    float edge = mini>.5 ? abs(vUv.y-.5)*.34 : pow(abs(vUv.y-.5)*2.,2.4)*.66;
    float seam = pow(abs(vUv.x-.5)*2.,12.)*.2;
    gl_FragColor.rgb *= 1.-edge-seam;
    float center = 1.-smoothstep(.43,.6,abs(row));
    if(mini>.5){
      float border = min(min(vUv.x,1.-vUv.x),min(vUv.y,1.-vUv.y));
      float rim = 1.-smoothstep(.025,.11,border);
      gl_FragColor.rgb += (vec3(.025,.02,.005)*center+vec3(.12,.55,1.)*rim)*winning;
    }else{
      gl_FragColor.rgb += vec3(.08,.045,.005)*center*winning;
      float line = (1.-smoothstep(.003,.014,abs(abs(row)-.51)))*winning;
      gl_FragColor.rgb += vec3(.8,.4,.08)*line;
    }
    #include <colorspace_fragment>
  }`;

interface PendingSpin {
  spin: SpinView;
  started: number;
  travel: ReelTravel[];
  complete: (celebrate: boolean) => void;
}

export class ReelScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, STAGE_WIDTH, STAGE_HEIGHT, 0, 0.1, 500);
  private materials: THREE.ShaderMaterial[] = [];
  private reelMeshes: THREE.Mesh[] = [];
  private textures: THREE.Texture[] = [];
  private planes: THREE.Mesh[] = [];
  private portraitTexture: THREE.Texture;
  private frame = 0;
  private pending: Partial<Record<Side, PendingSpin>> = {};
  private winUntil = 0;
  private rivalWinUntil = 0;
  private disposed = false;
  private motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  private cabinet: CabinetArt;
  private loaded = 0;
  private lastRound: Record<Side, number> = { player: 0, rival: 0 };
  private upgradeKey = '|';
  private stagedStrips: [readonly SymbolId[], readonly SymbolId[]] = [buildReelStrip([]), buildReelStrip([])];
  private activeStrips = this.stagedStrips;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    Object.assign(this.renderer.domElement.style, { width: '100%', height: '100%', display: 'block' });
    host.append(this.renderer.domElement);
    host.dataset.artReady = 'false';
    this.camera.position.z = 200;
    this.scene.background = new THREE.Color(0x08090d);
    this.cabinet = new CabinetArt(this.load('/art/coin.webp'));
    this.scene.add(this.cabinet.group, new THREE.AmbientLight(0xffe8be, 2.2));
    const light = new THREE.PointLight(0xffe8c2, 160000);
    light.position.set(330, 800, 160);
    this.scene.add(light);
    const background = this.load('/art/casino-stage.webp');
    this.addPlane(background, { x: 0, y: 0, w: STAGE_WIDTH, h: STAGE_HEIGHT }, 0);
    this.portraitTexture = this.load('/art/rival-expressions.webp');
    this.portraitTexture.repeat.set(.5, .5);
    this.portraitTexture.offset.set(0, .5);
    this.addPlane(this.portraitTexture, PORTRAIT, 1);
    const atlas = this.load('/art/symbols.webp');
    [...REEL_RECTS, ...MINI_RECTS].forEach((rect, i) => {
      const strip = this.activeStrips[i < 3 ? 0 : 1];
      const cells = new Float32Array(MAX_REEL_STRIP_LENGTH);
      cells.set(strip.map(symbol => SYMBOLS.indexOf(symbol)));
      const material = new THREE.ShaderMaterial({
        uniforms: { atlas: { value: atlas }, offset: { value: settledOffset(SYMBOLS[i % 3], strip) }, winning: { value: 0 }, mini: { value: i >= 3 ? 1 : 0 }, cellAspect: { value: rect.w / rect.h }, stripLength: { value: strip.length }, strip: { value: cells } },
        vertexShader, fragmentShader,
      });
      const geometry = new THREE.PlaneGeometry(rect.w, rect.h, 1, i >= 3 ? 1 : 32);
      const positions = geometry.attributes.position;
      for (let vertex = 0; vertex < positions.count; vertex += 1) {
        const normalizedY = positions.getY(vertex) / (rect.h / 2);
        positions.setZ(vertex, i >= 3 ? 0 : Math.sqrt(1 - normalizedY ** 2 * .9) * 12);
      }
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, material);
      this.place(mesh, rect, 3);
      this.scene.add(mesh);
      this.reelMeshes.push(mesh);
      this.materials.push(material);
    });
    this.resize();
    addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.motionPreference.addEventListener('change', this.requestRender);
  }

  private load(url: string): THREE.Texture {
    const texture = new THREE.TextureLoader().load(url, () => {
      if (this.disposed) return;
      this.loaded += 1;
      this.host.dataset.artReady = String(this.loaded === 4);
      this.requestRender();
    }, undefined, () => { this.host.dataset.artError = 'true'; });
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.push(texture);
    return texture;
  }

  private addPlane(texture: THREE.Texture, rect: Rect, z: number): void {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(rect.w, rect.h), new THREE.MeshBasicMaterial({ map: texture }));
    this.place(plane, rect, z);
    this.planes.push(plane);
    this.scene.add(plane);
  }

  private place(mesh: THREE.Mesh, rect: Rect, z: number): void {
    mesh.position.set(rect.x + rect.w / 2, STAGE_HEIGHT - rect.y - rect.h / 2, z);
  }

  /** Confirmed upgrades are staged until the next spin or explicit still view. */
  setUpgrades(player: readonly UpgradeId[], rival: readonly UpgradeId[]): void {
    if (this.disposed) return;
    const key = `${player.join(',')}|${rival.join(',')}`;
    if (key === this.upgradeKey) return;
    this.upgradeKey = key;
    this.stagedStrips = [buildReelStrip(player), buildReelStrip(rival)];
  }

  private applyStagedStrips(target?: Side): void {
    this.materials.forEach((material, index) => {
      const side = index < 3 ? 0 : 1;
      if (target && (side === 0 ? 'player' : 'rival') !== target) return;
      if (this.activeStrips[side] === this.stagedStrips[side]) return;
      const offset = material.uniforms.offset.value as number;
      const symbol = symbolAtOffset(offset, this.activeStrips[side]);
      const strip = this.stagedStrips[side];
      // Rebase around the same visible center, including a fractional position
      // when a newer round supersedes an unfinished animation.
      const fraction = offset + Math.floor(-offset + .5);
      material.uniforms.offset.value = settledOffset(symbol, strip) + fraction;
      (material.uniforms.strip.value as Float32Array).set(strip.map(cell => SYMBOLS.indexOf(cell)));
      material.uniforms.stripLength.value = strip.length;
    });
    this.activeStrips = [
      target === 'rival' ? this.activeStrips[0] : this.stagedStrips[0],
      target === 'player' ? this.activeStrips[1] : this.stagedStrips[1],
    ];
  }

  play(player: SpinView, rival: SpinView, complete: (celebrate: boolean) => void): void {
    let stopped = 0;
    let celebrate = true;
    const done = (value: boolean) => { celebrate &&= value; if (++stopped === 2) complete(celebrate); };
    this.playSide(player, done);
    this.playSide(rival, done);
  }

  playSide(spin: SpinView, complete: (celebrate: boolean) => void): void {
    const side = spin.side;
    if (this.disposed || spin.round <= this.lastRound[side]) return;
    this.lastRound[side] = spin.round;
    if (side === 'player') {
      if (this.winUntil === Infinity) this.cabinet.stop('player');
      this.clearPlayerWin();
    } else this.clearRivalWin();
    this.applyStagedStrips(side);
    const start = side === 'player' ? 0 : 3;
    this.pending[side] = {
      spin, complete, started: performance.now(),
      travel: spin.symbols.map((symbol, i) => planTravel(this.materials[start + i].uniforms.offset.value, symbol, i, this.activeStrips[side === 'player' ? 0 : 1])),
    };
    this.updateSpinning();
    this.requestRender();
  }

  private updateSpinning(): void {
    this.host.dataset.playerSpinning = String(!!this.pending.player);
    this.host.dataset.rivalSpinning = String(!!this.pending.rival);
    this.host.dataset.spinning = String(!!this.pending.player || !!this.pending.rival);
  }

  /** Preview/reset path; matches use play() and its actual stop notification. */
  show(symbols: [SymbolId, SymbolId, SymbolId], payout = 0, rival: [SymbolId, SymbolId, SymbolId] = ['cherry', 'bell', 'seven'], still = false, rivalPayout = 0): void {
    if (this.disposed) return;
    this.clearWin();
    this.pending = {};
    this.lastRound = { player: 0, rival: 0 };
    this.applyStagedStrips();
    this.host.dataset.round = '0';
    this.host.dataset.playerRound = this.host.dataset.rivalRound = '0';
    [...symbols, ...rival].forEach((symbol, i) => { this.materials[i].uniforms.offset.value = settledOffset(symbol, this.activeStrips[i < 3 ? 0 : 1]); });
    this.updateSpinning();
    this.flash(payout, still, rivalPayout);
    this.requestRender();
  }

  setExpression(expression: RivalExpression): void {
    const index = EXPRESSIONS.indexOf(expression);
    const x = (index % 2) * .5;
    const y = index < 2 ? .5 : 0;
    if (this.portraitTexture.offset.x === x && this.portraitTexture.offset.y === y) return;
    this.portraitTexture.offset.set(x, y);
    this.requestRender();
  }

  /** Decorate the confirmed result without changing the settled reels or payout. */
  celebrateResult(winner: 'player' | 'rival' | 'draw'): void {
    if (this.disposed) return;
    this.cabinet.stop();
    if (winner === 'player' && !this.motionPreference.matches && !document.hidden) {
      this.cabinet.celebrateResult(performance.now());
    }
    this.requestRender();
  }

  private flash(payout: number, still = false, rivalPayout = 0): void {
    this.flashSide('player', payout, still);
    this.flashSide('rival', rivalPayout, still);
  }

  private flashSide(side: Side, payout: number, still = false): void {
    const now = performance.now();
    const duration = this.motionPreference.matches ? 180 : payout >= 1200 ? 1200 : 650;
    const until = payout > 0 ? still ? Infinity : now + duration : 0;
    if (payout > 0) this.cabinet.flash(payout, now, duration, still, side);
    if (side === 'player') {
      this.winUntil = until;
      // A miss or rival stop cannot cut short an earlier player coin burst.

      this.host.dataset.win = String(payout > 0);
      this.host.dataset.jackpot = String(payout >= 1200);
    } else {
      this.rivalWinUntil = until;
      this.host.dataset.rivalWin = String(payout > 0);
      this.host.dataset.rivalJackpot = String(payout >= 1200);
    }
    this.materials.slice(side === 'player' ? 0 : 3, side === 'player' ? 3 : 6).forEach(m => { m.uniforms.winning.value = payout > 0 ? 1 : 0; });
  }

  private clearPlayerWin(): void {
    this.winUntil = 0;
    this.host.dataset.win = 'false';
    this.host.dataset.jackpot = 'false';
    this.materials.slice(0, 3).forEach(m => { m.uniforms.winning.value = 0; });
  }

  private clearRivalWin(): void {
    this.rivalWinUntil = 0;
    this.host.dataset.rivalWin = 'false';
    this.host.dataset.rivalJackpot = 'false';
    this.materials.slice(3).forEach(m => { m.uniforms.winning.value = 0; });
  }

  private clearWin(stopCabinet = true): void {
    this.clearPlayerWin();
    this.clearRivalWin();
    if (stopCabinet) this.cabinet.stop();
  }

  stop(): void {
    if (this.disposed) return;
    for (const side of ['player', 'rival'] as const) this.pending[side]?.travel.forEach((travel, i) => {
      this.materials[i + (side === 'player' ? 0 : 3)].uniforms.offset.value = travel.to;
    });
    this.pending = {};
    this.lastRound = { player: 0, rival: 0 };
    this.updateSpinning();
    this.clearWin();
    this.requestRender();
  }

  stats(): { calls: number; triangles: number; textures: number; geometries: number; frames: number; loaded: boolean } {
    const { render, memory } = this.renderer.info;
    return { calls: render.calls, triangles: render.triangles, textures: memory.textures, geometries: memory.geometries, frames: render.frame, loaded: this.loaded === 4 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = {};
    this.clearWin();
    cancelAnimationFrame(this.frame);
    removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.motionPreference.removeEventListener('change', this.requestRender);
    for (const mesh of [...this.reelMeshes, ...this.planes]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.textures.forEach(t => t.dispose());
    this.cabinet.dispose();
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  private resize = (): void => {
    if (this.disposed) return;
    this.renderer.setSize(this.host.clientWidth || 1280, this.host.clientHeight || 720, false);
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
    } else this.requestRender();
  };

  private loop = (): void => {
    this.frame = 0;
    if (this.disposed || document.hidden) return;
    const now = performance.now();
    const completions: Array<() => void> = [];
    for (const side of ['player', 'rival'] as const) {
      const pending = this.pending[side];
      if (!pending) continue;
      const elapsed = now - pending.started;
      const reduced = this.motionPreference.matches;
      const finished = elapsed >= (reduced ? 120 : pending.travel[2].duration);
      this.materials.slice(side === 'player' ? 0 : 3, side === 'player' ? 3 : 6).forEach((m, i) => {
        if (!reduced || finished) m.uniforms.offset.value = finished ? pending.travel[i].to : travelAt(pending.travel[i], elapsed);
      });
      if (finished) {
        delete this.pending[side];
        this.updateSpinning();
        this.host.dataset[side === 'player' ? 'playerRound' : 'rivalRound'] = String(pending.spin.round);
        if (side === 'player') this.host.dataset.round = String(pending.spin.round);
        // A long-hidden tab catches up without replaying old celebrations.
        this.flashSide(side, elapsed > 1800 ? 0 : pending.spin.payout);
        completions.push(() => pending.complete(elapsed <= 1800));
      }
    }
    if (this.winUntil && now >= this.winUntil) this.clearPlayerWin();
    if (this.rivalWinUntil && Number.isFinite(this.rivalWinUntil)) {
      if (this.motionPreference.matches) this.rivalWinUntil = Math.min(this.rivalWinUntil, now + 180);
      if (now >= this.rivalWinUntil) this.clearRivalWin();
      else this.materials.slice(3).forEach(m => { m.uniforms.winning.value = Math.min(1, (this.rivalWinUntil - now) / 180); });
    }
    const animating = this.cabinet.update(now, this.motionPreference.matches);
    this.renderer.render(this.scene, this.camera);
    // Scores, speech and sound follow the actual settled frame.
    completions.forEach(complete => complete());
    if (this.pending.player || this.pending.rival || animating || (Number.isFinite(this.rivalWinUntil) && now < this.rivalWinUntil)) this.requestRender();
  };
}
