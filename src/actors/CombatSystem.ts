import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import { DestructionSystem } from '../world/DestructionSystem';
import { PrefabManager } from '../world/PrefabManager';
import { InventorySystem, weaponCapacity, type Firearm } from './InventorySystem';
import { LocomotionIK } from './LocomotionIK';
import { NPCController, type NPC } from './NPCController';
import type { BodyPart } from './HumanoidModel';
import { voxelShape } from '../world/VoxelSystem';
import { BloodParticles } from './BloodParticles';
import { MissileEffects } from './MissileEffects';

type Flash = { mesh: THREE.Mesh; age: number; life: number };
type BulletParticle = { from: THREE.Vector3; to: THREE.Vector3; age: number; life: number };
const MAX_BULLET_PARTICLES = 96;

export class CombatSystem {
  private cooldown = 0;
  private reloadTime = 0;
  private flashes: Flash[] = [];
  private raycaster = new THREE.Raycaster();
  private shotSequence = 0;
  private bulletParticles: BulletParticle[] = [];
  private bulletPositions = new Float32Array(MAX_BULLET_PARTICLES * 3);
  private bulletGeometry = new THREE.BufferGeometry();
  private bulletPoints = new THREE.Points(this.bulletGeometry,
    new THREE.PointsMaterial({ color: '#ffe7a4', size: 0.16, sizeAttenuation: true, depthWrite: false }));
  readonly blood: BloodParticles;
  readonly missiles: MissileEffects;

  constructor(
    private scene: THREE.Scene,
    private player: LocomotionIK,
    private inventory: InventorySystem,
    private npcs: NPCController,
    private destruction: DestructionSystem,
    private prefabs: PrefabManager,
    private events: EventBus
  ) {
    this.bulletGeometry.setAttribute('position', new THREE.BufferAttribute(this.bulletPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.bulletGeometry.setDrawRange(0, 0);
    this.bulletPoints.name = 'traveling-bullet-particles';
    this.bulletPoints.frustumCulled = false;
    scene.add(this.bulletPoints);
    this.blood = new BloodParticles(scene,(x,z,y)=>prefabs.supportHeight(x,z,y),prefabs.grid?.water);
    this.missiles = new MissileEffects(scene,(x,z,y)=>prefabs.supportHeight(x,z,y));
    this.events.on('blood', ({ x, y, z, dx, dy, dz, count, floor }) =>
      this.blood.emit(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz), count, floor));
  }

  get isReloading(): boolean { return this.reloadTime > 0; }
  get readyIn(): number { return Math.max(0, this.cooldown); }
  get activeBulletCount(): number { return this.bulletParticles.length; }

  update(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.blood.update(dt);
    this.missiles.update(dt);
    for (let index = this.bulletParticles.length - 1; index >= 0; index--) {
      const particle = this.bulletParticles[index];
      particle.age += dt;
      if (particle.age >= particle.life) this.bulletParticles.splice(index, 1);
    }
    for (let index = 0; index < this.bulletParticles.length; index++) {
      const particle = this.bulletParticles[index];
      const progress = particle.age / particle.life;
      const offset = index * 3;
      this.bulletPositions[offset] = THREE.MathUtils.lerp(particle.from.x, particle.to.x, progress);
      this.bulletPositions[offset + 1] = THREE.MathUtils.lerp(particle.from.y, particle.to.y, progress);
      this.bulletPositions[offset + 2] = THREE.MathUtils.lerp(particle.from.z, particle.to.z, progress);
    }
    this.bulletGeometry.setDrawRange(0, this.bulletParticles.length);
    if (this.bulletParticles.length) this.bulletGeometry.attributes.position.needsUpdate = true;
    if (this.reloadTime > 0) {
      this.reloadTime -= dt;
      if (this.reloadTime <= 0) {
        this.inventory.reload();
        this.events.emit('alert', { text: 'ARMA RECARGADA', tone: 'success' });
      }
    }
    for (const flash of this.flashes) {
      flash.age += dt;
      (flash.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - flash.age / flash.life);
    }
    this.flashes = this.flashes.filter((flash) => {
      if (flash.age < flash.life) return true;
      this.scene.remove(flash.mesh);
      (flash.mesh.material as THREE.Material).dispose();
      return false;
    });
  }

  startReload(): boolean {
    if (this.reloadTime > 0 || this.inventory.weapon === 'fists' || this.inventory.weapon === 'charge') return false;
    const weapon = this.inventory.weapon;
    const capacity = weaponCapacity[weapon];
    if (this.inventory.magazine[weapon] >= capacity || this.inventory.reserve[weapon] <= 0) return false;
    this.reloadTime = weapon === 'pistol' ? 1.1 : weapon === 'shotgun' ? 1.9 : weapon === 'rifle' ? 1.55 : 1.6;
    this.player.animateReload(this.reloadTime);
    return true;
  }

  fire(target: THREE.Vector3, directAim = false, ads = false, preciseAim = false,
    selectedPart: { npc: NPC; part: BodyPart; point: THREE.Vector3 } | null = null): string | null {
    const weapon = this.inventory.weapon;
    if (this.cooldown > 0 || this.reloadTime > 0) return null;
    const origin = this.player.group.position.clone().add(new THREE.Vector3(0, 1.78, 0));
    const aim = target.clone();
    if (weapon !== 'charge' && !directAim && !preciseAim && aim.y < this.player.group.position.y + 0.6) aim.y = this.player.group.position.y + 1.5;
    this.player.aimAt(aim);
    if (weapon === 'charge') {
      const direction = aim.clone().sub(origin);
      if (direction.lengthSq() < 0.01) direction.set(0, 0, 1);
      direction.normalize();
      this.cooldown = 0.95;
      this.player.animateFire();
      const muzzle = origin.clone().addScaledVector(direction, 0.62);
      this.muzzleFlash(muzzle, 0.38);
      this.missiles.launch(muzzle, direction, (point) => {
        this.npcs.hitByMissile(point, 4.2);
        this.destruction.blast(point.x, point.z, 4.2, 'player', point.y);
        this.missiles.explode(point, this.destruction.fireAnchors(point));
      }, (from, to) => this.missileHit(from, to));
      this.events.emit('gunshot', { x: origin.x, z: origin.z, radius: 29 });
      return 'MISIL LANZADO';
    }
    if (weapon === 'fists') {
      this.cooldown = 0.52;
      this.player.animateMelee();
      const npc = this.npcs.nearestToPoint(aim.x, aim.z, 1.3, this.player.group.position.y);
      if (npc && npc.group.position.distanceTo(this.player.group.position) < 3) {
        this.npcs.damage(npc, 0.72);
        return 'GOLPE CERTERO';
      }
      return null;
    }
    if (this.inventory.magazine[weapon] <= 0) return 'SIN MUNICIÓN · R PARA RECARGAR';
    const gun = weapon as Firearm;
    const maxRange = gun === 'rifle' ? 48 : gun === 'pistol' ? 29 : gun === 'shotgun' ? 16 : 28;
    const baseDirection = aim.clone().sub(origin).normalize();
    const pelletCount = gun === 'shotgun' ? 7 : 1;
    const spread = (gun === 'shotgun' ? 0.073 : gun === 'smg' ? 0.014 : gun === 'rifle' ? 0.005 : 0.009) * (ads ? 0.45 : 1);
    const side = new THREE.Vector3().crossVectors(baseDirection, new THREE.Vector3(0, 1, 0)).normalize();
    if (side.lengthSq() < 0.1) side.set(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(side, baseDirection).normalize();
    const visualMuzzle = origin.clone().addScaledVector(baseDirection, 0.92)
      .addScaledVector(side, directAim ? 0.19 : 0.3).add(new THREE.Vector3(0, directAim ? -0.22 : -0.32, 0));
    const interiorMeshes = this.prefabs.interiorMeshesNear(origin.x, origin.z, maxRange + 2);
    let message: string | null = null;
    const struck = new Map<NPC, { amount: number; part: BodyPart; point: THREE.Vector3 }>();
    for (let pellet = 0; pellet < pelletCount; pellet++) {
      // The central pellet follows the reticle exactly; the others spread
      // around it. This keeps a deliberately aimed limb hit dependable.
      const jitterX = pelletCount === 1 ? (Math.random() - 0.5) * spread : pellet === 0 ? 0 : Math.cos(pellet * 2.399 + this.shotSequence) * spread;
      const jitterY = pelletCount === 1 ? (Math.random() - 0.5) * spread : pellet === 0 ? 0 : Math.sin(pellet * 2.399 + this.shotSequence) * spread;
      const direction = baseDirection.clone().addScaledVector(side, jitterX).addScaledVector(up, jitterY).normalize();
      this.raycaster.set(origin, direction);
      this.raycaster.far = maxRange;
      const voxelHit = this.raycaster.intersectObject(this.prefabs.buildings, true).find((hit) => {
        const index = this.prefabs.voxelForHit(hit);
        return index !== null && this.prefabs.voxels[index]?.alive;
      });
      const interiorHit = this.raycaster.intersectObjects(interiorMeshes, false)[0];
      const npcHit = this.npcs.raycast(this.raycaster);
      const end = origin.clone().addScaledVector(direction, maxRange);
      const voxelDistance = voxelHit?.distance ?? Infinity;
      const npcDistance = npcHit?.distance ?? Infinity;
      const interiorDistance = interiorHit?.distance ?? Infinity;
      const damage = gun === 'rifle' ? 1.85 : gun === 'pistol' ? 1.16 : gun === 'shotgun' ? 0.39 : 0.44;
      if (npcHit && npcDistance < voxelDistance && npcDistance < interiorDistance) {
        const selected = pellet === 0 && selectedPart?.npc === npcHit.npc ? selectedPart : null;
        const hitPoint = selected?.point || npcHit.point;
        const hitPart = selected?.part || npcHit.part;
        end.copy(hitPoint);
        const previous = struck.get(npcHit.npc);
        if (previous) previous.amount += damage;
        else struck.set(npcHit.npc, { amount: damage, part: hitPart, point: hitPoint.clone() });
        // The hit point lies on the near surface: spray out toward the shooter
        // so the first particles do not start inside a body or the wall behind it.
        this.blood.emit(hitPoint, direction.clone().negate(), gun === 'shotgun' ? 6 : 11, npcHit.npc.group.position.y);
      } else if (interiorHit && interiorDistance < voxelDistance) {
        end.copy(interiorHit.point);
        const piece = this.prefabs.interiorPieceForHit(interiorHit);
        const sub = this.prefabs.interiorVoxelForHit(interiorHit);
        if (piece && sub !== null) this.destruction.damageInterior(piece, damage, sub);
      } else if (voxelHit) {
        end.copy(voxelHit.point);
        const index = this.prefabs.voxelForHit(voxelHit);
        const piece = this.prefabs.pieceForHit(voxelHit);
        if (index !== null && piece !== null) this.destruction.damageVoxel(index, damage * 0.75, piece);
      }
      this.launchBulletParticle(visualMuzzle, end);
    }
    for (const [npc, hit] of struck) {
      const limbHit = hit.part !== 'head' && hit.part !== 'torso';
      const defeated = this.npcs.damage(npc, hit.amount, hit.part, hit.point,
        gun === 'shotgun' && limbHit ? 2.2 : hit.amount);
      if (gun === 'shotgun' && hit.part === 'head') this.npcs.explodeHead(npc, baseDirection);
      message = defeated ? (npc.kind === 'enemy' ? 'AMENAZA NEUTRALIZADA' : 'CIVIL HERIDO') : 'IMPACTO CONFIRMADO';
    }
    this.shotSequence++;
    this.muzzleFlash(visualMuzzle, gun === 'rifle' || gun === 'shotgun' ? 0.36 : 0.26);
    this.inventory.magazine[gun]--;
    this.cooldown = gun === 'rifle' ? 0.16 : gun === 'shotgun' ? 0.82 : gun === 'pistol' ? 0.27 : 0.09;
    this.player.animateFire();
    this.events.emit('gunshot', { x: origin.x, z: origin.z, radius: gun === 'shotgun' ? 28 : gun === 'rifle' ? 24 : 19 });
    return message;
  }

  private missileHit(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 | null {
    const segment = to.clone().sub(from);
    const distance = segment.length();
    this.raycaster.set(from, segment.normalize());
    this.raycaster.near = 0;
    this.raycaster.far = distance;
    const voxelHit = this.raycaster.intersectObject(this.prefabs.buildings, true).find((hit) => {
      const index = this.prefabs.voxelForHit(hit);
      return index !== null && this.prefabs.voxels[index]?.alive;
    });
    const interiorHit = this.raycaster.intersectObjects(
      this.prefabs.interiorMeshesNear(from.x, from.z, distance + 3), false
    ).find((hit) => this.prefabs.interiorPieceForHit(hit)?.alive);
    const npcHit = this.npcs.raycast(this.raycaster);
    const hit = [voxelHit, interiorHit, npcHit].filter((candidate) => candidate)
      .sort((a, b) => a!.distance - b!.distance)[0];
    if (hit) return hit.point.clone();
    const floor = this.prefabs.supportHeight(to.x, to.z, from.y + 0.2);
    if (to.y <= floor + 0.08 && from.y > floor + 0.08) {
      const portion = THREE.MathUtils.clamp((from.y - floor - 0.08) / Math.max(0.001, from.y - to.y), 0, 1);
      return from.clone().lerp(to, portion);
    }
    return null;
  }

  enemyTracer(from: THREE.Vector3, target: THREE.Vector3, hit: boolean, heavy: boolean): void {
    const to = target.clone().add(new THREE.Vector3(hit ? 0 : 1.4, hit ? 0 : -0.55, hit ? 0 : -1.2));
    this.muzzleFlash(from, heavy ? 0.42 : 0.3);
    this.tracer(from, to, heavy ? '#ffe7a0' : '#ffb173', 0.13, heavy ? 0.075 : 0.055);
    if (hit) this.blood.emit(to, from.clone().sub(to), heavy ? 15 : 11, target.y - 1.4);
  }

  private muzzleFlash(position: THREE.Vector3, size: number): void {
    const mesh = voxelShape(size, size, size,
      new THREE.MeshBasicMaterial({ color: '#ffe5a0', transparent: true, opacity: 0.95, depthWrite: false }));
    mesh.position.copy(position);
    this.scene.add(mesh);
    this.flashes.push({ mesh, age: 0, life: 0.085 });
  }

  private launchBulletParticle(from: THREE.Vector3, to: THREE.Vector3): void {
    if (this.bulletParticles.length >= MAX_BULLET_PARTICLES) this.bulletParticles.shift();
    this.bulletParticles.push({ from: from.clone(), to: to.clone(), age: 0,
      life: THREE.MathUtils.clamp(from.distanceTo(to) / 145, 0.07, 0.31) });
    this.bulletGeometry.setDrawRange(0, this.bulletParticles.length);
  }

  private tracer(from: THREE.Vector3, to: THREE.Vector3, hex: string, life: number, width: number): void {
    const direction = to.clone().sub(from);
    if (direction.length() < 0.1) return;
    const mesh = voxelShape(width, width, direction.length(), new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.92, depthWrite: false }));
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize());
    this.scene.add(mesh);
    this.flashes.push({ mesh, age: 0, life });
  }
}
