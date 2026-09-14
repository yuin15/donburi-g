import * as THREE from 'three';
import { STAGE_HEIGHT, STAGE_WIDTH } from './StageLayout';
import type { SculptedType } from './SculptedType';

const ease = (value: number): number => {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

/** A single foreground title, driven by the existing three-second celebration. */
export class VictoryTitle {
  readonly group = new THREE.Group();
  private readonly text: THREE.Mesh;
  private readonly backdrop: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly rays: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly heroScale: number;
  private readonly destination = new THREE.Vector3();
  private readonly destinationRotation = new THREE.Quaternion();
  private readonly destinationScale = new THREE.Vector3();
  private readonly entranceRotation = new THREE.Euler();

  constructor(lettering: SculptedType) {
    // Shares the settled heading's geometry and gold/red materials.
    this.text = lettering.make('YOU WIN!', 89, 570, 22);
    this.text.name = 'victory-hero-title';
    this.text.geometry.computeBoundingBox();
    const bounds = this.text.geometry.boundingBox!;
    this.heroScale = STAGE_WIDTH * .86 / (bounds.max.x - bounds.min.x);
    this.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(STAGE_WIDTH, STAGE_HEIGHT),
      new THREE.MeshBasicMaterial({ color: 0x100608, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.backdrop.position.set(STAGE_WIDTH / 2, STAGE_HEIGHT / 2, 100);
    this.rays = new THREE.Mesh(new THREE.PlaneGeometry(STAGE_WIDTH, STAGE_HEIGHT), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { progress: { value: 0 }, strength: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `varying vec2 vUv; uniform float progress; uniform float strength;
        void main(){
          vec2 p=(vUv-vec2(.5,.53))*vec2(1.777,1.);
          float radius=length(p), angle=atan(p.y,p.x);
          float rays=pow(max(0.,cos(angle*18.+progress*2.)),14.);
          float reach=smoothstep(.08,.22,radius)*(1.-smoothstep(.48,.95,radius));
          float halo=exp(-radius*radius*11.);
          float ring=exp(-abs(radius-(.12+min(1.,progress*4.)*.72))*95.)*(1.-smoothstep(.06,.32,progress));
          vec3 gold=mix(vec3(1.,.40,.06),vec3(1.,.86,.42),halo);
          gl_FragColor=vec4(gold,(rays*reach*.48+halo*.22+ring*.6)*strength);
        }`,
    }));
    this.rays.position.set(STAGE_WIDTH / 2, STAGE_HEIGHT / 2, 700);
    this.group.name = 'victory-title-celebration';
    this.group.visible = false;
    this.group.add(this.backdrop, this.rays, this.text);
  }

  update(progress: number, target: THREE.Object3D): void {
    this.group.visible = true;
    // Arrive with one overshoot, hold, then dock exactly onto the result heading.
    const entrance = THREE.MathUtils.clamp(progress / .16, 0, 1);
    // Limit the overshoot to about 5%, keeping every letter inside the stage.
    const spring = 1 + 2.2 * (entrance - 1) ** 3 + 1.2 * (entrance - 1) ** 2;
    const dock = ease((progress - .74) / .26);
    const shine = ease(progress / .08) * (1 - ease((progress - .69) / .25));
    target.updateWorldMatrix(true, false);
    target.matrixWorld.decompose(this.destination, this.destinationRotation, this.destinationScale);
    this.text.position.set(STAGE_WIDTH / 2, STAGE_HEIGHT * .53, 840);
    this.text.position.lerp(this.destination, dock);
    const breath = 1 + Math.sin(progress * Math.PI * 4) * .008 * entrance;
    this.text.scale.setScalar(this.heroScale * (.15 + .85 * spring) * breath);
    this.text.scale.lerp(this.destinationScale, dock);
    this.entranceRotation.set(-.10 - (1 - entrance) * .5, (1 - entrance) * -.34, -.025);
    this.text.quaternion.setFromEuler(this.entranceRotation).slerp(this.destinationRotation, dock);
    this.backdrop.material.opacity = shine * .56;
    this.rays.material.uniforms.progress.value = progress;
    this.rays.material.uniforms.strength.value = shine;
  }

  stop(): void { this.group.visible = false; }

  dispose(): void {
    this.stop();
    this.backdrop.geometry.dispose(); this.backdrop.material.dispose();
    this.rays.geometry.dispose(); this.rays.material.dispose();
    // Text geometry and materials belong to the shared SculptedType cache.
  }
}
