import * as THREE from 'three';
import type { Side, SpinView, SymbolId, UpgradeId } from '../../shared/protocol';
import { PAYOUT } from '../domain/game';
import { CabinetArt } from './CabinetArt';
import { planTravel, planTravelToStop, settledOffset, symbolAtOffset, SYMBOLS, travelAt, type ReelTravel } from './ReelMotion';
import { buildReelStrip, MAX_REEL_STRIP_LENGTH } from './ReelStrip';
import { MINI_RECTS, PORTRAIT, REEL_RECTS, STAGE_HEIGHT, STAGE_WIDTH, type Rect } from './StageLayout';
import type { WinningCell } from './WinSymbols';

export type RivalExpression = 'neutral' | 'confident' | 'surprised' | 'frustrated';
const EXPRESSIONS: RivalExpression[] = ['neutral', 'confident', 'surprised', 'frustrated'];
const vertexShader = 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';
const fragmentShader = `
  varying vec2 vUv;
  uniform sampler2D atlas;
  uniform float offset;
  uniform float winning;
  uniform vec3 winningRows;
  uniform vec3 liftedRows;
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
    // Match the square artwork at the cylinder's center; curvature only foreshortens its ends.
    float x = (vUv.x-.5)*cellAspect*(mini>.5?1.:1.7*1.53/asin(.85))+.5;
    vec4 ivory = texture2D(atlas,vec2(.002,.99));
    vec4 ink = texture2D(atlas,vec2((symbol+clamp(x,.003,.997))/3.,1.-cell));
    float inside = step(0.,x)*step(x,1.);
    float reelRow = floor(row + .5);
    float lifted = reelRow < -.5 ? liftedRows.x : reelRow > .5 ? liftedRows.z : liftedRows.y;
    float cellWinning = reelRow < -.5 ? winningRows.x : reelRow > .5 ? winningRows.z : winningRows.y;
    gl_FragColor = mix(ivory,ink,inside*(1.-lifted));
    // A soft proximity shadow grounds the raised mesh in its recessed reel well.
    vec2 shadowPosition = vec2((x-.54)*2.5,(row-.12)*2.3);
    gl_FragColor.rgb *= 1.-exp(-dot(shadowPosition,shadowPosition)*2.2)*lifted*.31;
    float edge = mini>.5 ? abs(vUv.y-.5)*.34 : pow(abs(vUv.y-.5)*2.,2.2)*.88;
    float seam = pow(abs(vUv.x-.5)*2.,12.)*.2;
    gl_FragColor.rgb *= 1.-edge-seam;
    float center = 1.-smoothstep(.43,.6,abs(row));
    if(mini>.5){
      float border = min(min(vUv.x,1.-vUv.x),min(vUv.y,1.-vUv.y));
      float rim = 1.-smoothstep(.025,.11,border);
      gl_FragColor.rgb *= 1.+.05*cellWinning*winning;
      gl_FragColor.rgb += vec3(.12,.55,1.)*rim*winning;
    }else{
      gl_FragColor.rgb *= 1.+.08*cellWinning*winning;
    }
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

interface PendingSpin {
  spin: SpinView;
  started: number;
  stoppedColumns: number;
  travel: ReelTravel[];
  complete: (celebrate: boolean) => void;
}

export class ReelScene {
  private renderer: THREE.WebGLRenderer;
  private effectsRenderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, STAGE_WIDTH, STAGE_HEIGHT, 0, 0.1, 3000);
  private materials: THREE.ShaderMaterial[] = [];
  private reelMeshes: THREE.Mesh[] = [];
  private textures: THREE.Texture[] = [];
  private planes: THREE.Mesh[] = [];
  private portraitTexture: THREE.Texture;
  private portraitExpression = 0;
  private portraitReactionUntil = 0;
  private frame = 0;
  private pending: Partial<Record<Side, PendingSpin>> = {};
  private winUntil = 0;
  private rivalWinUntil = 0;
  private finalSeconds = 0;
  private disposed = false;
  private motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  private cabinet: CabinetArt;
  private atlas: THREE.WebGLRenderTarget;
  private cabinetLight = new THREE.DirectionalLight(0xffe9c4, 2.8);
  private readonly ambientLight = new THREE.AmbientLight(0xe5ebff, .24);
  private readonly fillLight = new THREE.DirectionalLight(0xb8d7ff, .65);
  private loaded = 0;
  private lastRound: Record<Side, number> = { player: 0, rival: 0 };
  private upgradeKey = '|';
  private stagedStrips: [readonly SymbolId[], readonly SymbolId[]] = [buildReelStrip([]), buildReelStrip([])];
  private activeStrips = this.stagedStrips;

  constructor(private readonly host: HTMLElement, private readonly onReelStop: (side: Side, column: number) => void = () => undefined, private readonly effectsHost?: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    Object.assign(this.renderer.domElement.style, { width: '100%', height: '100%', display: 'block' });
    host.append(this.renderer.domElement);
    if (this.effectsHost) {
      this.effectsRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      this.effectsRenderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      this.effectsRenderer.outputColorSpace = THREE.SRGBColorSpace;
      this.effectsRenderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.effectsRenderer.toneMappingExposure = 1.15;
      Object.assign(this.effectsRenderer.domElement.style, { width: '100%', height: '100%', display: 'block', pointerEvents: 'none' });
      this.effectsHost.append(this.effectsRenderer.domElement);
    }
    host.dataset.artReady = 'false';
    this.camera.position.z = 1200;
    this.scene.background = new THREE.Color(0x08090d);
    const background = this.load('/art/casino-room.webp');
    this.cabinet = new CabinetArt();
    if (this.effectsRenderer) this.cabinet.setEffectsLayer(1);
    this.scene.add(this.cabinet.group, this.ambientLight);
    const key = this.cabinetLight;
    key.position.set(-300, 1200, 1000);
    key.target.position.set(520, 430, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -780, right: 780, top: 650, bottom: -650, near: 10, far: 2600 });
    key.shadow.bias = -.0002; key.shadow.normalBias = .5; key.shadow.radius = 3;
    this.scene.add(key, key.target);
    this.fillLight.position.set(1700, 650, 600);
    this.fillLight.target.position.set(700, 450, 0);
    this.scene.add(this.fillLight, this.fillLight.target);
    if (this.effectsRenderer) {
      [this.ambientLight, this.cabinetLight, this.cabinetLight.target, this.fillLight, this.fillLight.target]
        .forEach(light => light.layers.enable(1));
    }
    this.addPlane(background, { x: 0, y: 0, w: STAGE_WIDTH, h: STAGE_HEIGHT }, -600);
    this.portraitTexture = this.load('/art/rival-expressions.webp');
    this.portraitTexture.repeat.set(.5, .5);
    this.portraitTexture.offset.set(0, .5);
    this.addPlane(this.portraitTexture, PORTRAIT, 1);
    this.atlas = this.cabinet.createReelAtlas(this.renderer);
    // The cabinet and lamps are static: render their contact shadows once.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    const atlas = this.atlas.texture;
    [...REEL_RECTS, ...MINI_RECTS].forEach((rect, i) => {
      const strip = this.activeStrips[i < 3 ? 0 : 1];
      const cells = new Float32Array(MAX_REEL_STRIP_LENGTH);
      cells.set(strip.map(symbol => SYMBOLS.indexOf(symbol)));
      const material = new THREE.ShaderMaterial({
        uniforms: { atlas: { value: atlas }, offset: { value: settledOffset(SYMBOLS[i % 3], strip) }, winning: { value: 0 }, winningRows: { value: new THREE.Vector3() }, liftedRows: { value: new THREE.Vector3() }, mini: { value: i >= 3 ? 1 : 0 }, cellAspect: { value: rect.w / rect.h }, stripLength: { value: strip.length }, strip: { value: cells } },
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
      mesh.name = 'reel-' + i;
      (i < 3 ? this.cabinet.playerGroup : this.scene).add(mesh);
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
      this.host.dataset.artReady = String(this.loaded === 2);
      this.requestRender();
    }, undefined, () => { this.host.dataset.artError = 'true'; });
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.push(texture);
    return texture;
  }

  private addPlane(texture: THREE.Texture, rect: Rect, z: number): void {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(rect.w, rect.h), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
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
    this.cabinet.hideReelWin(side);
    if (side === 'player') {
      this.cabinet.press(performance.now());
      if (this.winUntil === Infinity) this.cabinet.stop('player');
      this.clearPlayerWin();
    } else this.clearRivalWin();
    // Keep the last confirmed reward visible during its burst, including a queued spin.
    this.applyStagedStrips(side);
    const start = side === 'player' ? 0 : 3;
    this.pending[side] = {
      spin, complete, started: performance.now(), stoppedColumns: 0,
      travel: spin.symbols.map((symbol, i) => spin.stops
        ? planTravelToStop(this.materials[start + i].uniforms.offset.value, spin.stops[i], i, this.activeStrips[side === 'player' ? 0 : 1])
        : planTravel(this.materials[start + i].uniforms.offset.value, symbol, i, this.activeStrips[side === 'player' ? 0 : 1])),
    };
    this.updateSpinning();
    this.requestRender();
  }

  private updateSpinning(): void {
    this.host.dataset.playerSpinning = String(!!this.pending.player);
    this.host.dataset.rivalSpinning = String(!!this.pending.rival);
    this.host.dataset.spinning = String(!!this.pending.player || !!this.pending.rival);
  }

  setButtonCaption(caption: string): void {
    if (this.cabinet.setButtonCaption(caption)) this.requestRender();
  }
  setResult(winner: Side | 'draw' | null): void {
    if (this.cabinet.setResult(winner)) this.requestRender();
  }

  /** Preview/reset path; matches use play() and its actual stop notification. */
  show(symbols: [SymbolId, SymbolId, SymbolId], payout = 0, rival: [SymbolId, SymbolId, SymbolId] = ['cherry', 'bell', 'seven'], still = false, rivalPayout = 0): void {
    if (this.disposed) return;
    this.clearWin();
    this.pending = {};
    this.portraitReactionUntil = 0;
    this.setFinalSeconds(0);
    this.lastRound = { player: 0, rival: 0 };
    this.applyStagedStrips();
    this.host.dataset.round = '0';
    this.host.dataset.playerRound = this.host.dataset.rivalRound = '0';
    [...symbols, ...rival].forEach((symbol, i) => { this.materials[i].uniforms.offset.value = settledOffset(symbol, this.activeStrips[i < 3 ? 0 : 1]); });
    this.updateSpinning();
    const playerSpin: SpinView = { side: 'player', round: 0, symbols, grid: [symbols, symbols, symbols], winningLines: payout > 0 ? ['middle'] : [], payout, total: payout };
    const rivalSpin: SpinView = { side: 'rival', round: 0, symbols: rival, grid: [rival, rival, rival], winningLines: rivalPayout > 0 ? ['middle'] : [], payout: rivalPayout, total: rivalPayout };
    this.flashSide('player', payout, still, playerSpin);
    this.flashSide('rival', rivalPayout, still, rivalSpin);
    this.requestRender();
  }

  /** DEV review preview using the same authoritative stops as a confirmed spin. */
  showSpins(player: SpinView, rival: SpinView, still = false): void {
    if (this.disposed) return;
    this.clearWin();
    this.pending = {};
    this.portraitReactionUntil = 0;
    this.setFinalSeconds(0);
    this.lastRound = { player: player.round, rival: rival.round };
    this.applyStagedStrips();
    this.host.dataset.round = String(player.round);
    this.host.dataset.playerRound = String(player.round);
    this.host.dataset.rivalRound = String(rival.round);
    ([player, rival] as const).forEach((spin, sideIndex) => spin.symbols.forEach((symbol, column) => {
      const material = this.materials[sideIndex * 3 + column];
      material.uniforms.offset.value = spin.stops
        ? -spin.stops[column]
        : settledOffset(symbol, this.activeStrips[sideIndex]);
    }));
    this.updateSpinning();
    this.flashSide('player', player.payout, still, player);
    this.flashSide('rival', rival.payout, still, rival);
    this.requestRender();
  }

  setExpression(expression: RivalExpression): void {
    const index = EXPRESSIONS.indexOf(expression);
    if (this.portraitExpression === index) return;
    this.portraitExpression = index;
    this.portraitReactionUntil = !this.motionPreference.matches && !document.hidden ? performance.now() + 420 : 0;
    this.posePortrait(performance.now());
    this.requestRender();
  }

  private posePortrait(now: number): boolean {
    const remaining = this.motionPreference.matches ? 0 : Math.max(0, (this.portraitReactionUntil - now) / 420);
    // Crop within one atlas cell; the portrait frame and face proportions stay fixed.
    const zoom = 1 + Math.sin(remaining * Math.PI) * (this.portraitExpression === 2 ? .045 : .022);
    const size = .5 / zoom;
    const inset = (.5 - size) / 2;
    this.portraitTexture.repeat.set(size, size);
    this.portraitTexture.offset.set(this.portraitExpression % 2 * .5 + inset, (this.portraitExpression < 2 ? .5 : 0) + inset);
    return remaining > 0;
  }

  setFinalSeconds(seconds: number): void {
    if (this.disposed || seconds === this.finalSeconds) return;
    this.finalSeconds = seconds;
    this.cabinet.setFinalSeconds(seconds);
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

  private flashSide(side: Side, payout: number, still = false, spin?: SpinView): void {
    const now = performance.now();
    const allCells = this.winningCells(spin);
    const cells = side === 'player' ? allCells : allCells.filter(cell => cell.row === 1);
    const winningSymbol = allCells.reduce<SymbolId | null>((best, cell) => !best || PAYOUT[cell.symbol] > PAYOUT[best] ? cell.symbol : best, null);
    const jackpot = winningSymbol === 'seven' || payout >= PAYOUT.seven;
    const duration = this.motionPreference.matches ? 180 : jackpot ? 1200 : 650;
    const until = payout > 0 ? still ? Infinity : now + duration : 0;
    if (payout > 0) this.cabinet.flash(payout, now, duration, still, side, cells, winningSymbol);
    if (side === 'player') {
      this.winUntil = until;
      // A miss or rival stop cannot cut short an earlier player coin burst.

      this.host.dataset.win = String(payout > 0);
      this.host.dataset.jackpot = String(jackpot);
    } else {
      this.rivalWinUntil = until;
      this.host.dataset.rivalWin = String(payout > 0);
      this.host.dataset.rivalJackpot = String(jackpot);
    }
    this.materials.slice(side === 'player' ? 0 : 3, side === 'player' ? 3 : 6).forEach(m => { m.uniforms.winning.value = payout > 0 ? 1 : 0; });
    const start = side === 'player' ? 0 : 3;
    for (let column = 0; column < 3; column += 1) {
      const rows = [0, 1, 2].map(row => Number(cells.some(cell => cell.column === column && cell.row === row)));
      this.materials[start + column].uniforms.winningRows.value.set(rows[0], rows[1], rows[2]);
    }
  }

  private clearPlayerWin(): void {
    this.winUntil = 0;
    this.host.dataset.win = 'false';
    this.host.dataset.jackpot = 'false';
    this.materials.slice(0, 3).forEach(m => { m.uniforms.winning.value = 0; m.uniforms.winningRows.value.set(0, 0, 0); });
  }

  private clearRivalWin(): void {
    this.rivalWinUntil = 0;
    this.host.dataset.rivalWin = 'false';
    this.host.dataset.rivalJackpot = 'false';
    this.materials.slice(3).forEach(m => { m.uniforms.winning.value = 0; m.uniforms.winningRows.value.set(0, 0, 0); });
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
    const effects = this.effectsRenderer?.info;
    return {
      calls: render.calls + (effects?.render.calls ?? 0),
      triangles: render.triangles + (effects?.render.triangles ?? 0),
      textures: memory.textures + (effects?.memory.textures ?? 0),
      geometries: memory.geometries + (effects?.memory.geometries ?? 0),
      frames: render.frame + (effects?.render.frame ?? 0),
      loaded: this.loaded === 2,
    };
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
    this.atlas.dispose();
    this.cabinetLight.shadow.dispose();
    this.cabinet.dispose();
    this.renderer.dispose();
    this.effectsRenderer?.dispose();
    this.effectsRenderer?.domElement.remove?.();
    this.host.replaceChildren();
  }

  private resize = (): void => {
    if (this.disposed) return;
    this.renderer.setSize(this.host.clientWidth || 1280, this.host.clientHeight || 720, false);
    this.effectsRenderer?.setSize(this.host.clientWidth || 1280, this.host.clientHeight || 720, false);
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
      const stoppedColumns = reduced ? finished ? 3 : 0 : pending.travel.filter(travel => elapsed >= travel.duration).length;
      while (pending.stoppedColumns < stoppedColumns) {
        if (elapsed <= 1800) this.onReelStop(side, pending.stoppedColumns);
        pending.stoppedColumns++;
      }
      if (finished) {
        delete this.pending[side];
        this.updateSpinning();
        this.host.dataset[side === 'player' ? 'playerRound' : 'rivalRound'] = String(pending.spin.round);
        if (side === 'player') this.host.dataset.round = String(pending.spin.round);
        // A long-hidden tab catches up without replaying old celebrations.
        this.flashSide(side, elapsed > 1800 ? 0 : pending.spin.payout, false, pending.spin);
        completions.push(() => pending.complete(elapsed <= 1800));
      }
    }
    if (this.winUntil && now >= this.winUntil) this.clearPlayerWin();
    if (this.rivalWinUntil && Number.isFinite(this.rivalWinUntil)) {
      if (this.motionPreference.matches) this.rivalWinUntil = Math.min(this.rivalWinUntil, now + 180);
      if (now >= this.rivalWinUntil) this.clearRivalWin();
      else this.materials.slice(3).forEach(m => { m.uniforms.winning.value = Math.min(1, (this.rivalWinUntil - now) / 180); });
    }
    const portraitMoving = this.posePortrait(now);
    const animating = this.cabinet.update(now, this.motionPreference.matches) || portraitMoving;
    this.materials.forEach((material, i) => {
      const rows = this.cabinet.reelInkHidden(i < 3 ? 'player' : 'rival', i % 3);
      material.uniforms.liftedRows.value.set(rows[0], rows[1], rows[2]);
    });
    this.camera.layers.set(0);
    this.renderer.render(this.scene, this.camera);
    if (this.effectsRenderer) {
      const background = this.scene.background;
      this.scene.background = null;
      this.camera.layers.set(1);
      this.effectsRenderer.render(this.scene, this.camera);
      this.camera.layers.set(0);
      this.scene.background = background;
    }
    // Scores, speech and sound follow the actual settled frame.
    completions.forEach(complete => complete());
    if (this.pending.player || this.pending.rival || animating || (Number.isFinite(this.rivalWinUntil) && now < this.rivalWinUntil)) this.requestRender();
  };

  private winningCells(spin?: SpinView): WinningCell[] {
    if (!spin?.grid || !spin.winningLines?.length) return [];
    const rows = { top: [0, 0, 0], middle: [1, 1, 1], bottom: [2, 2, 2], diagonalDown: [0, 1, 2], diagonalUp: [2, 1, 0] } as const;
    const unique = new Map<string, WinningCell>();
    for (const line of spin.winningLines) {
      rows[line].forEach((row, column) => {
        const cell = { row, column: column as 0 | 1 | 2, symbol: spin.grid![row][column] } as WinningCell;
        unique.set(`${row}:${column}`, cell);
      });
    }
    return [...unique.values()];
  }
}
