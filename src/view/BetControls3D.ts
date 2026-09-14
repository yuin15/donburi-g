import * as THREE from 'three';
import type { Bet, WinningLine } from '../../shared/protocol';
import { ACTIVE_LINES, BETS } from '../domain/game';
import { createFinishDetails } from './FinishTextures';
import { SculptedType } from './SculptedType';
import { OVERLAYS, STAGE_HEIGHT } from './StageLayout';

export interface BetControlsState {
  bet: Bet;
  balance: number;
  enabled: boolean;
  showLines: boolean;
  winningLines: readonly WinningLine[];
}

type Key = { bet: Bet; cap: THREE.Group; face: THREE.MeshPhysicalMaterial; lamp: THREE.Mesh; disabled: boolean; pressedAt: number };
type Marker = { line: WinningLine; group: THREE.Group; face: THREE.Mesh; lettering: THREE.Group; lamp: THREE.Mesh };
type Trace = { group: THREE.Group; geometry: THREE.TubeGeometry; core: THREE.MeshBasicMaterial; halo: THREE.MeshBasicMaterial; started: number };
const LINE_Y: Record<WinningLine, number> = { top: 323.8, middle: 458.5, bottom: 593.2, diagonalDown: 258.2, diagonalUp: 658.8 };

/** Real bevelled meshes and raised lettering, sharing the cabinet's HDR reflections. */
export class BetControls3D {
  readonly group = new THREE.Group();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly metalDetail = createFinishDetails('metal');
  private readonly lettering: SculptedType;
  private readonly gold: THREE.MeshPhysicalMaterial;
  private readonly chrome: THREE.MeshPhysicalMaterial;
  private readonly dark: THREE.MeshPhysicalMaterial;
  private readonly ink: THREE.MeshPhysicalMaterial;
  private readonly lightInk: THREE.MeshPhysicalMaterial;
  private readonly green: THREE.MeshPhysicalMaterial;
  private readonly lampOn: THREE.MeshBasicMaterial;
  private readonly lampOff: THREE.MeshPhysicalMaterial;
  private readonly keys: Key[] = [];
  private readonly markers: Marker[] = [];
  private readonly traces = new Map<WinningLine, Trace>();
  private readonly sweepPosition = { value: -1000 };
  private readonly sweepStrength = { value: 0 };
  private shineStarted = -Infinity;
  private winUntil = 0;
  private winningKey = '';
  private stateKey = '';
  private selected: Bet = 1;
  private hovered: Bet | null = null;

  constructor(environment: THREE.Texture) {
    this.group.name = 'physical-bet-controls';
    this.lettering = new SculptedType(environment);
    const finish = (color: number, metalness: number, roughness: number) => this.material(new THREE.MeshPhysicalMaterial({
      color, metalness, roughness, clearcoat: 1, clearcoatRoughness: .055,
      envMap: environment, envMapIntensity: 1.3,
    }));
    this.gold = finish(0xf2c25d, .94, .19);
    this.gold.roughnessMap = this.metalDetail.roughness;
    this.gold.normalMap = this.metalDetail.normal;
    this.gold.normalScale.set(.12, .12);
    this.addSheen(this.gold);
    this.chrome = finish(0xffeed0, 1, .105);
    this.dark = finish(0x1d090a, .25, .23);
    this.ink = finish(0x33070d, .08, .38);
    this.ink.envMapIntensity = .25;
    this.ink.clearcoat = .15;
    this.lightInk = finish(0xffe6b0, .12, .3);
    this.lightInk.envMapIntensity = .35;
    this.lightInk.clearcoat = .3;
    this.green = finish(0x123522, .2, .19);
    this.lampOn = this.material(new THREE.MeshBasicMaterial({ color: 0xffedb5, toneMapped: false }));
    this.lampOff = finish(0x584227, .6, .26);

    const tray = new THREE.Group();
    const bounds = OVERLAYS.betControls;
    tray.position.set(bounds.x + bounds.w / 2, STAGE_HEIGHT - bounds.y - bounds.h / 2, 185);
    tray.name = 'bet-metal-tray';
    this.group.add(tray);
    this.plate(tray, 568, 69, 11, 8, 3, this.gold);
    this.plate(tray, 558, 59, 8, 7, 2, this.dark, 5);
    const keyWidth = (bounds.w - 34) / 3;
    BETS.forEach((bet, index) => {
      const socket = new THREE.Group();
      socket.name = `bet-${bet}-socket`;
      socket.position.set((index - 1) * (keyWidth + 8), 0, 8);
      socket.rotation.set(-.16, .055, 0);
      tray.add(socket);
      this.plate(socket, keyWidth + 1, 57, 26, 9, 2.8, this.gold);
      this.plate(socket, keyWidth - 7, 49, 23, 6, 1.6, this.dark, 6);
      const cap = new THREE.Group();
      cap.name = `bet-${bet}-cap`;
      socket.add(cap);
      const face = finish(0xffe9ba, .18, .19);
      this.addSheen(face);
      this.plate(cap, keyWidth - 13, 43, 21, 8, 4, face, 11);
      this.dome(cap, keyWidth - 13, 43, 6, face, 20);
      this.text(cap, `$${bet}`, 27, 68, 30, 7, 30, this.ink);
      this.text(cap, `${bet} ${bet === 1 ? 'LINE' : 'LINES'}`, 12.5, 75, 30, -13, 30, this.ink);
      this.diagram(cap, bet, -48, 0, 30);
      const lamp = this.mesh(new THREE.SphereGeometry(2.2, 10, 8), this.lampOff);
      lamp.position.set(keyWidth / 2 - 17, 12, 28);
      cap.add(lamp);
      this.keys.push({ bet, cap, face, lamp, disabled: false, pressedAt: -Infinity });
    });
    const badge = new THREE.Group();
    badge.position.set(bounds.x - 27, STAGE_HEIGHT - bounds.y - bounds.h / 2, 194);
    this.plate(badge, 43, 26, 5, 5, 1.3, this.gold);
    this.plate(badge, 37, 20, 3, 3, 1, this.dark, 4);
    this.text(badge, 'BET', 12, 31, 0, 0, 8, this.gold);
    this.group.add(badge);
    for (const line of ACTIVE_LINES[5]) this.makeMarker(line);
    for (const line of ACTIVE_LINES[5]) this.makeTrace(line);
    this.setState({ bet: 1, balance: 30, enabled: true, showLines: false, winningLines: [] }, 0);
    this.shineStarted = -Infinity;
  }

  private material<T extends THREE.Material>(material: T): T { this.materials.add(material); return material; }

  private mesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
    this.geometries.add(geometry);
    return new THREE.Mesh(geometry, material);
  }

  private addSheen(material: THREE.MeshPhysicalMaterial): void {
    material.onBeforeCompile = shader => {
      shader.uniforms.betSweepPosition = this.sweepPosition;
      shader.uniforms.betSweepStrength = this.sweepStrength;
      shader.vertexShader = 'varying vec3 vBetPosition;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvBetPosition = (modelMatrix * vec4(position, 1.)).xyz;');
      shader.fragmentShader = 'varying vec3 vBetPosition;\nuniform float betSweepPosition;\nuniform float betSweepStrength;\n' + shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float band = exp(-pow((vBetPosition.x + vBetPosition.y * .22 - betSweepPosition) / 13., 2.));
        totalEmissiveRadiance += vec3(1., .85, .5) * band * betSweepStrength;`);
    };
    material.customProgramCacheKey = () => 'bet-metal-sheen-v1';
  }

  private plate(parent: THREE.Group, width: number, height: number, radius: number, depth: number, bevel: number, material: THREE.Material, z = 0): THREE.Mesh {
    const x = -width / 2, y = -height / 2, r = Math.min(radius, height / 2);
    const shape = new THREE.Shape();
    shape.moveTo(x + r, y);
    shape.lineTo(x + width - r, y); shape.quadraticCurveTo(x + width, y, x + width, y + r);
    shape.lineTo(x + width, y + height - r); shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    shape.lineTo(x + r, y + height); shape.quadraticCurveTo(x, y + height, x, y + height - r);
    shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 10, steps: 1 });
    geometry.translate(0, 0, -depth / 2);
    const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, position.getX(i) / width + .5, position.getY(i) / height + .5);
    const mesh = this.mesh(geometry, material);
    mesh.position.z = z;
    parent.add(mesh);
    return mesh;
  }

  private text(parent: THREE.Group, label: string, height: number, width: number, x: number, y: number, z: number, material: THREE.Material): void {
    const mesh = this.lettering.make(label, height, width, 1.5);
    mesh.material = [material, this.dark];
    mesh.castShadow = false;
    mesh.position.set(x, y, z);
    parent.add(mesh);
  }

  private dome(parent: THREE.Group, width: number, height: number, rise: number, material: THREE.Material, z: number): THREE.Mesh {
    const columns = 40, rows = 20;
    const vertices: number[] = [], uv: number[] = [], indices: number[] = [];
    for (let row = 0; row <= rows; row++) {
      const v = row / rows * 2 - 1;
      const arc = Math.sqrt(Math.max(0, 1 - v * v));
      const halfWidth = width / 2 - height / 2 + height / 2 * arc;
      for (let column = 0; column <= columns; column++) {
        const u = column / columns * 2 - 1;
        vertices.push(u * halfWidth, v * height / 2, rise * arc * Math.sqrt(Math.max(0, 1 - u ** 8)));
        uv.push(column / columns, row / rows);
        if (row < rows && column < columns) {
          const a = row * (columns + 1) + column, b = a + columns + 1;
          indices.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    const mesh = this.mesh(geometry, material);
    mesh.position.z = z; parent.add(mesh);
    return mesh;
  }

  private wire(parent: THREE.Group, points: number[][], radius: number, material: THREE.Material): void {
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 1; i < points.length; i++) path.add(new THREE.LineCurve3(new THREE.Vector3(...points[i - 1]), new THREE.Vector3(...points[i])));
    parent.add(this.mesh(new THREE.TubeGeometry(path, Math.max(1, points.length - 1), radius, 6, false), material));
  }

  private diagram(parent: THREE.Group, bet: Bet, x: number, y: number, z: number): void {
    const diagram = new THREE.Group();
    diagram.position.set(x, y, z);
    parent.add(diagram);
    for (const offset of [-19, -6.3, 6.3, 19]) this.wire(diagram, [[offset, -15, 0], [offset, 15, 0]], .35, this.chrome);
    for (const offset of [-15, -5, 5, 15]) this.wire(diagram, [[-19, offset, 0], [19, offset, 0]], .35, this.chrome);
    const lines: Record<WinningLine, number[][]> = {
      top: [[-19, 11, 1], [19, 11, 1]], middle: [[-19, 0, 1], [19, 0, 1]], bottom: [[-19, -11, 1], [19, -11, 1]],
      diagonalDown: [[-19, 11, 1], [19, -11, 1]], diagonalUp: [[-19, -11, 1], [19, 11, 1]],
    };
    for (const line of ACTIVE_LINES[bet]) this.wire(diagram, lines[line], 1.15, this.ink);
  }

  private makeMarker(line: WinningLine): void {
    const group = new THREE.Group();
    group.name = `bet-marker-${line}`;
    const bounds = OVERLAYS.lineIndicators;
    group.position.set(bounds.x + bounds.w / 2, STAGE_HEIGHT - LINE_Y[line], 218);
    group.rotation.y = .06;
    this.group.add(group);
    this.plate(group, 87, 29, 5, 8, 2, this.gold);
    this.plate(group, 79, 22, 3, 4, 1.2, this.green, 6);
    const face = this.dome(group, 79, 22, 3, this.green, 10);
    const lettering = new THREE.Group();
    const bet = line === 'middle' ? 1 : line.startsWith('diagonal') ? 5 : 3;
    this.text(lettering, `$${bet}`, 19, 35, -5, 0, 16, this.gold);
    const dy = line === 'diagonalDown' ? -6 : line === 'diagonalUp' ? 6 : 0;
    const length = Math.hypot(14, dy * 2), ux = 14 / length, uy = dy * 2 / length;
    this.wire(lettering, [[20, -dy, 16], [34, dy, 16]], 1, this.gold);
    this.wire(lettering, [[34 - ux * 8 - uy * 5, dy - uy * 8 + ux * 5, 16], [34, dy, 16], [34 - ux * 8 + uy * 5, dy - uy * 8 - ux * 5, 16]], 1, this.gold);
    group.add(lettering);
    const lamp = this.mesh(new THREE.SphereGeometry(2.3, 10, 8), this.lampOff);
    lamp.position.set(-32, 0, 16);
    group.add(lamp);
    this.markers.push({ line, group, face, lettering, lamp });
  }

  private makeTrace(line: WinningLine): void {
    const top = 323.8, middle = 458.5, bottom = 593.2;
    const points = line === 'diagonalDown' ? [[248, LINE_Y[line]], [337, top], [526, middle], [715, bottom], [804, bottom]]
      : line === 'diagonalUp' ? [[248, LINE_Y[line]], [337, bottom], [526, middle], [715, top], [804, top]]
        : [[248, LINE_Y[line]], [804, LINE_Y[line]]];
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 1; i < points.length; i++) path.add(new THREE.LineCurve3(new THREE.Vector3(points[i - 1][0], STAGE_HEIGHT - points[i - 1][1], 226), new THREE.Vector3(points[i][0], STAGE_HEIGHT - points[i][1], 226)));
    const geometry = new THREE.TubeGeometry(path, 96, 1.25, 6, false);
    this.geometries.add(geometry);
    const core = this.material(new THREE.MeshBasicMaterial({ color: 0xffeeb8, transparent: true, depthWrite: false, toneMapped: false }));
    const halo = this.material(new THREE.MeshBasicMaterial({ color: 0xffb52b, transparent: true, opacity: .15, depthWrite: false, blending: THREE.AdditiveBlending }));
    const haloGeometry = new THREE.TubeGeometry(path, 96, 4, 6, false);
    const group = new THREE.Group();
    group.name = `bet-trace-${line}`;
    group.add(new THREE.Mesh(geometry, core), this.mesh(haloGeometry, halo));
    group.visible = false;
    this.group.add(group);
    this.traces.set(line, { group, geometry, core, halo, started: -Infinity });
  }

  setState(state: BetControlsState, now: number): boolean {
    const key = `${state.bet}|${state.balance}|${state.enabled}|${state.showLines}|${state.winningLines.join(',')}`;
    if (key === this.stateKey) return false;
    this.stateKey = key;
    if (state.bet !== this.selected) this.shineStarted = now;
    this.selected = state.bet;
    for (const button of this.keys) {
      button.disabled = !state.enabled || state.balance < button.bet;
      const active = button.bet === state.bet;
      button.face.color.set(button.disabled ? 0x8c826b : active ? 0xffc33f : 0xffe9ba);
      button.face.metalness = active ? .8 : .18;
      button.face.emissive.set(active && !button.disabled ? 0x7b4205 : 0x000000);
      button.face.emissiveIntensity = .2;
      button.lamp.material = active && !button.disabled ? this.lampOn : this.lampOff;
    }
    for (const marker of this.markers) {
      marker.group.visible = state.showLines;
      const active = ACTIVE_LINES[state.bet].includes(marker.line);
      marker.face.material = active ? this.gold : this.green;
      marker.lamp.material = active ? this.lampOn : this.lampOff;
      marker.lettering.traverse(node => {
        if (node instanceof THREE.Mesh) node.material = Array.isArray(node.material) ? [active ? this.ink : this.lightInk, this.dark] : active ? this.ink : this.lightInk;
      });
    }
    const winning = state.winningLines.join(',');
    if (winning && winning !== this.winningKey) this.winUntil = now + 650;
    this.winningKey = winning;
    if (!state.showLines) this.cancelPreview();
    return true;
  }

  hover(bet: Bet | null, now: number): boolean {
    if (bet === this.hovered) return false;
    this.hovered = bet;
    if (bet && !this.keys.find(key => key.bet === bet)?.disabled) this.shineStarted = now;
    return true;
  }

  press(bet: Bet, now: number): void {
    const button = this.keys.find(key => key.bet === bet)!;
    if (!button.disabled) { button.pressedAt = now; this.shineStarted = now; }
  }

  preview(lines: readonly WinningLine[], now: number): void {
    this.cancelPreview();
    lines.forEach((line, index) => { this.traces.get(line)!.started = now + index * 80; });
  }

  cancelPreview(): void {
    for (const trace of this.traces.values()) { trace.started = -Infinity; trace.group.visible = false; }
  }

  stop(): void {
    this.cancelPreview();
    this.shineStarted = -Infinity;
    this.winUntil = 0;
    this.hovered = null;
    for (const button of this.keys) button.pressedAt = -Infinity;
  }

  update(now: number, reducedMotion: boolean): boolean {
    if (reducedMotion) {
      this.cancelPreview();
      this.shineStarted = -Infinity;
      for (const button of this.keys) button.pressedAt = -Infinity;
    }
    const shine = (now - this.shineStarted) / 950;
    const shining = !reducedMotion && shine >= 0 && shine < 1;
    this.sweepPosition.value = shining ? 110 + shine * 830 : -1000;
    this.sweepStrength.value = shining ? Math.sin(shine * Math.PI) * 1.5 : 0;
    let animating = shining;
    for (const button of this.keys) {
      const pressed = (now - button.pressedAt) / 220;
      const pressing = !reducedMotion && pressed >= 0 && pressed < 1;
      button.cap.position.z = (button.bet === this.selected ? -2 : 0) - (pressing ? Math.sin(pressed * Math.PI) * 5 : 0);
      button.cap.rotation.y = button.bet === this.hovered && !button.disabled ? -.035 : 0;
      animating ||= pressing;
    }
    for (const marker of this.markers) {
      const winning = this.winningKey.split(',').includes(marker.line) && now < this.winUntil;
      marker.lamp.visible = !winning || reducedMotion || Math.sin(now / 55) > -.3;
      animating ||= winning && !reducedMotion;
    }
    for (const trace of this.traces.values()) {
      const progress = (now - trace.started) / 650;
      trace.group.visible = !reducedMotion && progress >= 0 && progress < 1;
      if (trace.group.visible) {
        const draw = 1 - (1 - Math.min(1, progress / .65)) ** 2;
        const count = Math.floor(trace.geometry.index!.count * draw / 3) * 3;
        trace.geometry.setDrawRange(0, count);
        (trace.group.children[1] as THREE.Mesh).geometry.setDrawRange(0, count);
        trace.core.opacity = Math.min(1, (1 - progress) / .35);
        trace.halo.opacity = trace.core.opacity * .15;
      }
      animating ||= !reducedMotion && Number.isFinite(trace.started) && progress < 1;
    }
    return animating;
  }

  dispose(): void {
    this.cancelPreview();
    this.geometries.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose());
    this.metalDetail.dispose();
    this.lettering.dispose();
  }
}
