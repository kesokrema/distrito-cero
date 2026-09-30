import * as THREE from 'three';
import { GridSystem } from '../world/GridSystem';
import { PrefabManager } from '../world/PrefabManager';
import { CANAL_SURFACE_Y } from '../world/CanalWater';
import { voxelShape } from '../world/VoxelSystem';
import type { BodyPart } from './HumanoidModel';
import { createFaceDecal, setFaceExpression, type FaceExpression } from './FaceTextures';

type Joint = { position: THREE.Vector3; previous: THREE.Vector3 };
type Link = { a: number; b: number; length: number; mesh: THREE.Mesh; part: BodyPart; baseMaterial: THREE.Material };
type Constraint = { a: number; b: number; length: number; part: BodyPart; minimum?: boolean };
type LoosePart = { object: THREE.Group; previous: THREE.Vector3; velocity: THREE.Vector3; floorLevel: number; radius: number; age: number };
type Recovery = { elapsed: number; start: THREE.Vector3[]; anchor: THREE.Vector3; yaw: number };
type WoundMark = { mesh: THREE.Mesh; joint: number };

const STANDING: Array<[number, number, number]> = [
  [0, 1.32, 0], [0, 1.48, 0], [0, 1.64, 0], [0, 2.09, 0],
  [-0.39, 1.72, 0], [-0.39, 1.26, 0], [-0.39, 0.80, 0],
  [0.39, 1.72, 0], [0.39, 1.26, 0], [0.39, 0.80, 0],
  [-0.17, 1.32, 0], [-0.17, 0.66, 0], [-0.17, 0, 0],
  [0.17, 1.32, 0], [0.17, 0.66, 0], [0.17, 0, 0]
];

const CROUCHING: Array<[number, number, number]> = [
  [0, 0.76, 0], [0, 1.0, 0.28], [0, 1.12, 0.38], [0, 1.5, 0.52],
  [-0.39, 1.15, 0.42], [-0.45, 0.75, 0.63], [-0.48, 0.31, 0.72],
  [0.39, 1.15, 0.42], [0.45, 0.75, 0.63], [0.48, 0.31, 0.72],
  [-0.17, 0.76, 0], [-0.17, 0.42, 0.56], [-0.17, 0.04, 0],
  [0.17, 0.76, 0], [0.17, 0.42, 0.56], [0.17, 0.04, 0]
];

export type RagdollBody = {
  joints: Joint[];
  links: Link[];
  constraints: Constraint[];
  details: THREE.Mesh[];
  face: THREE.Mesh;
  woundMarks: WoundMark[];
  materials: THREE.Material[];
  age: number;
  life: number;
  floorLevel: number;
  size: number;
  missing: Set<BodyPart>;
  crawling: boolean;
  crawlDirection: THREE.Vector3;
  crawlAge: number;
  lastClearCrawlPose?: THREE.Vector3[];
  across: THREE.Vector3;
  recovery?: Recovery;
};

type Colors = { shirt: string; pants: string; skin: string; shoes: string };

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const TEMP = new THREE.Vector3();
const CRAWL_SAMPLES = [[0, 0], [0.3, 0], [0.65, 0], [1.04, 0],
  [0.35, -0.5], [0.35, 0.5], [0.7, -0.5], [0.7, 0.5],
  [-0.4, -0.22], [-0.4, 0.22], [-0.8, -0.22], [-0.8, 0.22]] as const;

export class RagdollSystem {
  private bodies: RagdollBody[] = [];
  private looseParts: LoosePart[] = [];
  private readonly woundMaterial = new THREE.MeshStandardMaterial({ color: '#df4543', roughness: 0.82 });
  private readonly waterCurrent = new THREE.Vector3();

  private vehicleAt(x: number, z: number, floor: number, vehicles: readonly THREE.Group[]): boolean {
    for (const vehicle of vehicles) {
      if (vehicle.userData.destroyed || vehicle.visible === false || Math.abs(vehicle.position.y-floor)>1.2) continue;
      const specs = vehicle.userData.vehicle as { length: number; width: number } | undefined;
      if (!specs || Math.abs(vehicle.position.x - x) > specs.length / 2 + 1 ||
        Math.abs(vehicle.position.z - z) > specs.length / 2 + 1) continue;
      const dx = x - vehicle.position.x, dz = z - vehicle.position.z;
      const along = Math.abs(dx * Math.sin(vehicle.rotation.y) + dz * Math.cos(vehicle.rotation.y));
      const across = Math.abs(dx * Math.cos(vehicle.rotation.y) - dz * Math.sin(vehicle.rotation.y));
      if (along < specs.length / 2 + 0.22 && across < specs.width / 2 + 0.22) return true;
    }
    return false;
  }

  private openAt(x: number, z: number, floor: number, vehicles: readonly THREE.Group[]): boolean {
    return (this.grid.walkable(x, z) || this.grid.water.at(x,z) || this.prefabs.interiorWalkable(x, z)) &&
      !this.prefabs.interiorObstacleAt(x, z, floor - 0.18) && !this.vehicleAt(x, z, floor, vehicles);
  }

  constructor(private scene: THREE.Scene, private grid: GridSystem, private prefabs: PrefabManager) {}

  spawn(position: THREE.Vector3, yaw: number, impulse: THREE.Vector3, colors: Colors, floorLevel = 0, size = 1, life = 20,
    missing: ReadonlySet<BodyPart> = new Set(), initialPose?: readonly THREE.Vector3[]): RagdollBody {
    // The first frame uses the animated actor's actual joint positions.
    // Switching to a fixed T-pose here caused the visible hit-frame pop.
    const impulseDirection = impulse.clone();
    const joints: Joint[] = STANDING.map(([x, y, z], index) => {
      const point = initialPose?.length === STANDING.length ? initialPose[index].clone() :
        new THREE.Vector3(x * size, y * size, z * size).applyAxisAngle(Y_AXIS, yaw).add(position);
      const variation = Math.sin(index * 13.37) * 0.08;
      // Feet resist the first push while the upper body takes the impact.
      // This creates a fall around the hips instead of translating every
      // detached-looking segment by exactly the same amount.
      const impulseFactor = index === 12 || index === 15 ? 0.08 : index === 11 || index === 14 ? 0.35 :
        index === 10 || index === 13 ? 0.55 : index === 0 ? 0.72 : index === 3 ? 1.18 : 1;
      const velocity = impulseDirection.clone().multiplyScalar(impulseFactor)
        .add(new THREE.Vector3(variation, 0.12, Math.cos(index * 7.73) * 0.08));
      return { position: point, previous: point.clone().addScaledVector(velocity, -1 / 60) };
    });
    const palette = {
      shirt: new THREE.MeshStandardMaterial({ color: colors.shirt, roughness: 0.88 }),
      pants: new THREE.MeshStandardMaterial({ color: colors.pants, roughness: 0.9 }),
      skin: new THREE.MeshStandardMaterial({ color: colors.skin, roughness: 0.95 })
    };
    const links: Link[] = [];
    const constraints: Constraint[] = [];
    const constrain = (a: number, b: number, part: BodyPart, minimum?: number): void => {
      if (!missing.has(part)) constraints.push({ a, b, length: minimum ?? joints[a].position.distanceTo(joints[b].position), part,
        minimum: minimum !== undefined });
    };
    const connect = (a: number, b: number, width: number, depth: number, material: THREE.Material, part: BodyPart, visibleHeight?: number) => {
      if (missing.has(part)) return;
      const length = joints[a].position.distanceTo(joints[b].position);
      const mesh = voxelShape(width * size, visibleHeight ? visibleHeight * size : length, depth * size, material);
      mesh.castShadow = true;
      this.scene.add(mesh);
      links.push({ a, b, length, mesh, part, baseMaterial: material });
      constrain(a, b, part);
    };
    // The torso is one braced frame. Shoulder and hip anchors belong to it
    // even after a limb is lost; only the arm/leg segments can detach.
    connect(0, 2, 0.52, 0.34, palette.shirt, 'torso', 0.68);
    constrain(0, 1, 'torso'); constrain(1, 2, 'torso');
    for (const [a, b] of [[2, 4], [2, 7], [0, 10], [0, 13], [0, 4], [0, 7],
      [2, 10], [2, 13], [4, 7], [10, 13], [4, 10], [7, 13], [4, 13], [7, 10]] as const)
      constrain(a, b, 'torso');
    constrain(2, 3, 'head'); constrain(1, 3, 'head'); constrain(0, 3, 'head');
    connect(4, 5, 0.23, 0.25, palette.shirt, 'leftUpperArm');
    connect(5, 6, 0.23, 0.25, palette.skin, 'leftForearm');
    connect(7, 8, 0.23, 0.25, palette.shirt, 'rightUpperArm');
    connect(8, 9, 0.23, 0.25, palette.skin, 'rightForearm');
    connect(10, 11, 0.25, 0.29, palette.pants, 'leftThigh');
    connect(11, 12, 0.25, 0.29, palette.pants, 'leftShin');
    connect(13, 14, 0.25, 0.29, palette.pants, 'rightThigh');
    connect(14, 15, 0.25, 0.29, palette.pants, 'rightShin');
    // Limbs can bend, but cannot fold all the way through themselves.
    constrain(4, 6, 'leftUpperArm', 0.5 * size);
    constrain(7, 9, 'rightUpperArm', 0.5 * size);
    constrain(10, 12, 'leftThigh', 0.7 * size);
    constrain(13, 15, 'rightThigh', 0.7 * size);
    // Match the live model: one torso, one smooth cube head and two segments
    // per arm and leg, with no extra hands, neck or layered shoe voxels.
    const details = [voxelShape(0.58 * size, 0.58 * size, 0.58 * size, palette.skin)];
    const face = createFaceDecal('scared');
    details[0].add(face);
    details.forEach((mesh) => { mesh.castShadow = true; this.scene.add(mesh); });
    const body: RagdollBody = { joints, links, constraints, details, face, woundMarks: [], materials: Object.values(palette), age: 0, life, floorLevel, size,
      missing: new Set(missing), crawling: false, crawlDirection: new THREE.Vector3(0, 0, 1).applyAxisAngle(Y_AXIS, yaw), crawlAge: 0,
      across: new THREE.Vector3(1, 0, 0).applyAxisAngle(Y_AXIS, yaw) };
    for (const part of missing) this.markWound(body, part);
    this.bodies.push(body);
    while (this.bodies.length > 35) this.remove(this.bodies[0]);
    this.pose(body);
    return body;
  }

  pelvis(body: RagdollBody): THREE.Vector3 { return body.joints[0].position; }
  active(body: RagdollBody): boolean { return this.bodies.includes(body); }
  recoveryFinished(body: RagdollBody): boolean { return (body.recovery?.elapsed || 0) >= 1.05; }

  startRecovery(body: RagdollBody, yaw: number): void {
    if (body.recovery || body.crawling) return;
    const floorY = this.prefabs.supportHeight(body.joints[0].position.x,body.joints[0].position.z,body.joints[0].position.y);
    body.recovery = { elapsed: 0, start: body.joints.map((joint) => joint.position.clone()),
      anchor: new THREE.Vector3(body.joints[0].position.x, floorY, body.joints[0].position.z), yaw };
  }

  impact(body: RagdollBody, point: THREE.Vector3, impulse: THREE.Vector3): void {
    body.recovery = undefined;
    const joints = body.joints.map((joint, index) => ({ index, distance: joint.position.distanceToSquared(point) }))
      .sort((a, b) => a.distance - b.distance).slice(0, 4);
    for (const { index, distance } of joints) {
      const strength = 1 / (1 + distance * 2);
      body.joints[index].previous.addScaledVector(impulse, -strength / 60);
    }
  }

  launch(body: RagdollBody, impulse: THREE.Vector3): void {
    body.recovery = undefined;
    body.crawling = false;
    for (const joint of body.joints) joint.previous.addScaledVector(impulse, -1 / 60);
  }

  setCrawlDirection(body: RagdollBody, direction: THREE.Vector3): void {
    if (direction.lengthSq() < 0.001) return;
    body.crawlDirection.copy(direction).setY(0).normalize();
  }

  woundPosition(body: RagdollBody): THREE.Vector3 {
    const mark = body.woundMarks[body.woundMarks.length - 1];
    return (mark ? body.joints[mark.joint] : body.joints[0]).position;
  }

  setExpression(body: RagdollBody, expression: FaceExpression): void {
    setFaceExpression(body.face, expression);
  }

  private markWound(body: RagdollBody, part: BodyPart): void {
    const joint = part === 'leftUpperArm' ? 4 : part === 'rightUpperArm' ? 7 :
      part === 'leftForearm' ? 5 : part === 'rightForearm' ? 8 :
      part === 'leftThigh' ? 10 : part === 'rightThigh' ? 13 :
      part === 'leftShin' ? 11 : part === 'rightShin' ? 14 : -1;
    if (joint < 0 || body.woundMarks.some((mark) => mark.joint === joint)) return;
    const mesh = voxelShape(0.24 * body.size, 0.18 * body.size, 0.25 * body.size, this.woundMaterial);
    mesh.name = 'wound-stain';
    mesh.position.copy(body.joints[joint].position);
    this.scene.add(mesh);
    body.woundMarks.push({ mesh, joint });
  }

  raycast(raycaster: THREE.Raycaster, body: RagdollBody): { part: BodyPart; point: THREE.Vector3; distance: number } | null {
    const hits = raycaster.intersectObjects([...body.links.map((link) => link.mesh), ...body.details], false);
    const hit = hits[0];
    if (!hit) return null;
    return { part: body.links.find((link) => link.mesh === hit.object)?.part || 'head', point: hit.point, distance: hit.distance };
  }

  wound(body: RagdollBody, part: BodyPart): void {
    for (const link of body.links) if (link.part === part) link.mesh.material = this.woundMaterial;
  }

  explodeHead(body: RagdollBody): THREE.Vector3 {
    const position = body.joints[3].position.clone();
    if (body.missing.has('head')) return position;
    body.missing.add('head');
    body.constraints = body.constraints.filter((constraint) => constraint.part !== 'head');
    const head = body.details.shift();
    if (head) {
      this.scene.remove(head);
      head.geometry.dispose();
    }
    const wound = voxelShape(0.28 * body.size, 0.13 * body.size, 0.27 * body.size, this.woundMaterial);
    wound.name = 'head-wound';
    wound.position.copy(body.joints[2].position);
    this.scene.add(wound);
    body.woundMarks.push({ mesh: wound, joint: 2 });
    return position;
  }

  detach(body: RagdollBody, part: BodyPart, impulse: THREE.Vector3): void {
    const parts = [part];
    if (part.endsWith('UpperArm')) parts.push(part.replace('UpperArm', 'Forearm') as BodyPart);
    if (part.endsWith('Thigh')) parts.push(part.replace('Thigh', 'Shin') as BodyPart);
    const detached: THREE.Mesh[] = [];
    this.markWound(body, part);
    for (const name of parts) {
      body.missing.add(name);
      const distal = name === 'leftForearm' ? 6 : name === 'rightForearm' ? 9 :
        name === 'leftShin' ? 12 : name === 'rightShin' ? 15 : -1;
      body.constraints = body.constraints.filter((constraint) => constraint.part !== name &&
        (distal < 0 || (constraint.a !== distal && constraint.b !== distal)));
      const index = body.links.findIndex((link) => link.part === name);
      if (index < 0) continue;
      const [link] = body.links.splice(index, 1);
      this.scene.remove(link.mesh);
      link.mesh.material = link.baseMaterial;
      detached.push(link.mesh);
    }
    if (detached.length) {
      const center = detached.reduce((sum, mesh) => sum.add(mesh.position), new THREE.Vector3()).multiplyScalar(1 / detached.length);
      const object = new THREE.Group();
      object.name = 'severed-limb';
      object.position.copy(center);
      for (const mesh of detached) {
        mesh.position.sub(center);
        object.add(mesh);
      }
      const root = part === 'leftUpperArm' ? 4 : part === 'rightUpperArm' ? 7 :
        part === 'leftForearm' ? 5 : part === 'rightForearm' ? 8 :
        part === 'leftThigh' ? 10 : part === 'rightThigh' ? 13 :
        part === 'leftShin' ? 11 : part === 'rightShin' ? 14 : -1;
      if (root >= 0) {
        const cap = voxelShape(0.25 * body.size, 0.12 * body.size, 0.26 * body.size, this.woundMaterial);
        cap.name = 'severed-wound';
        cap.position.copy(body.joints[root].position).sub(center);
        object.add(cap);
      }
      this.scene.add(object);
      this.looseParts.push({ object, previous: center.clone(), velocity: impulse.clone().multiplyScalar(0.55),
        floorLevel: body.floorLevel, radius: detached.length > 1 ? 0.45 : 0.26, age: 0 });
      if (this.looseParts.length > 96) this.removeLoose(this.looseParts.shift()!);
    }
  }

  private removeLoose(part: LoosePart): void {
    this.scene.remove(part.object);
    part.object.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
  }

  remove(body: RagdollBody): void {
    const index = this.bodies.indexOf(body);
    if (index >= 0) this.bodies.splice(index, 1);
    body.links.forEach((link) => { this.scene.remove(link.mesh); link.mesh.geometry.dispose(); });
    body.details.forEach((mesh) => { this.scene.remove(mesh); mesh.geometry.dispose(); });
    body.woundMarks.forEach(({ mesh }) => { this.scene.remove(mesh); mesh.geometry.dispose(); });
    body.materials.forEach((material) => material.dispose());
  }

  update(dt: number, awakeAt?: (x: number, z: number) => boolean): void {
    const step = Math.min(dt, 1 / 30);
    for (const body of [...this.bodies]) {
      const pelvis = body.joints[0].position;
      if (awakeAt && !awakeAt(pelvis.x, pelvis.z)) continue;
      body.age += dt;
      if (body.age > body.life) { this.remove(body); continue; }
      if (body.recovery) body.recovery.elapsed = Math.min(1.05, body.recovery.elapsed + dt);
      for (const joint of body.joints) {
        const velocity = joint.position.clone().sub(joint.previous).multiplyScalar(0.97);
        joint.previous.copy(joint.position);
        joint.position.add(velocity);
        joint.position.y -= 19 * step * step;
      }
      if (body.recovery) {
        const recovery = body.recovery;
        const progress = Math.min(1, recovery.elapsed / 1.05);
        const phase = progress < 0.52 ? progress / 0.52 : (progress - 0.52) / 0.48;
        const eased = phase * phase * (3 - 2 * phase);
        const worldPose = ([x, y, z]: [number, number, number]): THREE.Vector3 =>
          new THREE.Vector3(x * body.size, y * body.size, z * body.size).applyAxisAngle(Y_AXIS, recovery.yaw).add(recovery.anchor);
        body.joints.forEach((joint, index) => {
          const crouch = worldPose(CROUCHING[index]);
          const start = progress < 0.52 ? recovery.start[index] : crouch;
          const end = progress < 0.52 ? crouch : worldPose(STANDING[index]);
          const target = start.clone().lerp(end, eased);
          joint.position.lerp(target, progress >= 1 ? 1 : 0.18 + progress * 0.5);
          joint.previous.lerp(joint.position, 0.7);
        });
      }
      const nearbyVehicles = this.prefabs.vehicles.filter((vehicle) =>
        Math.abs(vehicle.position.x - body.joints[0].position.x) < 8 &&
        Math.abs(vehicle.position.z - body.joints[0].position.z) < 8);
      if(this.grid.water.currentAt(pelvis.x,pelvis.y-0.85,pelvis.z,this.waterCurrent)) {
        for(const joint of body.joints) {
          joint.position.addScaledVector(this.waterCurrent,step*.8);
          joint.previous.addScaledVector(this.waterCurrent,step*.8);
          if(joint.position.y<CANAL_SURFACE_Y-.12)
            joint.position.y+=(CANAL_SURFACE_Y-.12-joint.position.y)*Math.min(.11,step*3);
        }
      }
      if (body.crawling) {
        body.crawlAge += step;
        if (body.crawlAge > 0.45) this.crawl(body, step, nearbyVehicles);
      }
      for (let iteration = 0; iteration < 7; iteration++) {
        for (const constraint of body.constraints) {
          const a = body.joints[constraint.a].position, b = body.joints[constraint.b].position;
          TEMP.subVectors(b, a);
          const length = TEMP.length();
          if (length < 0.0001 || (constraint.minimum && length >= constraint.length)) continue;
          let desiredLength = constraint.length;
          if (body.recovery && !constraint.minimum) {
            const from = STANDING[constraint.a], to = STANDING[constraint.b];
            const standingLength = Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]) * body.size;
            desiredLength = THREE.MathUtils.lerp(desiredLength, standingLength, Math.min(1, body.recovery.elapsed / 1.05));
          }
          const correction = TEMP.multiplyScalar((length - desiredLength) / length * 0.5);
          a.add(correction); b.sub(correction);
        }
        body.joints.forEach((joint, index) => this.collide(joint, index, body.floorLevel, body.size, nearbyVehicles));
      }
      if (body.crawling) this.keepCrawlClear(body, nearbyVehicles);
      this.pose(body);
    }
    this.looseParts = this.looseParts.filter((part) => {
      part.age += dt;
      if (part.age > 16) { this.removeLoose(part); return false; }
      const position = part.object.position, before = part.previous.clone();
      part.previous.copy(position);
      const inWater=this.grid.water.currentAt(position.x,position.y,position.z,this.waterCurrent);
      if(inWater) {
        part.velocity.x=THREE.MathUtils.lerp(part.velocity.x,this.waterCurrent.x,Math.min(1,step*3));
        part.velocity.z=THREE.MathUtils.lerp(part.velocity.z,this.waterCurrent.z,Math.min(1,step*3));
        part.velocity.y+=(CANAL_SURFACE_Y+part.radius*.28-position.y)*step*8-part.velocity.y*step*2;
      } else part.velocity.y -= 19 * step;
      position.addScaledVector(part.velocity, step);
      part.velocity.multiplyScalar(0.985);
      const floor = inWater ? CANAL_SURFACE_Y+part.radius*.22 : part.floorLevel > 0 && this.prefabs.upperFloorPresent(position.x, position.z, part.floorLevel)
        ? this.prefabs.floorHeightAt(position.x,position.z,part.floorLevel)+part.radius : this.prefabs.supportHeight(position.x,position.z,position.y)+part.radius;
      if (position.y < floor) { position.y = floor; part.velocity.y *= -0.17; part.velocity.x *= 0.7; part.velocity.z *= 0.7; }
      if ((!this.grid.walkable(position.x, position.z) && !this.grid.water.at(position.x,position.z) &&
          !this.prefabs.interiorWalkable(position.x, position.z)) ||
          this.prefabs.interiorObstacleAt(position.x, position.z, position.y)) {
        position.x = before.x; position.z = before.z;
        part.velocity.x *= -0.3; part.velocity.z *= -0.3;
      }
      part.object.rotation.x += step * part.velocity.z * 0.5;
      part.object.rotation.z -= step * part.velocity.x * 0.5;
      return true;
    });
  }

  private crawlSamplesClear(body: RagdollBody, offset: number, floor: number, vehicles: readonly THREE.Group[]): boolean {
    const core = body.joints[0].position;
    const direction = body.crawlDirection, rightX = direction.z, rightZ = -direction.x;
    return CRAWL_SAMPLES.every(([forward, side]) => this.openAt(
      core.x + direction.x * (forward + offset) + rightX * side,
      core.z + direction.z * (forward + offset) + rightZ * side, floor, vehicles));
  }

  private keepCrawlClear(body: RagdollBody, vehicles: readonly THREE.Group[]): void {
    const core = body.joints[0].position;
    const floor = body.floorLevel > 0 && this.prefabs.upperFloorPresent(core.x, core.z, body.floorLevel)
      ? this.prefabs.floorHeightAt(body.joints[0].position.x,body.joints[0].position.z,body.floorLevel) : this.prefabs.supportHeight(body.joints[0].position.x,body.joints[0].position.z,body.joints[0].position.y);
    const connected = [0, 1, 2, 3, 4, 7, 10, 13];
    if (!body.missing.has('leftUpperArm')) connected.push(5);
    if (!body.missing.has('leftForearm')) connected.push(6);
    if (!body.missing.has('rightUpperArm')) connected.push(8);
    if (!body.missing.has('rightForearm')) connected.push(9);
    if (!body.missing.has('leftThigh')) connected.push(11);
    if (!body.missing.has('leftShin')) connected.push(12);
    if (!body.missing.has('rightThigh')) connected.push(14);
    if (!body.missing.has('rightShin')) connected.push(15);
    const clear = this.crawlSamplesClear(body, 0, floor, vehicles) && connected.every((index) => {
      const point = body.joints[index].position;
      return this.openAt(point.x, point.z, floor, vehicles);
    });
    if (clear) {
      if (!body.lastClearCrawlPose) body.lastClearCrawlPose = body.joints.map((joint) => joint.position.clone());
      else body.joints.forEach((joint, index) => body.lastClearCrawlPose![index].copy(joint.position));
      return;
    }
    if (!body.lastClearCrawlPose) return;
    body.joints.forEach((joint, index) => {
      const safe = body.lastClearCrawlPose![index];
      joint.position.x = safe.x; joint.position.z = safe.z;
      joint.previous.x = safe.x; joint.previous.z = safe.z;
    });
  }

  private crawl(body: RagdollBody, step: number, nearbyVehicles: readonly THREE.Group[]): void {
    const direction = body.crawlDirection;
    const floor = body.floorLevel > 0 && this.prefabs.upperFloorPresent(body.joints[0].position.x, body.joints[0].position.z, body.floorLevel)
      ? this.prefabs.floorHeightAt(body.joints[0].position.x,body.joints[0].position.z,body.floorLevel) : this.prefabs.supportHeight(body.joints[0].position.x,body.joints[0].position.z,body.joints[0].position.y);
    const intactArms = Number(!body.missing.has('leftUpperArm') && !body.missing.has('leftForearm')) +
      Number(!body.missing.has('rightUpperArm') && !body.missing.has('rightForearm'));
    const bothLegs = (body.missing.has('leftThigh') || body.missing.has('leftShin')) &&
      (body.missing.has('rightThigh') || body.missing.has('rightShin'));
    const speed = (bothLegs ? 0.38 : 0.62) * (intactArms === 2 ? 1 : intactArms === 1 ? 0.55 : 0.12);
    const distance = speed * step;
    const right = new THREE.Vector3(direction.z, 0, -direction.x);
    // Sweep the whole prone silhouette, including the front of the head.
    const canAdvance = this.crawlSamplesClear(body, distance, floor, nearbyVehicles);
    if (!canAdvance) {
      for (const joint of body.joints) {
        joint.previous.x = joint.position.x;
        joint.previous.z = joint.position.z;
      }
      return;
    }
    for (const joint of body.joints) {
      joint.position.x += direction.x * distance; joint.position.z += direction.z * distance;
      joint.previous.x += direction.x * distance; joint.previous.z += direction.z * distance;
    }
    // Let gravity and the joint solver finish the fall, then guide the trunk
    // into a low prone silhouette. Hands reach alternately and drag the torso.
    const anchor = body.joints[0].position;
    const settle = Math.min(0.11, step * 5);
    for (const [index, forward, height, lateral] of [[0, 0, 0.32, 0], [1, 0.17, 0.37, 0],
      [2, 0.33, 0.42, 0], [3, 0.68, 0.50, 0], [4, 0.33, 0.46, -0.39],
      [7, 0.33, 0.46, 0.39], [10, 0, 0.32, -0.17], [13, 0, 0.32, 0.17]] as const) {
      const point = body.joints[index].position;
      point.x += (anchor.x + direction.x * forward + right.x * lateral - point.x) * settle;
      point.z += (anchor.z + direction.z * forward + right.z * lateral - point.z) * settle;
      point.y += (floor + height * body.size - point.y) * settle;
    }
    for (const [side, elbow, wrist, missing] of [[-1, 5, 6, 'leftForearm'], [1, 8, 9, 'rightForearm']] as const) {
      if (body.missing.has(missing) || body.missing.has(side < 0 ? 'leftUpperArm' : 'rightUpperArm')) continue;
      const stroke = Math.sin(body.crawlAge * 8 + (side < 0 ? 0 : Math.PI));
      for (const [index, forward, height] of [[elbow, 0.4, 0.23], [wrist, 0.56 + stroke * 0.16, 0.13 + Math.max(0, stroke) * 0.08]] as const) {
        const point = body.joints[index].position;
        const targetX = anchor.x + direction.x * forward + right.x * side * 0.42;
        const targetZ = anchor.z + direction.z * forward + right.z * side * 0.42;
        point.x += (targetX - point.x) * Math.min(0.22, step * 11);
        point.z += (targetZ - point.z) * Math.min(0.22, step * 11);
        point.y += (floor + height * body.size - point.y) * Math.min(0.22, step * 11);
      }
    }
  }

  private collide(joint: Joint, index: number, floorLevel: number, size: number, vehicles: readonly THREE.Group[]): void {
    const point = joint.position;
    const floor = floorLevel > 0 && this.prefabs.upperFloorPresent(point.x, point.z, floorLevel)
      ? this.prefabs.floorHeightAt(point.x,point.z,floorLevel)+.09 : this.prefabs.supportHeight(point.x,point.z,point.y);
    const radius = (index === 3 ? 0.29 : index === 0 || index === 1 ? 0.22 : index === 12 || index === 15 ? 0 : 0.12) * size;
    const surface = floor + radius;
    if (point.y < surface) {
      point.y = surface;
      const slip = 0.77;
      joint.previous.x = point.x + (joint.previous.x - point.x) * slip;
      joint.previous.z = point.z + (joint.previous.z - point.z) * slip;
      joint.previous.y = point.y + Math.min(0.035, Math.abs(joint.previous.y - point.y) * 0.11);
    }
    if (point.y > surface + 3.4) return;
    const bodyFloor = floorLevel > 0 && this.prefabs.upperFloorPresent(point.x, point.z, floorLevel)
      ? this.prefabs.floorHeightAt(point.x,point.z,floorLevel) : this.prefabs.supportHeight(point.x,point.z,point.y);
    if (this.openAt(point.x, point.z, bodyFloor, vehicles)) return;
    // Push each joint back against the occupied urban cell. A fallen body
    // cannot pass through walls, containers, furnishings or parked cars.
    const wasOpen = this.openAt(joint.previous.x, joint.previous.z, bodyFloor, vehicles);
    if (wasOpen) {
      point.x = joint.previous.x;
      point.z = joint.previous.z;
      return;
    }
    const cell = this.grid.cellAtWorld(point.x, point.z);
    if (!cell) return;
    const [cx, cz] = this.grid.world(cell.x, cell.z);
    const half = this.grid.cellSize / 2 + 0.12;
    const candidates = [
      [cx - half, point.z], [cx + half, point.z], [point.x, cz - half], [point.x, cz + half]
    ];
    candidates.sort((a, b) => Math.hypot(a[0] - point.x, a[1] - point.z) - Math.hypot(b[0] - point.x, b[1] - point.z));
    const clear = candidates.find(([x, z]) => this.openAt(x, z, bodyFloor, vehicles));
    if (clear) { point.x = clear[0]; point.z = clear[1]; }
  }

  private pose(body: RagdollBody): void {
    for (const link of body.links) {
      const a = body.joints[link.a].position, b = body.joints[link.b].position;
      const axis = TEMP.subVectors(b, a);
      link.mesh.position.copy(a).add(b).multiplyScalar(0.5);
      if (link.part === 'torso') {
        const up = axis.clone().normalize();
        const across = body.joints[7].position.clone().sub(body.joints[4].position);
        across.addScaledVector(up, -across.dot(up));
        if (across.lengthSq() < 0.001) across.copy(body.across);
        across.normalize();
        body.across.copy(across);
        const forward = across.clone().cross(up).normalize();
        across.crossVectors(up, forward).normalize();
        link.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, up, forward));
      } else link.mesh.quaternion.setFromUnitVectors(Y_AXIS, axis.normalize());
    }
    if (body.details[0]) body.details[0].position.copy(body.joints[3].position);
    for (const { mesh, joint } of body.woundMarks) mesh.position.copy(body.joints[joint].position);
    const torso = body.links.find((link) => link.part === 'torso');
    if (torso && body.details[0]) body.details[0].quaternion.copy(torso.mesh.quaternion);
  }
}
