import { GroundPhysics } from '../engine/GroundPhysics';
import * as THREE from 'three';
import { ActorRenderBatch } from '../engine/ActorRenderBatch';
import { FLOOR_HEIGHT } from '../world/VoxelConstants';
import { EventBus } from '../core/EventBus';
import { GridSystem, type BlockBounds, type Cell } from '../world/GridSystem';
import { DestructionSystem } from '../world/DestructionSystem';
import { voxelShape } from '../world/VoxelSystem';
import { createHumanoid, type BodyPart } from './HumanoidModel';
import { setFaceExpression } from './FaceTextures';
import { createWeaponModel } from './WeaponModel';
import { PrefabManager } from '../world/PrefabManager';
import { SpatialHash } from '../core/SpatialHash';
import type { PathAvoidance } from '../core/Pathfinding';
import { RagdollSystem, type RagdollBody } from './RagdollSystem';
import { MixamoAnimationSystem, type MixamoState } from './MixamoAnimationSystem';

type State = 'commute' | 'flee' | 'hide' | 'patrol' | 'chase' | 'cover' | 'flank' | 'surrender';
type Kind = 'civilian' | 'enemy';
type CivilianRole = 'resident' | 'shopper' | 'worker' | 'visitor' | 'keeper';
type CharacterRig = { body: THREE.Group; hips: THREE.Group; head: THREE.Group; face: THREE.Mesh; torso: THREE.Group; arms: THREE.Group[]; elbows: THREE.Group[]; hands: THREE.Group[];
  legs: THREE.Group[]; knees: THREE.Group[]; feet: THREE.Group[]; bubble: THREE.Group; motion: number; phase: number;
  heavy: boolean; mount: THREE.Group; flash?: THREE.Mesh; parts: Partial<Record<BodyPart, THREE.Mesh>>;
  springs: Map<THREE.Object3D, THREE.Vector3> };
export type NPC = {
  id: number; kind: Kind; group: THREE.Group; state: State; home: Cell; work: Cell; target: Cell;
  path: number[]; pathIndex: number; speed: number; panic: number; stamina: number; loyalty: number;
  leader: boolean; memory: number; reroute: number; alive: boolean; direction: number;
  trespassTime: number; warned: boolean; needRest: number; hazardTime: number; shotTimer: number;
  pauseTime: number; knockdownTime: number; knockback: THREE.Vector3; pendingDeath: boolean;
  role: CivilianRole | 'guard'; marker: THREE.Sprite; markerTime: number;
  indoorAnchor?: THREE.Vector3; indoorGroup?: THREE.Group; indoorActivity?: number;
  ragdoll?: RagdollBody;
  wounds?: Partial<Record<BodyPart, number>>; missing?: Set<BodyPart>;
  woundMarks?: THREE.Mesh[]; bleedOutTime?: number; bleedFxClock?: number;
  fearTime?: number; hideTime?: number; hideTarget?: Cell;
  fleeSource?: THREE.Vector2;
  fleeFromPlayer?: boolean;
  socialExposure?: number;
  offDuty?: boolean;
  velocity?: THREE.Vector3; fireTime?: number; groundPhysics?:GroundPhysics;
  blockedMoveTime?: number;
  detourCell?: number;
};

export class NPCController {
  private readonly waterCurrent = new THREE.Vector3();
  readonly npcs: NPC[] = [];
  private worker: Worker;
  private requests = new Map<number, (path: number[]) => void>();
  private nextRequest = 1;
  private simulationTime = 0;
  private lastDanger = new THREE.Vector3();
  private blastCount = 0;
  private reactionSequence = 0;
  private leaderLost = false;
  private nextNpcId = 0;
  private populatedBlocks = new Set<string>();
  private latestRoutes = new Map<number, number>();
  private anchorLoad = new Map<number, number>();
  private destinationLoad = new Map<number, number>();
  private readonly fleeMarker = this.markerMaterial('!', '#e96854');
  private readonly enemyMarker = this.markerMaterial('×', '#d88336');
  private readonly woundMaterial = new THREE.MeshStandardMaterial({ color: '#df4543', roughness: 0.84 });
  private readonly spatial = new SpatialHash<NPC>(4, (npc) => npc.group.position);
  private readonly vehicleSpatial = new SpatialHash<THREE.Group>(8, (vehicle) => vehicle.position);
  private readonly hitProbe = new THREE.Vector3();
  private readonly actorBatch: ActorRenderBatch;
  private readonly mixamo = new MixamoAnimationSystem();
  private streetActivity = 1;

  setStreetActivity(activity: number): void { this.streetActivity = THREE.MathUtils.clamp(activity, 0.2, 1); }

  refreshSpatial(): void { this.spatial.rebuild(this.npcs.filter((npc) => npc.alive && !npc.ragdoll && !npc.offDuty &&
    (npc.group.position.distanceToSquared(this.player.position) < 18 * 18 ||
      this.prefabs.isWorldActive(npc.group.position.x, npc.group.position.z)))); }
  nearby(x: number, z: number, radius: number): NPC[] { return this.spatial.nearby(x, z, radius); }

  blocksPlayerAt(x: number, z: number): boolean {
    return this.spatial.nearby(x, z, 1.1).some((npc) => npc.alive && !npc.ragdoll &&
      Math.abs(npc.group.position.y - this.player.position.y) < 0.9 &&
      Math.hypot(npc.group.position.x - x, npc.group.position.z - z) < 0.92);
  }

  constructor(private scene: THREE.Scene, private grid: GridSystem, private events: EventBus, private destruction: DestructionSystem, private player: THREE.Object3D, private prefabs: PrefabManager, private ragdolls: RagdollSystem, activity = 1) {
    this.actorBatch = new ActorRenderBatch(scene);
    this.streetActivity = activity;
    void this.mixamo.load();
    this.worker = new Worker(new URL('../workers/path.worker.ts', import.meta.url), { type: 'module' });
    this.worker.postMessage({ type: 'init', size: grid.size,...grid.navigationData(grid.activeCells) });
    this.worker.onmessage = (event: MessageEvent<{ id: number; path: number[] }>) => {
      this.requests.get(event.data.id)?.(event.data.path);
      this.requests.delete(event.data.id);
    };
    this.spawn();
    this.events.on('terrainChanged', ({ cells }) => {
      const changed = [...new Set(cells)];
      if (!changed.length) return;
      this.worker.postMessage({ type: 'update',...grid.navigationData(changed.map(index=>grid.cells[index])) });
      const affected = new Set(changed);
      this.npcs.forEach((npc) => {
        if (npc.path.some((index) => affected.has(index%(grid.size*grid.size))) || affected.has(grid.index(npc.target.x, npc.target.z))) npc.reroute = 0;
      });
    });
    this.events.on('blast', ({ x, z, radius, source }) => {
      this.lastDanger.set(x, 0, z);
      if (source === 'player') this.blastCount++;
      for (const npc of this.npcs) {
        if (!npc.alive) continue;
        const distance = Math.hypot(npc.group.position.x - x, npc.group.position.z - z);
        if (distance < radius) {
          if (npc.kind === 'civilian') {
            npc.panic = Math.max(npc.panic, 0.75 + (1 - distance / radius) * 0.25);
            npc.state = 'flee';
            npc.fearTime = Math.max(npc.fearTime || 0, 0.9);
            this.flee(npc, x, z);
          } else if (distance < 2.1) {
            npc.stamina -= 0.7;
            if (npc.stamina <= 0) this.remove(npc);
          } else npc.state = 'chase';
        }
      }
    });
    this.events.on('environment', ({ x, z, kind }) => {
      for (const npc of this.npcs) {
        if (!npc.alive || Math.hypot(npc.group.position.x - x, npc.group.position.z - z) > 7) continue;
        if (npc.kind === 'civilian') { npc.state = 'flee'; npc.panic = Math.max(npc.panic, kind === 'electric' ? 0.9 : 0.5); this.flee(npc, x, z); }
        else { npc.hazardTime = 5; if (kind === 'electric') { npc.stamina -= 0.4; if (npc.stamina <= 0) this.remove(npc); } }
      }
    });
    this.events.on('gunshot', ({ x, z, radius }) => {
      // Player weapons emit this event. Keep the actual shooter as the danger
      // source even when the muzzle sits off-center or the player is moving.
      const sourceX = this.player.position.x, sourceZ = this.player.position.z;
      this.reactionSequence++;
      this.lastDanger.set(sourceX, 0, sourceZ);
      for (const npc of this.npcs) {
        if (!npc.alive) continue;
        const distance = Math.hypot(npc.group.position.x - x, npc.group.position.z - z);
        if (distance > radius) continue;
        if (npc.kind === 'civilian') {
          if (npc.state === 'flee' || npc.state === 'hide' || npc.panic >= 0.15) continue;
          const courage = this.grid.hash(npc.id, 918, 55);
          const startle = this.grid.hash(npc.id, this.reactionSequence, 911);
          npc.state = 'flee'; npc.panic = Math.max(npc.panic, 0.38 + (1 - distance / radius) * 0.4);
          // Different people freeze for different lengths of time before they run.
          npc.fearTime = startle < 0.24 ? 1.05 + courage * 0.45 : 0.32 + courage * 0.42;
          this.flee(npc, sourceX, sourceZ, true, true);
        } else if (npc.state !== 'surrender') npc.state = 'chase';
      }
    });
  }

  raycast(raycaster: THREE.Raycaster): { npc: NPC; point: THREE.Vector3; distance: number; part: BodyPart } | null {
    raycaster.layers.enable(31);
    let best: { npc: NPC; point: THREE.Vector3; distance: number; part: BodyPart } | null = null;
    for (const npc of this.npcs) {
      if (!npc.alive) continue;
      if (!npc.ragdoll && npc.group.parent !== this.scene &&
          !this.prefabs.isWorldActive(npc.group.position.x, npc.group.position.z)) continue;
      const center = npc.ragdoll ? this.ragdolls.pelvis(npc.ragdoll) : npc.group.position;
      this.hitProbe.set(center.x, center.y + (npc.ragdoll ? 0.5 : 1.2), center.z);
      if (raycaster.ray.distanceSqToPoint(this.hitProbe) > (npc.ragdoll ? 10 : 5)) continue;
      if (npc.ragdoll) {
        const hit = this.ragdolls.raycast(raycaster, npc.ragdoll);
        if (hit && (!best || hit.distance < best.distance)) best = { npc, ...hit };
        continue;
      }
      if (!npc.group.visible) continue;
      const rig = npc.group.userData.rig as CharacterRig;
      const hittable = Object.values(rig.parts).filter((mesh): mesh is THREE.Mesh =>
        Boolean(mesh?.visible && !npc.missing?.has(mesh.userData.bodyPart as BodyPart)));
      const hit = raycaster.intersectObjects(hittable, false)[0];
      if (hit && (!best || hit.distance < best.distance)) best = { npc, point: hit.point, distance: hit.distance, part: hit.object.userData.bodyPart as BodyPart };
    }
    return best;
  }

  /** A weapon held on a visible character is a threat even without firing. */
  intimidate(npc: NPC, source: THREE.Vector3): boolean {
    if (!npc.alive || npc.ragdoll) return false;
    if (npc.kind === 'enemy') {
      if (npc.state === 'surrender') return false;
      npc.fearTime = Math.max(npc.fearTime || 0, 0.72);
      if (!npc.leader && npc.group.position.distanceTo(source) < 14) {
        npc.state = 'surrender';
        npc.path = [];
        npc.shotTimer = Math.max(npc.shotTimer, 2);
      } else {
        npc.state = 'cover';
        npc.reroute = 0;
      }
      return true;
    }
    npc.panic = Math.max(npc.panic, 0.72);
    npc.markerTime = Math.max(npc.markerTime, 3.5);
    if (npc.state === 'flee' || npc.state === 'hide') return false;
    npc.fearTime = Math.max(npc.fearTime || 0, 0.72);
    npc.state = 'flee';
    this.lastDanger.copy(source);
    this.flee(npc, source.x, source.z, true, true);
    return true;
  }

  nearestToPoint(x: number, z: number, radius: number, y = 0): NPC | null {
    let best: NPC | null = null;
    let distance = radius;
    for (const npc of this.npcs) {
      if (!npc.alive || Math.abs(npc.group.position.y - y) > 1) continue;
      const current = Math.hypot(npc.group.position.x - x, npc.group.position.z - z);
      if (current < distance) { best = npc; distance = current; }
    }
    return best;
  }

  damage(npc: NPC, amount: number, part: BodyPart = 'torso', point?: THREE.Vector3, limbTrauma = amount): boolean {
    if (!npc.alive) return false;
    const healthScale = part === 'head' ? 4.5 : part === 'torso' ? 1 : 0.75;
    npc.stamina -= amount * healthScale;
    npc.state = npc.kind === 'enemy' ?
      (npc.missing && [...npc.missing].some((missing) => missing.includes('Arm') || missing.includes('Forearm')) ? 'surrender' : 'chase') : 'flee';
    npc.fearTime = Math.max(npc.fearTime || 0, 0.45);
    if (npc.kind === 'civilian') { npc.panic = Math.max(npc.panic, 0.85); this.flee(npc, this.player.position.x, this.player.position.z); }
    const impulse = (point || npc.group.position).clone().sub(this.player.position).setY(1.6).normalize().multiplyScalar(3.1 + amount);
    if (!npc.ragdoll) {
      npc.ragdoll = this.ragdolls.spawn(npc.group.position, npc.group.rotation.y, impulse,
        npc.group.userData.ragdollColors, Math.round((npc.group.position.y-this.grid.terrain.height(npc.group.position.x,npc.group.position.z))/FLOOR_HEIGHT), 1, 25, npc.missing, this.ragdollPose(npc));
      npc.group.visible = false;
      npc.marker.visible = false;
    } else this.ragdolls.impact(npc.ragdoll, point || npc.ragdoll.joints[2].position, impulse);
    npc.knockdownTime = Math.max(npc.knockdownTime, 1.55 + Math.min(0.8, amount * 0.28));
    npc.path = [];
    if (part !== 'head' && part !== 'torso') {
      const wounds = npc.wounds ||= {};
      wounds[part] = (wounds[part] || 0) + limbTrauma;
      const rig = npc.group.userData.rig as CharacterRig;
      const mesh = rig.parts[part];
      if (mesh) mesh.material = this.woundMaterial;
      this.ragdolls.wound(npc.ragdoll, part);
      if (wounds[part]! >= 2.2 && !(npc.missing ||= new Set()).has(part)) {
        npc.missing.add(part);
        if (part.endsWith('UpperArm')) npc.missing.add(part.replace('UpperArm', 'Forearm') as BodyPart);
        if (part.endsWith('Thigh')) npc.missing.add(part.replace('Thigh', 'Shin') as BodyPart);
        const left = part.startsWith('left'), index = left ? 0 : 1;
        if (part.endsWith('UpperArm')) rig.arms[index].visible = false;
        else if (part.endsWith('Forearm')) rig.elbows[index].visible = false;
        else if (part.endsWith('Thigh')) rig.legs[index].visible = false;
        else if (part.endsWith('Shin')) rig.knees[index].visible = false;
        this.ragdolls.detach(npc.ragdoll, part, impulse);
        this.markWound(npc, part);
        npc.bleedOutTime = Math.min(npc.bleedOutTime ?? Infinity, part.includes('Thigh') || part.includes('Shin') ? 29 : 23);
        npc.bleedFxClock = 0;
        this.emitWoundBlood(npc, 12);
        if (part.includes('Thigh') || part.includes('Shin')) {
          npc.knockdownTime = Infinity;
          npc.ragdoll.crawling = true;
          npc.ragdoll.crawlAge = 0;
          npc.ragdoll.life = Infinity;
        } else if (npc.kind === 'enemy') {
          rig.mount.visible = false;
          npc.shotTimer = Infinity;
          npc.state = 'surrender';
        }
      }
    }
    if (npc.stamina <= 0) { this.remove(npc); return true; }
    return false;
  }

  explodeHead(npc: NPC, shotDirection: THREE.Vector3): void {
    if (!npc.ragdoll || npc.missing?.has('head')) return;
    const position = this.ragdolls.explodeHead(npc.ragdoll);
    (npc.missing ||= new Set()).add('head');
    const direction = shotDirection.clone().normalize();
    for (let burst = 0; burst < 4; burst++) {
      const angle = burst * Math.PI / 2;
      const outward = new THREE.Vector3(Math.cos(angle) * 0.75, 0.5 + burst * 0.12,
        Math.sin(angle) * 0.75).addScaledVector(direction, 1.4);
      this.events.emit('blood', { x: position.x, y: position.y, z: position.z,
        dx: outward.x, dy: outward.y, dz: outward.z, count: 19,
        floor: this.prefabs.supportHeight(position.x,position.z,position.y) });
    }
    if (npc.alive) this.remove(npc);
  }

  hitByMissile(center: THREE.Vector3, radius: number): void {
    const limbs: BodyPart[] = ['leftUpperArm', 'rightUpperArm', 'leftThigh', 'rightThigh'];
    for (const npc of this.npcs) {
      if (!npc.alive) continue;
      const position = npc.ragdoll ? this.ragdolls.pelvis(npc.ragdoll) : npc.group.position;
      const distance = Math.hypot(position.x - center.x, position.z - center.z,
        (position.y + 1 - center.y) * 0.55);
      if (distance > radius) continue;
      const outward = new THREE.Vector3(position.x - center.x, 0, position.z - center.z);
      if (outward.lengthSq() < 0.05) outward.set(Math.cos(npc.id * 2.4), 0, Math.sin(npc.id * 2.4));
      outward.normalize();
      const strength = 10 + (1 - distance / radius) * 7;
      const launch = outward.clone().multiplyScalar(strength).setY(7 + strength * 0.38);
      if (!npc.ragdoll) {
        npc.ragdoll = this.ragdolls.spawn(npc.group.position, npc.group.rotation.y, new THREE.Vector3(),
          npc.group.userData.ragdollColors, Math.round((npc.group.position.y-this.grid.terrain.height(npc.group.position.x,npc.group.position.z))/FLOOR_HEIGHT),
          1, 20, npc.missing, this.ragdollPose(npc));
        npc.group.visible = false;
        npc.marker.visible = false;
      }
      for (const part of limbs) {
        if (npc.missing?.has(part)) continue;
        const separate = outward.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0),
          part.startsWith('left') ? -0.7 : 0.7).multiplyScalar(strength * 1.3);
        separate.y = 5 + Math.random() * 5;
        this.ragdolls.detach(npc.ragdoll, part, separate);
        (npc.missing ||= new Set()).add(part);
        this.events.emit('blood', { x: position.x, y: position.y + 1.1, z: position.z,
          dx: separate.x, dy: separate.y, dz: separate.z, count: 25, floor: position.y });
      }
      this.ragdolls.launch(npc.ragdoll, launch);
      this.remove(npc, launch);
    }
  }

  private hasLostLeg(npc: NPC): boolean {
    return !!npc.missing && [...npc.missing].some((part) => part.includes('Thigh') || part.includes('Shin'));
  }

  private hasLostArm(npc: NPC): boolean {
    return !!npc.missing && [...npc.missing].some((part) => part.includes('Arm') || part.includes('Forearm'));
  }

  private markWound(npc: NPC, part: BodyPart): void {
    const rig = npc.group.userData.rig as CharacterRig;
    const left = part.startsWith('left'), index = left ? 0 : 1, side = left ? -1 : 1;
    let parent: THREE.Group, x = 0, y = 0, z = 0.03;
    if (part.endsWith('UpperArm')) { parent = rig.torso; x = side * 0.42; y = 0.24; }
    else if (part.endsWith('Forearm')) { parent = rig.arms[index]; y = -0.46; }
    else if (part.endsWith('Thigh')) { parent = rig.hips; x = side * 0.17; y = -0.01; }
    else if (part.endsWith('Shin')) { parent = rig.legs[index]; y = -0.66; }
    else return;
    const stump = voxelShape(0.25, 0.16, 0.26, this.woundMaterial);
    stump.name = 'wound-stain'; stump.position.set(x, y, z);
    parent.add(stump);
    (npc.woundMarks ||= []).push(stump);
    const stain = voxelShape(0.18, 0.19, 0.06, this.woundMaterial);
    stain.name = 'wound-stain';
    if (part.includes('Arm') || part.includes('Forearm')) { stain.position.set(side * 0.21, 0.21, 0.205); rig.torso.add(stain); }
    else { stain.position.set(side * 0.17, -0.04, 0.2); rig.hips.add(stain); }
    npc.woundMarks.push(stain);
  }

  private emitWoundBlood(npc: NPC, count: number): void {
    const point = npc.ragdoll ? this.ragdolls.woundPosition(npc.ragdoll) :
      npc.woundMarks?.[0]?.getWorldPosition(new THREE.Vector3()) || npc.group.position;
    const phase = this.simulationTime * 11 + npc.id * 1.77;
    this.events.emit('blood', { x: point.x, y: point.y, z: point.z,
      dx: Math.sin(phase) * 0.3, dy: -0.35, dz: Math.cos(phase) * 0.3,
      count, floor: npc.group.position.y });
  }

  private updateBleeding(npc: NPC, dt: number): void {
    if (npc.bleedOutTime === undefined) return;
    npc.bleedOutTime = Math.max(0, npc.bleedOutTime - dt);
    npc.stamina -= dt * (this.hasLostLeg(npc) ? 0.13 : 0.09);
    if (npc.bleedOutTime === 0 || npc.stamina <= 0) { this.remove(npc); return; }
    npc.bleedFxClock = (npc.bleedFxClock || 0) + dt;
    if (npc.bleedFxClock >= 0.26) {
      npc.bleedFxClock %= 0.26;
      const point = npc.ragdoll ? this.ragdolls.pelvis(npc.ragdoll) : npc.group.position;
      if (point.distanceToSquared(this.player.position) < 70 * 70) this.emitWoundBlood(npc, 2);
    }
  }

  private ragdollPose(npc: NPC): THREE.Vector3[] {
    const rig = npc.group.userData.rig as CharacterRig;
    npc.group.updateWorldMatrix(true, true);
    const world = (object: THREE.Object3D): THREE.Vector3 => object.getWorldPosition(new THREE.Vector3());
    const pelvis = world(rig.legs[0]).add(world(rig.legs[1])).multiplyScalar(0.5);
    const chest = world(rig.torso);
    const upperTorso = rig.torso.localToWorld(new THREE.Vector3(0, 0.16, 0));
    return [pelvis, chest, upperTorso, world(rig.head),
      world(rig.arms[0]), world(rig.elbows[0]), world(rig.hands[0]),
      world(rig.arms[1]), world(rig.elbows[1]), world(rig.hands[1]),
      world(rig.legs[0]), world(rig.knees[0]), world(rig.feet[0]),
      world(rig.legs[1]), world(rig.knees[1]), world(rig.feet[1])];
  }

  private markerMaterial(symbol: string, background: string): THREE.SpriteMaterial {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d')!;
    context.fillStyle = background;
    context.beginPath(); context.arc(64, 60, 43, 0, Math.PI * 2); context.fill();
    context.lineWidth = 6; context.strokeStyle = '#fff4d7'; context.stroke();
    context.fillStyle = '#fffaf0'; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.font = 'bold 76px Arial'; context.fillText(symbol, 64, symbol === '!' ? 66 : 61);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    return new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  }

  private addMarker(group: THREE.Group, enemy: boolean): THREE.Sprite {
    const marker = new THREE.Sprite(enemy ? this.enemyMarker : this.fleeMarker);
    marker.position.set(0, enemy ? 3.02 : 2.82, 0);
    marker.scale.set(0.76, 0.76, 1);
    marker.visible = enemy;
    marker.userData.marker = true;
    group.add(marker);
    return marker;
  }

  private character(hex: string, heavy = false, armed = false): THREE.Group {
    const variant = this.nextNpcId;
    const skinColors = ['#efc9a7', '#dfae83', '#a87959', '#f1d2b3', '#c6946c'];
    const hairColors = ['#27323a', '#654331', '#bd8c4d', '#31292c', '#916b47', '#263d55'];
    const pantsColors = ['#354654', '#3d5272', '#557686', '#574e4a', '#41585b', '#7a6b58'];
    const accentColors = ['#fff1d8', '#f3c75b', '#7ee0d3', '#e6907a', '#a9d1d0', '#e9ddbc'];
    const outfit = {
      shirt: hex,
      accent: heavy ? '#f5c76e' : accentColors[variant % accentColors.length],
      pants: heavy ? '#46545c' : pantsColors[(variant * 3) % pantsColors.length],
      shoes: variant % 4 === 0 ? '#ecf1dc' : variant % 4 === 1 ? '#2a3d49' : '#3c4347',
      skin: skinColors[(variant * 7) % skinColors.length],
      hair: heavy ? '#493a32' : hairColors[(variant * 5) % hairColors.length],
      style: variant + (heavy ? 3 : 0)
    };
    const model = createHumanoid(outfit);
    const group = model.root;
    if (heavy) {
      model.arms[1].wrist.remove(model.weaponMount);
      model.torso.add(model.weaponMount);
      model.weaponMount.position.set(0, -0.30, 0.20);
    }
    if (armed) model.weaponMount.add(createWeaponModel(heavy ? 'rifle' : 'pistol'));
    const flash = armed ? voxelShape(heavy ? 0.32 : 0.24, heavy ? 0.32 : 0.24, 0.24,
      new THREE.MeshBasicMaterial({ color: '#ffe7a1', transparent: true, opacity: 0.9, depthWrite: false })) : undefined;
    if (flash) { flash.position.z = heavy ? 1.76 : 0.88; flash.visible = false; model.weaponMount.add(flash); }
    const bubble = new THREE.Group(); bubble.position.y = 3.38; bubble.visible = false;
    bubble.add(voxelShape(0.66, 0.39, 0.12, new THREE.MeshBasicMaterial({ color: '#fff1c9' })));
    group.add(bubble);
    const parts: Partial<Record<BodyPart, THREE.Mesh>> = {};
    group.traverse((object) => { if (object instanceof THREE.Mesh && object.userData.bodyPart) parts[object.userData.bodyPart as BodyPart] = object; });
    group.userData.rig = {
      body: model.body, hips: model.hips, head: model.head, face: model.face, torso: model.torso, arms: model.arms.map((arm) => arm.shoulder),
      elbows: model.arms.map((arm) => arm.elbow), hands: model.arms.map((arm) => arm.wrist),
      legs: model.legs.map((leg) => leg.hip), knees: model.legs.map((leg) => leg.knee),
      feet: model.legs.map((leg) => leg.foot), bubble, motion: 0, phase: 0, heavy, mount: model.weaponMount,
      flash, parts, springs: new Map()
    } satisfies CharacterRig;
    this.actorBatch?.add(group);
    group.userData.ragdollColors = { shirt: outfit.shirt, pants: outfit.pants, skin: outfit.skin, shoes: outfit.shoes };
    return group;
  }

  private spawn(): void {
    for (const key of this.grid.activeBlocks) {
      const [bx, bz] = key.split(':').map(Number);
      this.populateBlock(this.grid.blockBounds(bx, bz));
    }
    const candidates = this.grid.openCells().filter((cell) => cell.tile === 'sidewalk' && (cell.district === 'industrial' || cell.district === 'commercial'));
    candidates.sort((a, b) => this.grid.hash(a.x, a.z, 330) - this.grid.hash(b.x, b.z, 330));
    for (const cell of candidates) {
      if (this.enemies >= 6) break;
      const [x, z] = this.grid.world(cell.x, cell.z);
      if (Math.hypot(x - this.player.position.x, z - this.player.position.z) < 28) continue;
      if (this.npcs.some((npc) => npc.kind === 'enemy' && npc.group.position.distanceToSquared(new THREE.Vector3(x, 0, z)) < 9 * 9)) continue;
      this.spawnGuard(cell, this.enemies === 0);
    }
  }

  populateBlock(bounds: BlockBounds): void {
    const key = bounds.bx + ':' + bounds.bz;
    if (this.populatedBlocks.has(key)) return;
    this.populatedBlocks.add(key);
    this.pruneDistantCivilians();
    const district = this.grid.districtAt(Math.floor((bounds.x0 + bounds.x1) / 2), Math.floor((bounds.z0 + bounds.z1) / 2));
    const profile = this.grid.blockProfile(bounds.bx, bounds.bz);
    const local: Cell[] = [];
    for (let z = bounds.z0; z < bounds.z1; z++) for (let x = bounds.x0; x < bounds.x1; x++) {
      const cell = this.grid.cell(x, z)!;
      if (!cell.blocked && (cell.tile === 'sidewalk' || cell.tile === 'park')) local.push(cell);
    }
    const localAnchors = this.prefabs.pedestrianAnchors.filter((anchor) => anchor.cell.x >= bounds.x0 && anchor.cell.x < bounds.x1 && anchor.cell.z >= bounds.z0 && anchor.cell.z < bounds.z1);
    const publicAnchors = this.prefabs.publicAnchors.filter((anchor) => anchor.cell.active && !anchor.cell.blocked &&
      anchor.cell.x >= bounds.x0 && anchor.cell.x < bounds.x1 && anchor.cell.z >= bounds.z0 && anchor.cell.z < bounds.z1);
    local.sort((a, b) => {
      const appeal = (cell: Cell) => {
        const proximity = localAnchors.length ? Math.min(...localAnchors.map((anchor) => Math.abs(anchor.cell.x - cell.x) + Math.abs(anchor.cell.z - cell.z))) : Math.abs(cell.x - (bounds.x0 + bounds.x1) / 2) + Math.abs(cell.z - (bounds.z0 + bounds.z1) / 2);
        return proximity * 0.55 + this.grid.hash(cell.x, cell.z, 177) * 4;
      };
      return appeal(a) - appeal(b);
    });
    for (const anchor of publicAnchors.slice(0, 2).reverse()) {
      const index = local.indexOf(anchor.cell);
      if (index >= 0) { local.splice(index, 1); local.unshift(anchor.cell); }
    }
    const counts = { commercial: 3, residential: 3, industrial: 1, park: 2 };
    const daytimeCount = counts[district] + Number(profile.form === 'pocket' || profile.form === 'courtyard' && district !== 'industrial') +
      Number(this.grid.hash(bounds.bx, bounds.bz, 178) > 0.72);
    const count = Math.max(1, Math.round(daytimeCount * this.streetActivity));
    const colors = ['#f0a976', '#72b8b3', '#efc568', '#dd8398', '#91a4db', '#b5cc7e'];
    let added = 0;
    for (const cell of local) {
      if (added >= count) break;
      const [x, z] = this.grid.world(cell.x, cell.z);
      const position = new THREE.Vector3(x, 0, z);
      if (position.distanceTo(this.player.position) < 4.5) continue;
      if (this.prefabs.vehicles.some((vehicle) => vehicle.position.distanceToSquared(position) < 3.5 * 3.5)) continue;
      const spacing = added % 3 === 1 ? 2.1 : 3.7;
      if (this.npcs.some((npc) => npc.alive && npc.kind === 'civilian' && npc.group.position.distanceToSquared(position) < spacing * spacing)) continue;
      const activity = publicAnchors.find((anchor) => anchor.cell === cell)?.activity;
      const role: CivilianRole = activity === 'rest' || cell.tile === 'park' ? 'visitor' :
        activity === 'browse' ? 'shopper' : district === 'residential' ? 'resident' : district === 'industrial' || added % 4 === 0 ? 'worker' : 'shopper';
      const home = this.closestAnchor(cell, ['house', 'apartment']) || cell;
      const work = activity || district === 'park' ? cell : this.closestAnchor(cell, district === 'industrial' ? ['factory', 'workshop'] : ['shop', 'hotel', 'workshop', 'factory']) || cell;
      const id = this.nextNpcId++;
      const group = this.character(colors[id % colors.length]);
      group.position.set(x, this.grid.groundHeight(x,z), z);
      group.rotation.y = this.grid.hash(cell.x, cell.z, 182) * Math.PI * 2;
      this.scene.add(group);
      const pause = activity ? 13 + this.grid.hash(cell.x, cell.z, 181) * 14 :
        added % 3 === 2 ? 0 : (role === 'visitor' ? 8 : role === 'shopper' ? 6 : 4) + this.grid.hash(cell.x, cell.z, 181) * 5;
      const npc: NPC = { id, kind: 'civilian', role, group, state: 'commute', home, work, target: work, path: [], pathIndex: 0, speed: 1.45 + this.grid.hash(id, added, 180) * 0.65, panic: 0, stamina: 4.5, loyalty: 0, leader: false, memory: 0, reroute: 0, alive: true, direction: 1, trespassTime: 0, warned: false, needRest: this.grid.hash(id, added, 183) * 0.35, hazardTime: 0, shotTimer: 0, pauseTime: pause, knockdownTime: 0, knockback: new THREE.Vector3(), pendingDeath: false, marker: this.addMarker(group, false), markerTime: 0 };
      this.npcs.push(npc);
      this.route(npc, work);
      added++;
    }
    if (this.grid.activeBlocks.size > 9 && district === 'industrial' && this.grid.hash(bounds.bx, bounds.bz, 331) > 0.65 && this.enemies < 14) {
      const guardCell = local.find((cell) => {
        const [x, z] = this.grid.world(cell.x, cell.z);
        const point = new THREE.Vector3(x, 0, z);
        return this.npcs.every((npc) => npc.kind !== 'civilian' || npc.group.position.distanceToSquared(point) > 25);
      });
      if (guardCell) this.spawnGuard(guardCell, false);
    }
    for (const station of this.prefabs.interiorStations) {
      if (Math.abs(station.position.y-this.grid.terrain.height(station.position.x,station.position.z))<.1 && !['shop', 'reception', 'workshop', 'rest'].includes(station.kind)) continue;
      const room = station.room;
      if (room.x0 < bounds.x0 || room.x0 >= bounds.x1 || room.z0 < bounds.z0 || room.z0 >= bounds.z1) continue;
      if (room.x1 - room.x0 < 4 || room.z1 - room.z0 < 4 || this.grid.hash(room.x0, room.z0, 335 + Math.round(station.position.y)) > (station.position.y ? 0.8 : 0.55)) continue;
      const cell = this.grid.cell(room.x0 + Math.floor((room.x1 - room.x0) / 2), room.z0 + 1);
      if (!cell?.active || cell.blocked) continue;
      const [x, z] = this.grid.world(cell.x, cell.z);
      if (this.npcs.some((npc) => npc.alive && Math.hypot(npc.group.position.x - x, npc.group.position.z - z, npc.group.position.y - station.position.y) < 1.4)) continue;
      const id = this.nextNpcId++;
      const group = this.character(station.kind === 'rest' ? '#a8b6d0' : station.kind === 'workshop' ? '#6ca9a0' : '#e7b77a');
      group.position.set(x, station.position.y, z);
      group.rotation.y = Math.PI;
      this.scene.add(group);
      const npc: NPC = { id, kind: 'civilian', role: 'keeper', group, state: 'commute', home: cell, work: cell, target: cell, path: [], pathIndex: 0, speed: 1.4, panic: 0, stamina: 4.5, loyalty: 0, leader: false, memory: 0, reroute: 0, alive: true, direction: 1, trespassTime: 0, warned: false, needRest: 0, hazardTime: 0, shotTimer: 0, pauseTime: 26 + this.grid.hash(room.x0, room.z0, 336) * 24, knockdownTime: 0, knockback: new THREE.Vector3(), pendingDeath: false, marker: this.addMarker(group, false), markerTime: 0 };
      if (station.position.y > this.grid.terrain.height(station.position.x,station.position.z)+.1) {
        npc.indoorAnchor = group.position.clone();
        npc.indoorGroup = station.group.parent as THREE.Group;
        npc.indoorActivity = Math.floor(this.grid.hash(room.x0, room.z0, 540 + Math.round(station.position.y)) * 3);
      }
      this.npcs.push(npc);
    }
  }

  private closestAnchor(origin: Cell, types: string[]): Cell | undefined {
    const anchors = this.prefabs.pedestrianAnchors.filter((anchor) => types.includes(anchor.type) && anchor.cell.active && !anchor.cell.blocked);
    anchors.sort((a, b) => {
      const score = (cell: Cell) => {
        const index = this.grid.index(cell.x, cell.z);
        return (Math.abs(cell.x - origin.x) + Math.abs(cell.z - origin.z)) * 0.7 + (this.anchorLoad.get(index) || 0) * 5 + this.grid.hash(origin.x + cell.x, origin.z + cell.z, 220) * 3;
      };
      return score(a.cell) - score(b.cell);
    });
    const anchor = anchors[0]?.cell;
    if (!anchor) return undefined;
    const anchorIndex = this.grid.index(anchor.x, anchor.z);
    this.anchorLoad.set(anchorIndex, (this.anchorLoad.get(anchorIndex) || 0) + 1);
    const nearby: Cell[] = [];
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) + Math.abs(dz) > 2) continue;
      const cell = this.grid.cell(anchor.x + dx, anchor.z + dz);
      if (cell?.active && !cell.blocked && (cell.tile === 'sidewalk' || cell.tile === 'lot' || cell.tile === 'park')) nearby.push(cell);
    }
    nearby.sort((a, b) => {
      const score = (cell: Cell) => {
        const index = this.grid.index(cell.x, cell.z);
        return (Math.abs(cell.x - anchor.x) + Math.abs(cell.z - anchor.z)) * 0.7 + (this.destinationLoad.get(index) || 0) * 4 + this.grid.hash(origin.x + cell.x, origin.z + cell.z, 221) * 1.5;
      };
      return score(a) - score(b);
    });
    const destination = nearby[0] || anchor;
    const index = this.grid.index(destination.x, destination.z);
    this.destinationLoad.set(index, (this.destinationLoad.get(index) || 0) + 1);
    return destination;
  }

  private pruneDistantCivilians(): void {
    const civilians = this.npcs.filter((npc) => npc.kind === 'civilian' && npc.alive);
    if (civilians.length < 125) return;
    const far = civilians.filter((npc) => npc.group.position.distanceToSquared(this.player.position) > 115 * 115).sort((a, b) => b.group.position.distanceToSquared(this.player.position) - a.group.position.distanceToSquared(this.player.position));
    for (const npc of far.slice(0, Math.max(0, civilians.length - 105))) {
      if (npc.ragdoll) this.ragdolls.remove(npc.ragdoll);
      npc.alive = false;
      this.scene.remove(npc.group);
      this.latestRoutes.delete(npc.id);
      this.npcs.splice(this.npcs.indexOf(npc), 1);
    }
  }

  private spawnGuard(cell: Cell, leader: boolean): void {
    const [x, z] = this.grid.world(cell.x, cell.z);
    if (this.npcs.some((npc) => npc.alive && Math.hypot(npc.group.position.x - x, npc.group.position.z - z) < 1.5)) return;
    const group = this.character(leader ? '#f0ac3f' : '#c78345', leader, true);
    group.position.set(x, this.grid.groundHeight(x,z), z); this.scene.add(group);
    const npc: NPC = { id: this.nextNpcId++, kind: 'enemy', role: 'guard', group, state: 'patrol', home: cell, work: cell, target: cell, path: [], pathIndex: 0, speed: leader ? 2.3 : 2.7, panic: 0, stamina: leader ? 8 : 5.5, loyalty: this.grid.random(), leader, memory: 0, reroute: 0, alive: true, direction: 1, trespassTime: 0, warned: false, needRest: 0, hazardTime: 0, shotTimer: 2 + this.grid.random() * 2, pauseTime: 0, knockdownTime: 0, knockback: new THREE.Vector3(), pendingDeath: false, marker: this.addMarker(group, true), markerTime: 0 };
    this.npcs.push(npc);
  }

  private route(npc: NPC, target: Cell, avoid?: PathAvoidance): void {
    if (!npc.alive) return;
    npc.target = target;
    npc.reroute = 2 + this.grid.random();
    const start = this.grid.navigationIndex(npc.group.position.x,npc.group.position.z,npc.group.position.y);
    const id = this.nextRequest++;
    this.latestRoutes.set(npc.id, id);
    this.requests.set(id, (path) => { if (npc.alive && this.latestRoutes.get(npc.id) === id) { npc.path = path; npc.pathIndex = 0; } });
    this.worker.postMessage({ type: 'path', id, start, goal: this.grid.index(target.x, target.z), avoid });
  }

  private flee(npc: NPC, x: number, z: number, showMarker = true, followPlayer = false): void {
    npc.pauseTime = 0;
    if (showMarker) npc.markerTime = 3.5;
    npc.fleeSource ||= new THREE.Vector2();
    npc.fleeSource.set(x, z);
    npc.fleeFromPlayer = followPlayer;
    const [gx, gz] = this.grid.grid(npc.group.position.x, npc.group.position.z);
    const away = new THREE.Vector2(npc.group.position.x - x, npc.group.position.z - z);
    if (away.lengthSq() < 0.01) away.set(npc.id % 2 ? 1 : -1, npc.id % 3 ? 0.35 : -0.35);
    away.normalize();
    let best: Cell | undefined, bestScore = -Infinity, sheltered = false;
    let fallback: Cell | undefined, fallbackScore = -Infinity;
    // Select a reachable-looking goal in the outward half of the local area.
    // Cover helps only after the goal is on the safe side of the shooter.
    for (let dz = -8; dz <= 8; dz += 2) for (let dx = -8; dx <= 8; dx += 2) {
      const cell = this.grid.cell(gx + dx, gz + dz);
      if (!cell?.active || cell.blocked || cell.rubble || !this.grid.walkable(...this.grid.world(cell.x, cell.z))) continue;
      const [wx, wz] = this.grid.world(cell.x, cell.z);
      const travelX = wx - npc.group.position.x, travelZ = wz - npc.group.position.z;
      const travel = Math.hypot(travelX, travelZ);
      const progress = travelX * away.x + travelZ * away.y;
      const distanceGain = Math.hypot(wx - x, wz - z) - Math.hypot(npc.group.position.x - x, npc.group.position.z - z);
      const cover = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([cx, cz]) => this.grid.cell(cell.x + cx, cell.z + cz)?.blocked);
      const caution = this.grid.hash(npc.id, 918, 55);
      const score = progress * 1.25 + distanceGain * 0.35 - travel * 0.18 + (cover ? 1.8 + caution * 3.1 : 0) + this.grid.hash(cell.x, cell.z, npc.id) * 0.4;
      if (score > fallbackScore) { fallbackScore = score; fallback = cell; }
      if (progress < Math.max(this.grid.cellSize * 0.3, travel * 0.12)) continue;
      if (score > bestScore) { bestScore = score; best = cell; sheltered = cover; }
    }
    const goal = best || fallback || npc.home;
    npc.hideTarget = best && sheltered ? best : undefined;
    const [sourceX, sourceZ] = this.grid.grid(x, z);
    this.route(npc, goal, { x: sourceX, z: sourceZ, radius: 12 });
  }

  private remove(npc: NPC, impulse?: THREE.Vector3): void {
    if (!npc.alive) return;
    if (npc.ragdoll) { npc.ragdoll.crawling = false; npc.ragdoll.life = npc.ragdoll.age + 20; }
    else {
      const outward = impulse || new THREE.Vector3(npc.group.position.x - this.player.position.x, 1.1, npc.group.position.z - this.player.position.z).normalize().multiplyScalar(2.1);
      npc.ragdoll = this.ragdolls.spawn(npc.group.position, npc.group.rotation.y, outward,
        npc.group.userData.ragdollColors, Math.round((npc.group.position.y-this.grid.terrain.height(npc.group.position.x,npc.group.position.z))/FLOOR_HEIGHT), 1, 20, npc.missing, this.ragdollPose(npc));
    }
    if (npc.ragdoll) this.ragdolls.setExpression(npc.ragdoll, 'dead');
    npc.alive = false;
    this.latestRoutes.delete(npc.id);
    this.scene.remove(npc.group);
    if (npc.leader) this.leaderLost = true;
    this.events.emit('npcLost', { kind: npc.kind, leader: npc.leader });
  }

  hitByVehicle(npc: NPC, force: number, heading: THREE.Vector3): void {
    if (!npc.alive || npc.knockdownTime > 0) return;
    npc.stamina -= force;
    const direction = heading.clone().setY(0).normalize();
    this.events.emit('blood', { x: npc.group.position.x, y: npc.group.position.y + 1.05, z: npc.group.position.z,
      dx: direction.x * Math.min(3, force), dy: 1.3, dz: direction.z * Math.min(3, force),
      count: THREE.MathUtils.clamp(Math.round(force * 5), 7, 22), floor: npc.group.position.y });
    npc.pendingDeath = npc.stamina <= 0;
    npc.knockdownTime = 1.5;
    npc.knockback.copy(direction).multiplyScalar(5.5);
    npc.path = [];
    npc.pauseTime = 0;
    if (npc.kind === 'civilian') {
      npc.panic = 1;
      npc.state = 'flee';
      npc.markerTime = 3.5;
      for (const other of this.npcs) {
        if (other.kind !== 'civilian' || !other.alive || other === npc) continue;
        if (other.group.position.distanceToSquared(npc.group.position) < 80) {
          other.panic = Math.max(other.panic, 0.6);
          other.state = 'flee';
          this.flee(other, npc.group.position.x, npc.group.position.z);
        }
      }
    } else npc.state = 'chase';
    if (npc.pendingDeath) this.remove(npc, npc.knockback.clone().setY(2.8));
    else {
      npc.ragdoll = this.ragdolls.spawn(npc.group.position, npc.group.rotation.y, npc.knockback.clone().setY(2.8),
        npc.group.userData.ragdollColors, Math.round((npc.group.position.y-this.grid.terrain.height(npc.group.position.x,npc.group.position.z))/FLOOR_HEIGHT), 1, 3, npc.missing, this.ragdollPose(npc));
      npc.group.visible = false;
      npc.marker.visible = false;
    }
  }

  update(dt: number): void {
    this.simulationTime += dt;
    this.refreshSpatial();
    this.vehicleSpatial.rebuild(this.prefabs.vehicles.filter((vehicle) => !vehicle.userData.destroyed && !vehicle.userData.offDutyTraffic &&
      (vehicle.position.distanceToSquared(this.player.position) < 18 * 18 ||
        this.prefabs.isWorldActive(vehicle.position.x, vehicle.position.z))));
    const playerPosition = this.player.position;
    for (const npc of this.npcs) {
      if (!npc.alive) continue;
      const distanceSquared = npc.group.position.distanceToSquared(playerPosition);
      if (npc.kind === 'civilian' && !npc.indoorAnchor && !npc.ragdoll && npc.state !== 'flee' && npc.panic < 0.2) {
        const presence = this.grid.hash(npc.id, 0, 817);
        npc.offDuty = presence > this.streetActivity && distanceSquared > 18 * 18;
      }
      if (npc.state === 'flee' || npc.panic >= 0.2) npc.offDuty = false;
      if (npc.offDuty) {
        if (npc.group.parent === this.scene) this.scene.remove(npc.group);
        npc.marker.visible = false;
        continue;
      }
      if (distanceSquared > 18 * 18 && !this.prefabs.isWorldActive(npc.group.position.x, npc.group.position.z)) {
        if (npc.group.parent === this.scene) this.scene.remove(npc.group);
        npc.marker.visible = false;
        continue;
      }
      this.updateBleeding(npc, dt);
      if (!npc.alive) continue;
      if (npc.ragdoll) {
        if (!this.ragdolls.active(npc.ragdoll)) { this.remove(npc); continue; }
        if (this.hasLostLeg(npc)) {
          npc.ragdoll.crawling = true;
          npc.ragdoll.life = Infinity;
          const pelvis = this.ragdolls.pelvis(npc.ragdoll);
          const away = pelvis.clone().sub(playerPosition).setY(0);
          if (away.lengthSq() > 0.01) this.ragdolls.setCrawlDirection(npc.ragdoll, away);
          npc.group.position.set(pelvis.x, this.prefabs.supportHeight(pelvis.x,pelvis.z,pelvis.y), pelvis.z);
          continue;
        }
        npc.knockdownTime = Math.max(0, npc.knockdownTime - dt);
        if (npc.knockdownTime === 0 && !npc.ragdoll.recovery) this.ragdolls.startRecovery(npc.ragdoll, npc.group.rotation.y);
        if (this.ragdolls.recoveryFinished(npc.ragdoll)) {
          const resting = this.ragdolls.pelvis(npc.ragdoll);
          npc.group.position.set(resting.x, npc.ragdoll.recovery!.anchor.y, resting.z);
          npc.groundPhysics?.reset();
          npc.group.rotation.z = 0;
          const rig = npc.group.userData.rig as CharacterRig;
          rig.hips.position.y = 1.32;
          rig.hips.rotation.set(0, 0, 0);
          rig.torso.position.y = 0.16;
          rig.body.rotation.set(0, 0, 0);
          rig.torso.rotation.set(0, 0, 0);
          rig.arms.forEach((arm) => arm.rotation.set(0, 0, 0));
          rig.elbows.forEach((elbow) => elbow.rotation.set(0, 0, 0));
          rig.legs.forEach((leg) => leg.rotation.set(0, 0, 0));
          rig.knees.forEach((knee) => knee.rotation.set(0, 0, 0));
          rig.springs.clear();
          npc.group.visible = true;
          this.ragdolls.remove(npc.ragdoll);
          npc.ragdoll = undefined;
          npc.velocity?.set(0, 0, 0);
          npc.reroute = 0;
          if (this.hasLostArm(npc)) { npc.state = 'flee'; this.flee(npc, playerPosition.x, playerPosition.z); }
          else if (npc.kind === 'civilian') this.flee(npc, this.lastDanger.x, this.lastDanger.z);
        }
        continue;
      }
      if(this.grid.water.currentAt(npc.group.position.x,npc.group.position.y,npc.group.position.z,this.waterCurrent)) {
        npc.group.position.addScaledVector(this.waterCurrent,dt);
        npc.velocity ||= new THREE.Vector3();
        npc.velocity.copy(this.waterCurrent);
        this.spatial.update(npc);
        this.animate(npc,npc.group.userData.rig as CharacterRig,dt,true,false);
        continue;
      }
      const playerNearby = npc.kind === 'civilian' && Math.abs(npc.group.position.y - playerPosition.y) < 1.3 &&
        distanceSquared < 14 * 14;
      if (distanceSquared < 155 * 155) {
        if (npc.group.parent !== this.scene) this.scene.add(npc.group);
      } else if (npc.group.parent === this.scene) this.scene.remove(npc.group);
      if (npc.indoorGroup) npc.group.visible = npc.indoorGroup.visible && npc.indoorGroup.parent?.visible !== false && npc.indoorGroup.parent?.parent?.visible !== false;
      npc.markerTime = Math.max(0, npc.markerTime - dt);
      npc.fearTime = Math.max(0, (npc.fearTime || 0) - dt);
      npc.fireTime = Math.max(0, (npc.fireTime || 0) - dt);
      npc.marker.visible = npc.kind === 'enemy' ? distanceSquared < 65 * 65 : npc.markerTime > 0 && npc.state === 'flee';
      if (distanceSquared > 140 * 140) {
        if (npc.kind === 'civilian') {
          npc.panic = Math.max(0, npc.panic - dt * 0.024);
          if (npc.panic < 0.15 && (npc.state === 'flee' || npc.state === 'hide')) {
            npc.state = 'commute';
            npc.path = []; npc.pathIndex = 0; npc.reroute = 0;
            npc.hideTarget = undefined;
            npc.fleeFromPlayer = false;
          }
        }
        continue;
      }
      if (npc.indoorAnchor) {
        if (!this.prefabs.upperFloorPresent(npc.indoorAnchor.x, npc.indoorAnchor.z, Math.round((npc.indoorAnchor.y-this.grid.terrain.height(npc.indoorAnchor.x,npc.indoorAnchor.z))/FLOOR_HEIGHT))) {
          this.remove(npc);
          continue;
        }
        const active = npc.state === 'flee';
        if (active) {
          npc.panic = Math.max(playerNearby ? 0.46 : 0, npc.panic - dt * 0.028);
          if (npc.panic < 0.15) npc.state = 'commute';
        }
        const pacing = npc.indoorActivity === 1 && !active;
        npc.group.position.x = npc.indoorAnchor.x + (pacing ? Math.sin(this.simulationTime * 0.72 + npc.id) * 0.38 : 0);
        npc.group.position.z = npc.indoorAnchor.z + (active ? Math.sin(this.simulationTime * 2.5 + npc.id) * 0.3 : 0);
        if (pacing) npc.group.rotation.y = Math.cos(this.simulationTime * 0.72 + npc.id) > 0 ? Math.PI / 2 : -Math.PI / 2;
        this.animate(npc, npc.group.userData.rig as CharacterRig, dt, pacing, npc.indoorActivity === 2 && !active);
        npc.group.position.y = npc.indoorAnchor.y;
        continue;
      }
      npc.reroute -= dt;
      if (this.hasLostArm(npc)) {
        npc.state = 'flee';
        npc.shotTimer = Infinity;
        if (npc.reroute <= 0 || npc.pathIndex >= npc.path.length) this.flee(npc, playerPosition.x, playerPosition.z);
        this.move(npc, dt);
        continue;
      }
      if (npc.pauseTime > 0 && npc.kind === 'civilian' && npc.state !== 'flee') {
        npc.pauseTime = Math.max(0, npc.pauseTime - dt);
        this.move(npc, dt);
        continue;
      }
      npc.hazardTime = Math.max(0, npc.hazardTime - dt);
      npc.shotTimer = Math.max(0, npc.shotTimer - dt);
      if (npc.kind === 'civilian') {
        npc.needRest = Math.min(1, npc.needRest + dt * 0.0013);
        if (npc.state === 'hide' && playerNearby && distanceSquared < 8 * 8) {
          npc.state = 'flee';
          npc.hideTime = 0;
          this.flee(npc, playerPosition.x, playerPosition.z, false, true);
        }
        if (npc.state === 'hide') {
          npc.hideTime = Math.max(0, (npc.hideTime || 0) - dt);
          npc.panic = Math.max(playerNearby ? 0.46 : 0, npc.panic - dt * 0.09);
          if (npc.hideTime === 0) {
            npc.state = npc.panic > 0.3 ? 'flee' : 'commute';
            if (npc.state === 'flee') this.flee(npc, this.lastDanger.x, this.lastDanger.z);
            else this.route(npc, npc.work);
          }
        } else if (npc.state === 'flee') {
          npc.panic = Math.max(playerNearby ? 0.46 : 0, npc.panic - dt * 0.024);
          if (npc.panic < 0.15) { npc.state = 'commute'; this.route(npc, npc.work); }
          else if (npc.fleeFromPlayer && npc.fleeSource && npc.reroute <= 0 &&
                   Math.hypot(npc.fleeSource.x - playerPosition.x, npc.fleeSource.y - playerPosition.z) > 4) {
            this.flee(npc, playerPosition.x, playerPosition.z, false, true);
          }
          else if (playerNearby && npc.pathIndex >= npc.path.length && npc.reroute <= 0) {
            this.flee(npc, playerPosition.x, playerPosition.z, false, true);
          }
        } else if (npc.pathIndex >= npc.path.length && npc.reroute <= 0) {
          npc.direction *= -1;
          if (npc.direction > 0) npc.needRest = Math.max(0, npc.needRest - 0.55);
          this.route(npc, npc.direction > 0 ? npc.work : npc.home);
        }
      } else {
        const distance = npc.group.position.distanceTo(playerPosition);
        const playerCell = this.grid.cellAtWorld(playerPosition.x, playerPosition.z);
        const restricted = playerCell?.district === 'industrial' && playerCell.tile === 'lot';
        if (restricted && distance < 9 && this.blastCount === 0) {
          npc.trespassTime += dt;
          if (npc.trespassTime > 2 && !npc.warned) {
            npc.warned = true;
            this.events.emit('alert', { text: 'ZONA RESTRINGIDA · ABANDONA EL DISTRITO INDUSTRIAL', tone: 'danger' });
          }
        } else npc.trespassTime = Math.max(0, npc.trespassTime - dt * 2);
        if (this.leaderLost && npc.loyalty < 0.32) { npc.state = 'surrender'; npc.path = []; }
        else if ((this.blastCount > 0 && distance < 18) || npc.trespassTime > 7 || npc.state === 'chase') {
          npc.state = this.blastCount >= 3 && distance < 9 && npc.loyalty > 0.45 ? 'cover' :
            distance < 13 || (distance < 30 && npc.id % 3 !== 0) ? 'flank' : 'chase';
          if (npc.reroute <= 0) {
            const [px, pz] = this.grid.grid(playerPosition.x, playerPosition.z);
            let goal = this.grid.cell(Math.max(0, Math.min(this.grid.size - 1, px)), Math.max(0, Math.min(this.grid.size - 1, pz)));
            if (npc.state === 'cover') goal = this.findCover(npc, playerPosition) || goal;
            if (npc.state === 'flank') goal = this.findFlank(npc, playerPosition) || goal;
            if (goal?.blocked || goal?.rubble) goal = this.grid.randomOpen();
            if (goal) this.route(npc, goal);
          }
          if (npc.leader && distance < 5.4 && this.simulationTime - npc.memory > 7) {
            npc.memory = this.simulationTime;
            const midpoint = npc.group.position.clone().lerp(playerPosition, 0.5);
            this.destruction.blast(midpoint.x, midpoint.z, 2.5, 'enemy');
          }
          if (distance > 6 && distance < (npc.leader ? 38 : 27) && npc.shotTimer <= 0 && this.clearLine(npc.group.position, playerPosition)) {
            npc.shotTimer = (npc.leader ? 1.05 : 2.25) + this.grid.random() * 0.9;
            npc.fireTime = 0.18;
            const rig = npc.group.userData.rig as CharacterRig;
            npc.group.updateWorldMatrix(true, true);
            const muzzle = rig.mount.localToWorld(new THREE.Vector3(0, 0, npc.leader ? 1.76 : 0.88));
            this.events.emit('enemyShot', { fromX: muzzle.x, fromY: muzzle.y, fromZ: muzzle.z,
              toX: playerPosition.x, toY: playerPosition.y + 1.4, toZ: playerPosition.z,
              hit: this.grid.random() < (npc.leader ? 0.48 : 0.3), heavy: npc.leader });
          }
        } else if (npc.reroute <= 0) this.route(npc, this.grid.randomOpen());
      }
      this.move(npc, dt);
    }
    this.refreshSpatial();
    this.propagatePanic(dt);
    this.resolveCrowding(playerPosition);
  }

  private propagatePanic(dt: number): void {
    const contacts = new Map<NPC, { source: NPC; exposure: number }>();
    for (const source of this.npcs) {
      if (!source.alive || source.ragdoll || source.kind !== 'civilian' || source.panic < 0.35 ||
          source.state !== 'flee' && source.state !== 'hide') continue;
      for (const listener of this.spatial.nearby(source.group.position.x, source.group.position.z, 3.2)) {
        if (listener === source || !listener.alive || listener.kind !== 'civilian' || listener.ragdoll ||
            listener.state === 'flee' || listener.state === 'hide' ||
            Math.abs(listener.group.position.y - source.group.position.y) > 0.9) continue;
        const distance = listener.group.position.distanceTo(source.group.position);
        if (distance > 3.2) continue;
        let separated = false;
        for (const fraction of [0.25, 0.5, 0.75]) {
          const x = THREE.MathUtils.lerp(source.group.position.x, listener.group.position.x, fraction);
          const z = THREE.MathUtils.lerp(source.group.position.z, listener.group.position.z, fraction);
          if (this.prefabs.interiorObstacleAt(x, z, source.group.position.y)) { separated = true; break; }
        }
        if (separated) continue;
        const sociability = this.grid.hash(listener.id, 918, 301);
        const exposure = dt * (distance < 1.5 ? 4 : 2) * (0.78 + sociability * 0.62);
        const prior = contacts.get(listener);
        contacts.set(listener, { source: prior?.source || source, exposure: (prior?.exposure || 0) + exposure });
      }
    }
    for (const npc of this.npcs) {
      if (!npc.alive || npc.kind !== 'civilian' || npc.state === 'flee' || npc.state === 'hide') continue;
      const contact = contacts.get(npc);
      npc.socialExposure = Math.max(0, (npc.socialExposure || 0) + (contact?.exposure || -dt * 1.5));
      const resilience = this.grid.hash(npc.id, 918, 302);
      if (!contact || npc.socialExposure < 0.38 + resilience * 0.72) continue;
      npc.socialExposure = 0;
      npc.state = 'flee';
      npc.panic = Math.max(npc.panic, 0.48 + this.grid.hash(npc.id, 918, 303) * 0.3);
      npc.fearTime = 0.32 + this.grid.hash(npc.id, 918, 304) * 0.74;
      npc.markerTime = Math.max(npc.markerTime, 2.6 + this.grid.hash(npc.id, 918, 305) * 2.1);
      const source = contact.source;
      npc.group.rotation.y = Math.atan2(source.group.position.x - npc.group.position.x,
        source.group.position.z - npc.group.position.z);
      const dangerX = source.fleeFromPlayer ? this.player.position.x : source.fleeSource?.x ?? this.lastDanger.x;
      const dangerZ = source.fleeFromPlayer ? this.player.position.z : source.fleeSource?.y ?? this.lastDanger.z;
      this.flee(npc, dangerX, dangerZ, true, source.fleeFromPlayer);
    }
  }

  private findCover(npc: NPC, player: THREE.Vector3): Cell | undefined {
    const [gx, gz] = this.grid.grid(npc.group.position.x, npc.group.position.z);
    let best: Cell | undefined, score = -Infinity;
    for (let z = gz - 4; z <= gz + 4; z++) for (let x = gx - 4; x <= gx + 4; x++) {
      const cell = this.grid.cell(x, z);
      if (!cell || cell.blocked || cell.rubble) continue;
      const adjacent = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => this.grid.cell(x + dx, z + dz)?.blocked);
      if (!adjacent) continue;
      const [wx, wz] = this.grid.world(x, z);
      const value = Math.hypot(wx - player.x, wz - player.z) - Math.hypot(wx - npc.group.position.x, wz - npc.group.position.z) * 0.8;
      if (value > score) { score = value; best = cell; }
    }
    return best;
  }

  private findFlank(npc: NPC, player: THREE.Vector3): Cell | undefined {
    const toward = player.clone().sub(npc.group.position).setY(0).normalize();
    const side = npc.id % 2 === 0 ? 1 : -1;
    const targetX = player.x + toward.z * side * 8;
    const targetZ = player.z - toward.x * side * 8;
    const [gx, gz] = this.grid.grid(targetX, targetZ);
    for (let radius = 0; radius <= 3; radius++) {
      for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
        const cell = this.grid.cell(gx + dx, gz + dz);
        if (cell && !cell.blocked && !cell.rubble) return cell;
      }
    }
    return undefined;
  }

  private clearLine(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const distance = from.distanceTo(to);
    for (let step = 1.5; step < distance - 1; step += 1.1) {
      const point = from.clone().lerp(to, step / distance);
      if (this.grid.cellAtWorld(point.x, point.z)?.blocked) return false;
    }
    return true;
  }

  negotiate(position: THREE.Vector3): 'none' | 'captured' | 'betrayal' {
    const npc = this.npcs.find((candidate) => candidate.alive && candidate.kind === 'enemy' && candidate.state === 'surrender' && candidate.group.position.distanceTo(position) < 5);
    if (!npc) return 'none';
    if (npc.loyalty < 0.19) { this.remove(npc); return 'captured'; }
    npc.state = 'chase';
    npc.stamina = 1;
    npc.loyalty = 1;
    npc.reroute = 0;
    return 'betrayal';
  }

  private move(npc: NPC, dt: number): void {
    const rig = npc.group.userData.rig as CharacterRig;
    if (npc.state === 'hide' || (npc.kind === 'civilian' && (npc.fearTime || 0) > 0.2)) {
      npc.velocity?.multiplyScalar(Math.exp(-dt * 7));
      this.animate(npc, rig, dt, false, false);
      return;
    }
    if (npc.pauseTime > 0 && npc.kind === 'civilian' && npc.state !== 'flee') {
      const partner = this.spatial.nearby(npc.group.position.x, npc.group.position.z, 4).find((other) => other !== npc && other.kind === 'civilian' && other.pauseTime > 0 && other.group.position.distanceToSquared(npc.group.position) < 12);
      if (partner) {
        const delta = partner.group.position.clone().sub(npc.group.position);
        const heading = Math.atan2(delta.x, delta.z);
        const turn = Math.atan2(Math.sin(heading - npc.group.rotation.y), Math.cos(heading - npc.group.rotation.y));
        npc.group.rotation.y += turn * Math.min(1, dt * 4);
      } else {
        // A resting pedestrian occasionally scans the street; each one has a
        // stable curiosity level and a different glance timing and direction.
        const lookPhase = (this.simulationTime + npc.id * 2.173) % 13.5;
        const curiosity = this.grid.hash(npc.id, 441, 23);
        if (lookPhase > 5.3 && lookPhase < 8.1 && curiosity > 0.26) {
          const glance = (curiosity - 0.5) * 1.5;
          const turn = Math.atan2(Math.sin(glance - npc.group.rotation.y), Math.cos(glance - npc.group.rotation.y));
          npc.group.rotation.y += turn * Math.min(1, dt * 1.7);
        }
      }
      this.animate(npc, rig, dt, false, Boolean(partner));
      return;
    }
    if (npc.state === 'surrender') {
      this.animate(npc, rig, dt, false, false);
      return;
    }
    const index = npc.detourCell ?? npc.path[npc.pathIndex];
    if (index === undefined) { npc.velocity?.multiplyScalar(Math.exp(-dt * 7)); this.animate(npc, rig, dt, false, false); return; }
    const [x, z] = this.grid.world(index % this.grid.size, Math.floor((index%(this.grid.size*this.grid.size)) / this.grid.size));
    const direction = new THREE.Vector3(x - npc.group.position.x, 0, z - npc.group.position.z);
    if (direction.length() < 0.18 || (direction.length() < 0.95 && this.grid.walkable(x, z) && !this.canOccupy(npc, x, z))) {
      if (npc.detourCell !== undefined) npc.detourCell = undefined;
      else npc.pathIndex++;
      if (npc.kind === 'civilian' && npc.pathIndex >= npc.path.length) {
        if (npc.state === 'flee' && npc.hideTarget === npc.target) {
          const caution = this.grid.hash(npc.id, 918, 55);
          npc.state = 'hide'; npc.hideTime = 1.8 + caution * 4.2 + this.grid.hash(npc.id, Math.floor(this.simulationTime), 613) * 1.2;
          npc.hideTarget = undefined;
          npc.path = []; npc.pathIndex = 0;
          npc.velocity?.set(0, 0, 0);
          this.animate(npc, rig, dt, false, false);
          return;
        }
        const dwell = npc.role === 'keeper' ? 25 : npc.role === 'visitor' ? 8 : npc.role === 'shopper' ? 6 : npc.role === 'worker' ? 4 : 5;
        npc.pauseTime = dwell + this.grid.hash(npc.id, Math.floor(this.simulationTime), 25) * 6;
        npc.path = []; npc.pathIndex = 0;
      }
      this.animate(npc, rig, dt, false, false);
      return;
    }
    direction.normalize();
    const speed = npc.speed * (npc.state === 'flee' ? 1.95 : npc.state === 'chase' || npc.state === 'flank' ? 1.45 : 1) *
      (npc.kind === 'civilian' ? 1 - npc.needRest * 0.25 : 1) * (npc.hazardTime > 0 ? 0.6 : 1) *
      (this.hasLostArm(npc) ? 0.29 : 1);
    npc.velocity ||= new THREE.Vector3();
    npc.velocity.lerp(direction.clone().multiplyScalar(speed), Math.min(1, dt * (npc.state === 'flee' ? 8 : 5.5)));
    const step = Math.min(direction.length() + 0.1, npc.velocity.length() * dt);
    const lateral = new THREE.Vector3(-direction.z, 0, direction.x);
    const preference = npc.id % 2 ? 1 : -1;
    const options = [npc.velocity.clone().normalize(), direction, direction.clone().addScaledVector(lateral, preference * 1.15).normalize(), direction.clone().addScaledVector(lateral, -preference * 1.15).normalize()];
    let moved = false;
    let heading = Math.atan2(direction.x, direction.z);
    for (const vector of options) {
      const nextX = npc.group.position.x + vector.x * step;
      const nextZ = npc.group.position.z + vector.z * step;
      if (!this.canOccupy(npc, nextX, nextZ)) continue;
      npc.group.position.x = nextX; npc.group.position.z = nextZ;
      this.spatial.update(npc);
      heading = Math.atan2(vector.x, vector.z);
      moved = true;
      break;
    }
    if (!moved) {
      npc.blockedMoveTime = (npc.blockedMoveTime || 0) + dt;
      npc.reroute = Math.min(npc.reroute, 0.35);
      npc.velocity.multiplyScalar(0.35);
      if (npc.blockedMoveTime > 0.42) {
        const [gx, gz] = this.grid.grid(npc.group.position.x, npc.group.position.z);
        let best: { cell: number; score: number } | undefined;
        for (let radius = 1; radius <= 2; radius++) for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          const cell = this.grid.cell(gx + dx, gz + dz);
          if (!cell?.active || cell.blocked || cell.rubble) continue;
          const [cx, cz] = this.grid.world(cell.x, cell.z);
          if (!this.canOccupy(npc, cx, cz)) continue;
          const toward = new THREE.Vector2(x - npc.group.position.x, z - npc.group.position.z);
          const candidate = new THREE.Vector2(cx - npc.group.position.x, cz - npc.group.position.z);
          const score = candidate.dot(toward.clone().normalize()) - candidate.distanceTo(toward.clone().normalize().multiplyScalar(1.4)) * 0.18 + this.grid.hash(cell.x, cell.z, npc.id) * 0.08;
          if (!best || score > best.score) best = { cell: this.grid.index(cell.x, cell.z), score };
        }
        if (best) {
          npc.detourCell = best.cell;
          npc.blockedMoveTime = 0;
          npc.velocity.set(0, 0, 0);
        }
      }
    } else {
      npc.blockedMoveTime = 0;
      npc.velocity.set(Math.sin(heading) * step / Math.max(dt, 0.001), 0, Math.cos(heading) * step / Math.max(dt, 0.001));
    }
    if (npc.kind === 'enemy' && (npc.state === 'chase' || npc.state === 'flank' || npc.state === 'cover') && npc.group.position.distanceToSquared(this.player.position) < 32 * 32)
      heading = Math.atan2(this.player.position.x - npc.group.position.x, this.player.position.z - npc.group.position.z);
    const turn = Math.atan2(Math.sin(heading - npc.group.rotation.y), Math.cos(heading - npc.group.rotation.y));
    npc.group.rotation.y += turn * Math.min(1, dt * 7);
    this.animate(npc, rig, dt, moved, false);
  }

  private canOccupy(npc: NPC, x: number, z: number): boolean {
    if (!this.grid.walkable(x, z)) return false;
    const support=this.grid.surfaces.reachable(x,z,npc.group.position.y)?.height??this.grid.groundHeight(x,z);
    if(Math.abs(support-npc.group.position.y)>.55||this.prefabs.interiorObstacleAt(x,z,support))return false;
    if (this.player.visible && Math.abs(npc.group.position.y - this.player.position.y) < 0.9 &&
      Math.hypot(this.player.position.x - x, this.player.position.z - z) < 1.02) return false;
    for (const other of this.spatial.nearby(x, z, 1.5)) {
      if (other === npc || !other.alive || Math.abs(other.group.position.y - npc.group.position.y) > 1) continue;
      if (Math.hypot(other.group.position.x - x, other.group.position.z - z) < (other.knockdownTime > 0 ? 0.82 : 1.04)) return false;
    }
    // Pedestrians yield to parked, driven, and autonomous traffic using the
    // actual oriented vehicle footprint, rather than checking only its center.
    return !this.overlapsVehicle(npc, x, z);
  }

  private overlapsVehicle(npc: NPC, x: number, z: number): boolean {
    if (npc.group.position.y >= this.grid.groundHeight(x,z)+1) return false;
    for (const vehicle of this.vehicleSpatial.nearby(x, z, 5)) {
      const specs = vehicle.userData.vehicle as { length: number; width: number } | undefined;
      if (!specs || vehicle.userData.destroyed || Math.abs(vehicle.position.y-npc.group.position.y)>1.5) continue;
      const dx = x - vehicle.position.x, dz = z - vehicle.position.z;
      const along = Math.abs(dx * Math.sin(vehicle.rotation.y) + dz * Math.cos(vehicle.rotation.y));
      const across = Math.abs(dx * Math.cos(vehicle.rotation.y) - dz * Math.sin(vehicle.rotation.y));
      if (along < specs.length / 2 + 0.42 && across < specs.width / 2 + 0.34) return true;
    }
    return false;
  }

  private resolveCrowding(player: THREE.Vector3): void {
    const nearby = this.npcs.filter((npc) => npc.alive && !npc.ragdoll && npc.group.position.distanceToSquared(player) < 95 * 95);
    if (this.player.visible) for (const npc of nearby) {
      if (Math.abs(npc.group.position.y - player.y) > 0.9) continue;
      let dx = npc.group.position.x - player.x, dz = npc.group.position.z - player.z;
      let distance = Math.hypot(dx, dz);
      if (distance >= 1.02) continue;
      if (distance < 0.001) { dx = npc.id % 2 ? 1 : -1; dz = 0.25; distance = 0; }
      const push = 1.02 - distance;
      const x = npc.group.position.x + dx / Math.hypot(dx, dz) * push;
      const z = npc.group.position.z + dz / Math.hypot(dx, dz) * push;
      if (this.canOccupy(npc,x,z)) {
        npc.group.position.x = x; npc.group.position.z = z; this.spatial.update(npc);
      }
    }
    for (const a of nearby) for (const b of this.spatial.nearby(a.group.position.x, a.group.position.z, 1.2)) {
      if (a.id >= b.id || Math.abs(a.group.position.y - b.group.position.y) > 1) continue;
      let dx = a.group.position.x - b.group.position.x;
      let dz = a.group.position.z - b.group.position.z;
      let distance = Math.hypot(dx, dz);
      if (distance >= 0.92) continue;
      if (distance < 0.001) { dx = a.id % 2 ? 1 : -1; dz = b.id % 2 ? 0.5 : -0.5; distance = 0; }
      const directionLength = Math.hypot(dx, dz);
      const push = (0.92 - distance) * 0.52;
      const ax = a.group.position.x + dx / directionLength * push, az = a.group.position.z + dz / directionLength * push;
      const bx = b.group.position.x - dx / directionLength * push, bz = b.group.position.z - dz / directionLength * push;
      if (this.canOccupy(a,ax,az)) { a.group.position.set(ax, a.group.position.y, az); this.spatial.update(a); }
      if (this.canOccupy(b,bx,bz)) { b.group.position.set(bx, b.group.position.y, bz); this.spatial.update(b); }
    }
  }

  private springPose(rig: CharacterRig, object: THREE.Object3D, axis: 'x' | 'y' | 'z', target: number, dt: number, frequency = 11): void {
    let velocity = rig.springs.get(object);
    if (!velocity) { velocity = new THREE.Vector3(); rig.springs.set(object, velocity); }
    const stiffness = frequency * frequency;
    const damping = frequency * 1.7;
    velocity[axis] += ((target - object.rotation[axis]) * stiffness - velocity[axis] * damping) * Math.min(dt, 0.05);
    object.rotation[axis] += velocity[axis] * Math.min(dt, 0.05);
  }

  private poseRifleGrip(rig: CharacterRig, dt: number): void {
    const down = new THREE.Vector3(0, -1, 0);
    const grips = [new THREE.Vector3(-0.15, -0.25, 0.69), new THREE.Vector3(0.16, -0.35, 0.42)];
    for (let side = 0; side < 2; side++) {
      const shoulder = rig.arms[side], elbow = rig.elbows[side];
      const start = shoulder.position.clone(), target = grips[side];
      const direction = target.clone().sub(start);
      const distance = Math.min(0.9, direction.length());
      direction.normalize();
      const preferred = new THREE.Vector3(side === 0 ? -0.35 : 0.35, -0.6, -0.35);
      const bend = preferred.addScaledVector(direction, -preferred.dot(direction)).normalize();
      const upperLength = 0.46, halfway = distance / 2;
      const elbowPoint = start.clone().addScaledVector(direction, halfway)
        .addScaledVector(bend, Math.sqrt(Math.max(0, upperLength * upperLength - halfway * halfway)));
      const upper = elbowPoint.sub(start).normalize();
      const upperRotation = new THREE.Quaternion().setFromUnitVectors(down, upper);
      shoulder.quaternion.slerp(upperRotation, 1 - Math.exp(-dt * 16));
      const actualElbow = start.clone().addScaledVector(down.clone().applyQuaternion(shoulder.quaternion), upperLength);
      const lower = target.clone().sub(actualElbow)
        .applyQuaternion(shoulder.quaternion.clone().invert()).normalize();
      const elbowRotation = new THREE.Quaternion().setFromUnitVectors(down, lower);
      elbow.quaternion.slerp(elbowRotation, 1 - Math.exp(-dt * 17));
      const handRotation = shoulder.quaternion.clone().multiply(elbow.quaternion).invert();
      rig.hands[side].quaternion.slerp(handRotation, 1 - Math.exp(-dt * 17));
    }
  }

  private animate(npc: NPC, rig: CharacterRig, dt: number, moving: boolean, talking: boolean): void {
    const fleeing = npc.state === 'flee';
    const hiding = npc.state === 'hide';
    const frightened = (npc.fearTime || 0) > 0.15;
    const surrendering = npc.state === 'surrender';
    const combat = npc.kind === 'enemy' && !surrendering && (npc.state === 'chase' || npc.state === 'cover' || npc.state === 'flank');
    const idlePhase = (this.simulationTime + npc.id * 2.173) % 22;
    const phoneSide = this.grid.hash(npc.id, 712, 17) > 0.5 ? 1 : 0;
    const phoneUse = !moving && !fleeing && !hiding && !frightened && !combat && !surrendering &&
      npc.kind === 'civilian' && npc.pauseTime > 1 && idlePhase > 14 && idlePhase < 18 &&
      this.grid.hash(npc.id, 311, 42) > 0.48;
    setFaceExpression(rig.face, frightened || fleeing || surrendering ? 'scared' :
      combat || npc.warned ? 'annoyed' : talking || (npc.kind === 'civilian' && npc.pauseTime > 2 && npc.panic < 0.2) ? 'happy' : 'normal');
    const speed = moving ? Math.max(npc.velocity?.length() || 0, npc.indoorAnchor ? npc.speed * 0.45 : 0) : 0;
    const requested: MixamoState = surrendering ? 'surrender' : hiding ? 'crouch' :
      (npc.fireTime || 0) > 0.03 ? 'fire' : combat ? 'aim' :
        (fleeing || frightened) ? (moving ? 'run' : 'fear') : moving ? (speed > 2.25 ? 'run' : 'walk') : 'idle';
    const fastGait = requested === 'run' || fleeing;
    rig.motion += (Math.min(1, speed / (fastGait ? 3.5 : 2.1)) - rig.motion) * (1 - Math.exp(-dt * 7));
    // The downloaded Mixamo walk/run FBXs are valid clips but do not map cleanly
    // to this short voxel skeleton's foot lengths. Drive travel from the NPC's
    // actual speed with the spring gait below; keep Mixamo for non-locomotion
    // poses such as idle, fear, aim, and crouch.
    const proceduralGait = requested === 'walk' || requested === 'run';
    if (proceduralGait) this.mixamo.stop(rig.body);
    if (!proceduralGait && !phoneUse && this.mixamo.update(rig.body, dt, requested)) {
      if (combat || (npc.fireTime || 0) > 0.03) this.poseRifleGrip(rig, dt);
      rig.phase += speed * dt * (fleeing ? 5.2 : 4.5);
      rig.bubble.visible = talking && !frightened;
      if (rig.flash) {
        rig.flash.visible = (npc.fireTime || 0) > 0;
        rig.flash.scale.setScalar(rig.flash.visible ? 1 + Math.sin((npc.fireTime || 0) * 35) * 0.25 : 1);
      }
      const support = npc.indoorAnchor?.y ?? this.grid.surfaces.reachable(npc.group.position.x,npc.group.position.z,npc.group.position.y)?.height ??
        this.prefabs.supportHeight(npc.group.position.x,npc.group.position.z,npc.group.position.y);
      npc.groundPhysics ??= new GroundPhysics();
      npc.group.position.y = npc.groundPhysics.step(npc.group.position.y, support, dt);
      this.springPose(rig, npc.group, 'z', 0, dt, 10);
      return;
    }
    // Gait is driven by distance travelled, so stopping or being blocked does
    // not leave feet cycling in place. Every joint follows a damped spring.
    rig.phase += speed * dt * (fleeing ? 5.2 : 4.5);
    const stride = Math.sin(rig.phase) * rig.motion;
    const lean = hiding ? 0.42 : frightened ? -0.22 : fastGait ? 0.2 : combat ? -0.07 : moving ? 0.045 : 0;
    const bend = hiding ? 1.04 : 0;
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1;
      const swing = stride * sign;
      this.springPose(rig, rig.legs[side], 'x', hiding ? -0.65 : swing * (fastGait ? 0.9 : 0.68), dt, fastGait ? 17 : 13);
      this.springPose(rig, rig.knees[side], 'x', bend + Math.max(0, -swing) * (fastGait ? 1.05 : 0.78), dt, 15);
      this.springPose(rig, rig.feet[side], 'x', -rig.knees[side].rotation.x * 0.42, dt, 13);
      const shoulder = rig.arms[side], elbow = rig.elbows[side];
      let shoulderX = -swing * (fastGait ? 0.76 : 0.58);
      let shoulderZ = 0, elbowX = 0.13;
      if (rig.heavy && combat) {
        shoulderX = side === 0 ? -1.18 : -1.02;
        shoulderZ = side === 0 ? -0.2 : 0.2;
        elbowX = side === 0 ? -0.68 : -0.48;
      } else if (combat) {
        shoulderX = side === 0 ? -0.8 : -1.15;
        elbowX = side === 0 ? -0.45 : -0.26;
      } else if (frightened) {
        shoulderX = -1.45;
        shoulderZ = side === 0 ? -0.65 : 0.65;
        elbowX = -0.9;
      } else if (fleeing) {
        shoulderX = -0.55 - swing * 0.58;
        shoulderZ = side === 0 ? -0.2 : 0.2;
        elbowX = -0.6;
      } else if (hiding) {
        shoulderX = -1.2;
        shoulderZ = side === 0 ? -0.35 : 0.35;
        elbowX = -0.85;
      } else if (surrendering) {
        shoulderX = -0.35;
        shoulderZ = side === 0 ? -2.35 : 2.35;
        elbowX = -0.25;
      } else if (talking) {
        shoulderX = side === 0 ? -0.4 + Math.sin(this.simulationTime * 3 + npc.id) * 0.22 : 0;
        elbowX = -0.35;
      } else if (phoneUse) {
        shoulderX = side === phoneSide ? -1.08 : -0.04;
        shoulderZ = side === phoneSide ? (phoneSide === 0 ? -0.12 : 0.12) : 0;
        elbowX = side === phoneSide ? -0.92 : 0.08;
      }
      if (!(rig.heavy && combat)) {
        this.springPose(rig, shoulder, 'x', shoulderX + (npc.fireTime && side === 1 ? 0.32 : 0), dt, 14);
        this.springPose(rig, shoulder, 'z', shoulderZ, dt, 11);
        this.springPose(rig, elbow, 'x', elbowX, dt, 15);
      }
      this.springPose(rig, rig.hands[side], 'z', -sign * Math.sin(rig.phase + 0.6) * 0.1 * rig.motion, dt, 12);
    }
    if (rig.heavy && combat) this.poseRifleGrip(rig, dt);
    const travelHeading = npc.velocity && npc.velocity.lengthSq() > 0.05 ? Math.atan2(npc.velocity.x, npc.velocity.z) : npc.group.rotation.y;
    const turn = Math.atan2(Math.sin(travelHeading - npc.group.rotation.y), Math.cos(travelHeading - npc.group.rotation.y));
    this.springPose(rig, rig.torso, 'x', lean, dt, 10);
    this.springPose(rig, rig.torso, 'z', -turn * 0.14, dt, 11);
    rig.torso.position.y += ((hiding ? -0.21 : 0.16 - Math.abs(Math.sin(rig.phase)) * 0.035 * rig.motion) - rig.torso.position.y) * (1 - Math.exp(-dt * 10));
    this.springPose(rig, rig.head, 'x', hiding ? 0.24 : frightened ? -0.18 : 0, dt, 9);
    this.springPose(rig, rig.head, 'z', phoneUse ? (phoneSide === 0 ? -0.12 : 0.12) : 0, dt, 8);
    rig.bubble.visible = talking && !frightened;
    if (rig.flash) {
      rig.flash.visible = (npc.fireTime || 0) > 0;
      rig.flash.scale.setScalar(rig.flash.visible ? 1 + Math.sin((npc.fireTime || 0) * 35) * 0.25 : 1);
    }
    this.springPose(rig, rig.mount, 'x', npc.fireTime ? 0.11 : 0, dt, 19);
    const support=npc.indoorAnchor?.y ?? this.grid.surfaces.reachable(npc.group.position.x,npc.group.position.z,npc.group.position.y)?.height ??
      this.prefabs.supportHeight(npc.group.position.x,npc.group.position.z,npc.group.position.y);
    npc.groundPhysics??=new GroundPhysics();
    npc.group.position.y=npc.groundPhysics.step(npc.group.position.y,support,dt);
    this.springPose(rig, npc.group, 'z', 0, dt, 10);
  }

  orientFaces(cameraPosition: THREE.Vector3, _isometric: boolean, dt: number): void {
    const blend = 1 - Math.exp(-dt * 9);
    for (const npc of this.npcs) {
      if (!npc.alive || npc.ragdoll || !npc.group.visible) continue;
      if (npc.group.position.distanceToSquared(this.player.position) > 75 * 75) continue;
      const rig = npc.group.userData.rig as CharacterRig;
      // A head can glance toward the viewer or the target, but cannot turn
      // through the back of the body. Fleeing civilians keep looking ahead.
      const lookAt = npc.kind === 'enemy' ? this.player.position : cameraPosition;
      const looking = npc.state !== 'flee' && npc.state !== 'hide';
      const relative = Math.atan2(lookAt.x - npc.group.position.x,
        lookAt.z - npc.group.position.z) - npc.group.rotation.y;
      const yaw = looking ? THREE.MathUtils.clamp(Math.atan2(Math.sin(relative), Math.cos(relative)), -1.05, 1.05) : 0;
      const turn = Math.atan2(Math.sin(yaw - rig.head.rotation.y), Math.cos(yaw - rig.head.rotation.y));
      rig.head.rotation.y += turn * blend;
    }
  }

  get civilians(): number { return this.npcs.filter((n) => n.kind === 'civilian' && n.alive).length; }
  get enemies(): number { return this.npcs.filter((n) => n.kind === 'enemy' && n.alive).length; }
  get panic(): number { return Math.round(this.npcs.filter((n) => n.kind === 'civilian' && n.alive).reduce((sum, n) => sum + n.panic, 0) / Math.max(1, this.civilians) * 100); }
  renderActors(): void { this.actorBatch?.update(); }
  dispose(): void { this.actorBatch?.dispose(); this.worker.terminate(); this.mixamo.dispose(); this.woundMaterial.dispose(); }
}
