import * as THREE from 'three';
import { FLOOR_HEIGHT, VOXEL_SIZE } from '../world/VoxelConstants';

type Spark = { position: THREE.Vector3; velocity: THREE.Vector3; age: number; life: number; size: number; color: THREE.Color; floor: number };
type Fire = { position: THREE.Vector3; life: number; clock: number; strength: number };
type Burst = { mesh: THREE.Mesh; light: THREE.PointLight; age: number };
type Missile = { mesh: THREE.Group; light: THREE.PointLight; age: number; direction: THREE.Vector3; speed: number; onHit: (point: THREE.Vector3) => void;
  hitTest: (from: THREE.Vector3, to: THREE.Vector3) => THREE.Vector3 | null };

/** Bounded, instanced missile smoke, sparks and lingering ground flames. */
export class MissileEffects {
  private readonly missiles: Missile[] = [];
  private readonly sparks: Spark[] = [];
  private readonly fires: Fire[] = [];
  private readonly bursts: Burst[] = [];
  private readonly particles = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ depthTest: true, depthWrite: true }), 256);
  private readonly groundFlames = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ depthTest: true, depthWrite: true }), 96);
  private readonly dummy = new THREE.Object3D();
  private readonly orange = new THREE.Color('#ff902e');
  private readonly yellow = new THREE.Color('#ffe27c');
  private readonly smoke = new THREE.Color('#504b49');

  constructor(private scene: THREE.Scene, private ground?: (x:number,z:number,y:number)=>number) {
    this.particles.name = 'missile-fire-particles';
    this.particles.count = 0;
    this.particles.frustumCulled = false;
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.particles);
    this.groundFlames.name = 'missile-ground-fire';
    this.groundFlames.count = 0;
    this.groundFlames.frustumCulled = false;
    this.groundFlames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.groundFlames);
  }

  launch(from: THREE.Vector3, direction: THREE.Vector3, onHit: (point: THREE.Vector3) => void,
    hitTest: (from: THREE.Vector3, to: THREE.Vector3) => THREE.Vector3 | null): void {
    const mesh = new THREE.Group();
    mesh.name = 'demolition-missile';
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.58),
      new THREE.MeshStandardMaterial({ color: '#4b5154', metalness: 0.65, roughness: 0.35 }));
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.22, 4),
      new THREE.MeshBasicMaterial({ color: '#ffd272' }));
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 0.38;
    const exhaust = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.32),
      new THREE.MeshBasicMaterial({ color: '#ff9a35' }));
    exhaust.position.z = -0.42;
    const light = new THREE.PointLight('#ff9d45', 26, 8, 2);
    light.position.z = -0.45;
    light.castShadow = false;
    mesh.add(body, nose, exhaust, light);
    mesh.position.copy(from);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.clone().normalize());
    this.scene.add(mesh);
    this.missiles.push({ mesh, light, age: 0, direction: direction.clone().normalize(), speed: 31, onHit, hitTest });
    if (this.missiles.length > 5) this.removeMissile(this.missiles[0]);
  }

  private removeMissile(missile: Missile): void {
    this.scene.remove(missile.mesh);
    missile.mesh.traverse((object) => {
      if (object instanceof THREE.Mesh) { object.geometry.dispose(); (object.material as THREE.Material).dispose(); }
    });
    this.missiles.splice(this.missiles.indexOf(missile), 1);
  }

  explode(point: THREE.Vector3, anchors: readonly THREE.Vector3[] = []): void {
    const floor = this.ground?.(point.x,point.z,point.y) ?? Math.max(0, Math.floor((point.y + 0.3) / FLOOR_HEIGHT) * FLOOR_HEIGHT);
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8),
      new THREE.MeshBasicMaterial({ color: '#ffbc50', transparent: true, opacity: 0.82, depthWrite: false }));
    flash.position.copy(point);
    const light = new THREE.PointLight('#ffe0a1', 90, 17, 2);
    light.position.copy(point);
    light.castShadow = false;
    this.scene.add(flash, light);
    this.bursts.push({ mesh: flash, light, age: 0 });
    if (this.bursts.length > 4) this.removeBurst(this.bursts.shift()!);
    for (let i = 0; i < 72; i++) {
      const angle = i * 2.399963 + Math.random() * 0.28;
      const speed = 3 + Math.random() * 11;
      this.addSpark(point, new THREE.Vector3(Math.cos(angle) * speed, 2 + Math.random() * 11,
        Math.sin(angle) * speed), 0.55 + Math.random() * 0.75, 0.12 + Math.random() * 0.32,
      i % 5 === 0 ? this.smoke : i % 3 === 0 ? this.yellow : this.orange, floor);
    }
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI * 2 / 8;
      const distance = i === 0 ? 0 : 0.9 + Math.random() * 2.2;
      const position = anchors[i]?.clone() || new THREE.Vector3(point.x + Math.cos(angle) * distance,
        0, point.z + Math.sin(angle) * distance);
      if (!anchors[i]) position.y = (this.ground?.(position.x, position.z, point.y + 0.25) ?? floor) + 0.12;
      this.fires.push({ position, life: 5 + Math.random() * 4,
        clock: 0, strength: 0.7 + Math.random() * 0.6 });
    }
    while (this.fires.length > 32) this.fires.shift();
  }

  private removeBurst(burst: Burst): void {
    this.scene.remove(burst.mesh, burst.light);
    burst.mesh.geometry.dispose();
    (burst.mesh.material as THREE.Material).dispose();
  }

  private addSpark(point: THREE.Vector3, velocity: THREE.Vector3, life: number, size: number,
    color: THREE.Color, floor: number): void {
    if (this.sparks.length >= 256) this.sparks.shift();
    this.sparks.push({ position: point.clone(), velocity, age: 0, life, size, color, floor });
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.05);
    for (const missile of [...this.missiles]) {
      const from = missile.mesh.position.clone();
      const to = from.clone().addScaledVector(missile.direction, missile.speed * step);
      const hit = missile.hitTest(from, to);
      if (hit) { this.removeMissile(missile); missile.onHit(hit); continue; }
      missile.mesh.position.copy(to);
      missile.age += step;
      missile.light.intensity = 24 + Math.sin(missile.age * 32) * 5;
      this.addSpark(missile.mesh.position, new THREE.Vector3((Math.random() - 0.5) * 0.7,
        0.5 + Math.random(), (Math.random() - 0.5) * 0.7), 0.35, 0.16,
      Math.random() < 0.5 ? this.smoke : this.orange, 0);
    }
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const fire = this.fires[i];
      fire.life -= dt;
      if (fire.life <= 0) { this.fires.splice(i, 1); continue; }
      fire.clock += dt;
      while (fire.clock > 0.095) {
        fire.clock -= 0.095;
        this.addSpark(fire.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0,
          (Math.random() - 0.5) * 0.6)), new THREE.Vector3((Math.random() - 0.5) * 0.8,
          1.3 + Math.random() * 1.8, (Math.random() - 0.5) * 0.8), 0.4 + Math.random() * 0.45,
        (0.18 + Math.random() * 0.24) * fire.strength, Math.random() < 0.3 ? this.yellow : this.orange,
        fire.position.y);
      }
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const spark = this.sparks[i];
      spark.age += dt;
      if (spark.age >= spark.life) { this.sparks.splice(i, 1); continue; }
      spark.position.addScaledVector(spark.velocity, step);
      spark.velocity.y -= spark.color === this.smoke ? -0.2 * step : 5 * step;
      const surface = (this.ground?.(spark.position.x,spark.position.z,spark.position.y) ?? spark.floor) + (spark.floor > 0 ? VOXEL_SIZE : 0.08);
      if (spark.position.y < surface + spark.size / 2) {
        spark.position.y = surface + spark.size / 2;
        spark.velocity.y = 0;
      }
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      burst.age += dt;
      burst.mesh.scale.setScalar(1 + burst.age * 7);
      (burst.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.82 - burst.age * 2.2);
      const fade = Math.max(0, 1 - burst.age / 0.55);
      burst.light.intensity = 90 * fade * fade;
      burst.light.color.copy(this.orange).lerp(this.yellow, fade);
      if (burst.age > 0.55) { this.removeBurst(burst); this.bursts.splice(i, 1); }
    }
    this.groundFlames.count = this.fires.length * 3;
    for (let i = 0; i < this.fires.length; i++) {
      const fire = this.fires[i];
      const fade = Math.min(1, fire.life / 0.7);
      for (let layer = 0; layer < 3; layer++) {
        const flicker = 0.8 + Math.sin(fire.life * 18 + i * 2.4 + layer) * 0.18;
        const width = (0.72 - layer * 0.16) * fire.strength * fade;
        const height = (0.16 + layer * 0.13) * flicker * fade;
        this.dummy.position.set(fire.position.x + (layer - 1) * 0.11,
          fire.position.y + height * 0.5 + layer * 0.1, fire.position.z + (layer % 2 ? 0.1 : -0.1));
        this.dummy.scale.set(width, Math.max(0.001, height), width * 0.72);
        this.dummy.updateMatrix();
        this.groundFlames.setMatrixAt(i * 3 + layer, this.dummy.matrix);
        this.groundFlames.setColorAt(i * 3 + layer, layer === 2 ? this.yellow : this.orange);
      }
    }
    this.groundFlames.instanceMatrix.needsUpdate = true;
    if (this.groundFlames.instanceColor) this.groundFlames.instanceColor.needsUpdate = true;
    this.particles.count = this.sparks.length;
    for (let i = 0; i < this.sparks.length; i++) {
      const spark = this.sparks[i];
      this.dummy.position.copy(spark.position);
      this.dummy.scale.setScalar(spark.size * Math.min(1, (spark.life - spark.age) * 4));
      this.dummy.updateMatrix();
      this.particles.setMatrixAt(i, this.dummy.matrix);
      this.particles.setColorAt(i, spark.color);
    }
    this.particles.instanceMatrix.needsUpdate = true;
    if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;
  }
}
