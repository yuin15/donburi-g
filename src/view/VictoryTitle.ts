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
  private readonly face: THREE.ShaderMaterial;
  private readonly edge: THREE.MeshStandardMaterial;
  private readonly glints: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly glintPoints: THREE.Vector3[] = [];
  private readonly glintPose = new THREE.Object3D();

  constructor(lettering: SculptedType) {
    // The gold finish belongs only to YOU WIN; other cabinet labels keep theirs.
    this.text = lettering.make('YOU WIN!', 89, 570, 22, .06);
    this.text.name = 'victory-hero-title';
    this.text.geometry.computeBoundingBox();
    const bounds = this.text.geometry.boundingBox!;
    const width = bounds.max.x - bounds.min.x;
    const height = bounds.max.y - bounds.min.y;
    this.face = new THREE.ShaderMaterial({
      uniforms: {
        extent: { value: new THREE.Vector2(width, height) },
        progress: { value: 0 }, strength: { value: 0 },
      },
      vertexShader: `varying vec2 vMetal; uniform vec2 extent;
        void main(){vMetal=position.xy/extent+.5; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `varying vec2 vMetal; uniform float progress; uniform float strength;
        void main(){
          float y=clamp(vMetal.y+sin(vMetal.x*8.)*.025,0.,1.);
          vec3 gold=mix(vec3(.30,.075,.004),vec3(1.,.53,.025),smoothstep(0.,.17,y));
          gold=mix(gold,vec3(1.7,1.26,.34),smoothstep(.17,.36,y));
          gold=mix(gold,vec3(.37,.095,.008),smoothstep(.37,.47,y));
          gold=mix(gold,vec3(2.4,2.1,1.28),smoothstep(.47,.55,y));
          gold=mix(gold,vec3(1.15,.61,.065),smoothstep(.57,.79,y));
          gold=mix(gold,vec3(2.,1.7,.85),smoothstep(.80,1.,y));
          float sweepAt=-.3+fract(progress*1.7)*1.6;
          float distance=vMetal.x+vMetal.y*.16-sweepAt;
          float sweep=exp(-distance*distance*1500.);
          float broad=exp(-distance*distance*140.);
          vec2 cell=floor(vMetal*vec2(210.,34.));
          float seed=fract(sin(dot(cell,vec2(127.1,311.7)))*43758.5453);
          float fleck=step(.975,seed)*pow(max(0.,sin(progress*14.+seed*45.)),10.);
          gold+=(vec3(3.2,2.8,1.9)*sweep+vec3(.65,.34,.08)*broad+vec3(1.1,.85,.34)*fleck)*strength;
          gl_FragColor=vec4(gold,1.);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.edge = (this.text.material as THREE.MeshStandardMaterial[])[1].clone();
    this.edge.color.set(0xffc84b);
    this.edge.metalness = .94;
    this.edge.roughness = .13;
    this.edge.envMapIntensity = 2.2;
    this.text.material = [this.face, this.edge];
    this.glints = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec2 vUv;
        void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.);}`,
      fragmentShader: `varying vec2 vUv;
        void main(){vec2 p=abs(vUv*2.-1.);
          float core=exp(-dot(p,p)*32.);
          float star=pow(1.-p.x,32.)*pow(1.-p.y,1.8)+pow(1.-p.y,32.)*pow(1.-p.x,1.8);
          gl_FragColor=vec4(1.,.94,.68,min(1.,core+star));
        }`,
    }), 12);
    this.glints.name = 'victory-letter-glints';
    this.glints.frustumCulled = false;
    // Anchor each sparkle to actual front-face vertices, never the spaces between letters.
    const positions = this.text.geometry.getAttribute('position');
    const normals = this.text.geometry.getAttribute('normal');
    for (let i = 0; i < this.glints.count; i++) {
      const x = bounds.min.x + width * (.035 + i / 11 * .93);
      const y = i % 2 ? bounds.min.y : bounds.max.y;
      let closest = Infinity;
      const point = new THREE.Vector3();
      for (let vertex = 0; vertex < positions.count; vertex++) {
        if (normals.getZ(vertex) < .9) continue;
        const distance = (positions.getX(vertex) - x) ** 2 + (positions.getY(vertex) - y) ** 2;
        if (distance < closest) { closest = distance; point.fromBufferAttribute(positions, vertex); }
      }
      point.z = bounds.max.z + 2;
      this.glintPoints.push(point);
    }
    this.text.add(this.glints);
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

  makeHeading(): THREE.Mesh {
    const heading = new THREE.Mesh(this.text.geometry, [this.face, this.edge]);
    heading.name = 'sculpted-YOU WIN!';
    heading.castShadow = true;
    return heading;
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
    this.face.uniforms.progress.value = progress;
    this.face.uniforms.strength.value = shine;
    for (let i = 0; i < this.glints.count; i++) {
      const pulse = Math.max(0, Math.sin((progress * 2.4 + i * .21) * Math.PI * 2)) ** 8;
      this.glintPose.position.copy(this.glintPoints[i]);
      this.glintPose.scale.setScalar((2 + pulse * (i % 3 ? 19 : 27)) * shine);
      this.glintPose.rotation.z = i * .4;
      this.glintPose.updateMatrix();
      this.glints.setMatrixAt(i, this.glintPose.matrix);
    }
    this.glints.instanceMatrix.needsUpdate = true;
  }

  stop(): void { this.group.visible = false; this.face.uniforms.strength.value = 0; }

  dispose(): void {
    this.stop();
    this.backdrop.geometry.dispose(); this.backdrop.material.dispose();
    this.rays.geometry.dispose(); this.rays.material.dispose();
    this.face.dispose(); this.edge.dispose();
    this.glints.geometry.dispose(); this.glints.material.dispose(); this.glints.dispose();
    // Text geometry belongs to the shared SculptedType cache.
  }
}
