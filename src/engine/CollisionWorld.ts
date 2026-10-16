import * as THREE from 'three';

export type AddCollisionBox = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
  yaw?: number, originX?: number, originZ?: number) => void;
export type CollisionQuery = (bounds: THREE.Box3, add: AddCollisionBox) => void;
type Collider = { box: THREE.Box3; yaw: number; x: number; z: number };
export type CapsuleContact = { position: THREE.Vector3; grounded: boolean; ceiling: boolean; blocked: boolean; recovered?:boolean };

/** Logical occupied volumes, independent of render meshes, LOD and worker latency.
 * A vertical capsule becomes a sphere against a box extended along its segment.
 * Conservative advancement covers the entire displacement, including thin walls. */
export class CollisionWorld {
  private readonly boxes: Collider[] = [];
  private count = 0;
  private readonly bounds = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly localDelta = new THREE.Vector3();
  private readonly hitNormal = new THREE.Vector3();
  private readonly add: AddCollisionBox = (a, b, c, d, e, f, yaw = 0, x = 0, z = 0) => {
    const collider = this.boxes[this.count] ?? (this.boxes[this.count] = { box: new THREE.Box3(), yaw: 0, x: 0, z: 0 });
    collider.box.min.set(a, b, c); collider.box.max.set(d, e, f);
    collider.yaw = yaw; collider.x = x; collider.z = z; this.count++;
  };
  constructor(private readonly query: CollisionQuery) {}

  private collect(position: THREE.Vector3, delta: THREE.Vector3, radius: number, height: number): void {
    this.bounds.min.set(Math.min(position.x, position.x + delta.x) - radius - .002,
      Math.min(position.y, position.y + delta.y) - .002, Math.min(position.z, position.z + delta.z) - radius - .002);
    this.bounds.max.set(Math.max(position.x, position.x + delta.x) + radius + .002,
      Math.max(position.y, position.y + delta.y) + height + .002, Math.max(position.z, position.z + delta.z) + radius + .002);
    this.count = 0; this.query(this.bounds, this.add);
  }

  /** Signed sphere distance to the vertically extended box; normal points out. */
  private distance(collider: Collider, position: THREE.Vector3, radius: number, height: number): number {
    const { box, yaw, x, z } = collider, c = Math.cos(yaw), s = Math.sin(yaw);
    const dx = position.x - x, dz = position.z - z;
    this.point.set(dx * c - dz * s, position.y + radius, dx * s + dz * c);
    const minY = box.min.y - Math.max(0, height - 2 * radius);
    const px = this.point.x, py = this.point.y, pz = this.point.z;
    this.normal.set(px - THREE.MathUtils.clamp(px, box.min.x, box.max.x),
      py - THREE.MathUtils.clamp(py, minY, box.max.y), pz - THREE.MathUtils.clamp(pz, box.min.z, box.max.z));
    let distance = this.normal.length();
    if (distance > 1e-10) this.normal.multiplyScalar(1 / distance);
    else {
      const gaps = [px - box.min.x, box.max.x - px, py - minY, box.max.y - py, pz - box.min.z, box.max.z - pz];
      let side = 0;
      for (let i = 1; i < 6; i++) if (gaps[i] < gaps[side]) side = i;
      this.normal.set(0, 0, 0); this.normal.setComponent(Math.floor(side / 2), side % 2 ? 1 : -1);
      distance = -gaps[side];
    }
    const nx = this.normal.x, nz = this.normal.z;
    this.normal.x = nx * c + nz * s; this.normal.z = -nx * s + nz * c;
    return distance - radius;
  }

  overlaps(position: THREE.Vector3, radius: number, height: number): boolean {
    this.localDelta.set(0, 0, 0); this.collect(position, this.localDelta, radius, height);
    for (let i = 0; i < this.count; i++) if (this.distance(this.boxes[i], position, radius, height) < -.003) return true;
    return false;
  }

  move(position: THREE.Vector3, displacement: THREE.Vector3, radius: number, height: number): CapsuleContact {
    const result: CapsuleContact = { position: position.clone(), grounded: false, ceiling: false, blocked: false };
    const remaining = displacement.clone(), probe = new THREE.Vector3();
    this.collect(position, displacement, radius, height);
    // Repair small initial penetrations, e.g. after spawning or a moving car.
    for (let iteration = 0; iteration < 5; iteration++) {
      let depth = .003;
      for (let i = 0; i < this.count; i++) {
        const penetration = -this.distance(this.boxes[i], result.position, radius, height);
        if (penetration > depth) { depth = penetration; this.hitNormal.copy(this.normal); }
      }
      if (depth <= .003) break;
      result.position.addScaledVector(this.hitNormal, Math.min(depth + .001, .6));
    }
    let trapped=false;
    for(let i=0;i<this.count;i++)if(this.distance(this.boxes[i],result.position,radius,height)<-.004){trapped=true;break;}
    if(trapped) {
      // Opposing contacts (floor plus a low stair, or a moving vehicle) can
      // cancel each other's push-outs. Recover to the nearest clear local pose.
      const base=result.position.clone();base.y=Math.max(base.y,position.y);let found=false;
      for(let reach=.25;reach<=1.51&&!found;reach+=.25)for(let direction=0;direction<8&&!found;direction++)for(const rise of [0,.22,.44]) {
        probe.set(base.x+Math.cos(direction*Math.PI/4)*reach,base.y+rise,base.z+Math.sin(direction*Math.PI/4)*reach);
        if(!this.overlaps(probe,radius,height)) {result.position.copy(probe);result.recovered=true;found=true;break;}
      }
      this.collect(result.position,displacement,radius,height);
    }
    for (let slide = 0; slide < 5 && remaining.lengthSq() > 1e-12; slide++) {
      let time = 1, hit = false;
      for (let i = 0; i < this.count; i++) {
        let t = 0;
        for (let iteration = 0; iteration < 24 && t <= time; iteration++) {
          probe.copy(result.position).addScaledVector(remaining, t);
          const distance = this.distance(this.boxes[i], probe, radius, height);
          const closing = -remaining.dot(this.normal);
          if (closing <= 1e-10) break;
          if (distance <= .0011) {
            time = t; this.hitNormal.copy(this.normal); hit = true; break;
          }
          t += Math.max(1e-8, (distance - .001) / closing);
        }
      }
      result.position.addScaledVector(remaining, time);
      if (!hit) break;
      result.blocked = true;
      if (this.hitNormal.y > .55) result.grounded = true;
      if (this.hitNormal.y < -.55) result.ceiling = true;
      remaining.multiplyScalar(1 - time);
      const into = remaining.dot(this.hitNormal);
      if (into < 0) remaining.addScaledVector(this.hitNormal, -into);
    }
    return result;
  }

  /** Move up/forward/down only when that path is clear and has a landing. */
  moveCharacter(position: THREE.Vector3, delta: THREE.Vector3, radius: number, height: number, grounded: boolean, step = .52): CapsuleContact {
    const base = this.move(position, delta, radius, height);
    if (!grounded || delta.y > .01 || !base.blocked || Math.hypot(delta.x, delta.z) < 1e-5) return base;
    const baseProgress = Math.hypot(base.position.x - position.x, base.position.z - position.z);
    if (baseProgress >= Math.hypot(delta.x, delta.z) * .98) return base;
    const up = this.move(position, new THREE.Vector3(0, step, 0), radius, height);
    if (up.ceiling || up.position.y < position.y + step - .005) return base;
    const across = this.move(up.position, new THREE.Vector3(delta.x, 0, delta.z), radius, height);
    const down = this.move(across.position, new THREE.Vector3(0, -step + Math.min(0, delta.y) - .015, 0), radius, height);
    const progress = Math.hypot(down.position.x - position.x, down.position.z - position.z);
    // A rounded capsule can land on a tread edge before its normal becomes
    // vertical. A downward hit still provides support; an empty drop does not.
    const supported=down.grounded || (down.blocked&&!down.ceiling&&down.position.y>=position.y-.05);
    if(supported&&progress>baseProgress+.001){down.grounded=true;return down;}
    return base;
  }

  sweepSphere(from: THREE.Vector3, to: THREE.Vector3, radius: number): THREE.Vector3 {
    const feet = from.clone(); feet.y -= radius;
    return this.move(feet, to.clone().sub(from), radius, radius * 2).position.add(new THREE.Vector3(0, radius, 0));
  }
}
