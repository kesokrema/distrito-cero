import * as THREE from 'three';
import { VOXEL_SIZE } from '../world/VoxelConstants';
import { CANAL_SURFACE_Y, type CanalWater } from '../world/CanalWater';

type Particle = { position: THREE.Vector3; velocity: THREE.Vector3; age: number; life: number; size: number; floor: number };

/** Short lived voxel hit effects in one draw call, even for a full shotgun burst. */
export class BloodParticles {
  private readonly capacity = 224;
  private readonly particles: Particle[] = [];
  private readonly mesh: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private readonly waterCurrent = new THREE.Vector3();

  constructor(scene: THREE.Scene, private ground?: (x:number,z:number,y:number)=>number,
    private water?: CanalWater) {
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: '#d92e38', depthTest: true, depthWrite: true }),
      this.capacity
    );
    this.mesh.name = 'blood-particles';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  get activeCount(): number { return this.particles.length; }

  emit(point: THREE.Vector3, direction: THREE.Vector3, count: number, floor = 0): void {
    const outward = direction.clone().normalize();
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= this.capacity) this.particles.shift();
      const size = 0.11 + Math.random() * 0.09;
      const velocity = outward.clone().multiplyScalar(1.1 + Math.random() * 2.1)
        .add(new THREE.Vector3((Math.random() - 0.5) * 3.4, 1.4 + Math.random() * 2.9, (Math.random() - 0.5) * 3.4));
      this.particles.push({ position: point.clone().addScaledVector(outward, 0.09), velocity,
        age: 0, life: 0.68 + Math.random() * 0.28, size, floor });
    }
    this.writeInstances();
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.05);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];
      particle.age += dt;
      if (particle.age >= particle.life) { this.particles.splice(i, 1); continue; }
      const inWater=this.water?.currentAt(particle.position.x,particle.position.y,particle.position.z,this.waterCurrent)??false;
      if(inWater) {
        particle.velocity.x=THREE.MathUtils.lerp(particle.velocity.x,this.waterCurrent.x,Math.min(1,step*5));
        particle.velocity.z=THREE.MathUtils.lerp(particle.velocity.z,this.waterCurrent.z,Math.min(1,step*5));
      }
      particle.position.addScaledVector(particle.velocity, step);
      particle.velocity.y -= 13 * step;
      const surface = inWater ? CANAL_SURFACE_Y+0.04 :
        (this.ground?.(particle.position.x,particle.position.z,particle.position.y) ?? particle.floor) + (particle.floor > 0 ? VOXEL_SIZE : 0.08);
      if (particle.position.y < surface + particle.size / 2) {
        particle.position.y = surface + particle.size / 2;
        particle.velocity.y = 0;
        if(!inWater) { particle.velocity.x *= 0.45; particle.velocity.z *= 0.45; }
      }
    }
    this.writeInstances();
  }

  private writeInstances(): void {
    this.mesh.count = this.particles.length;
    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i];
      const fading = Math.min(1, (particle.life - particle.age) / 0.16);
      this.dummy.position.copy(particle.position);
      this.dummy.scale.setScalar(Math.max(0.001, particle.size * fading));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (this.particles.length) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
