import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import { GridSystem } from './GridSystem';
import { PrefabManager, type InteriorPiece, type Voxel } from './PrefabManager';
import { FLOOR_HEIGHT, VOXEL_SIZE } from './VoxelConstants';
import { CANAL_SURFACE_Y } from './CanalWater';

type Debris = { position: THREE.Vector3; velocity: THREE.Vector3; spin: number; angle: number; age: number; settled: boolean };
type Ring = { mesh: THREE.Mesh; age: number };
const MAX_DEBRIS = 180;
const DEBRIS_LIFE = 2.6;
const BILLBOARD_AXIS = new THREE.Vector3(0, 0, 1);

export class DestructionSystem {
  private debris: Debris[] = [];
  private nextDebris = 0;
  private debrisMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.22, 0.22),
    new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, depthWrite: false }), MAX_DEBRIS);
  private dummy = new THREE.Object3D();
  private waterCurrent = new THREE.Vector3();
  private billboardSpin = new THREE.Quaternion();
  private rings: Ring[] = [];

  constructor(private scene: THREE.Scene, private grid: GridSystem, private prefabs: PrefabManager, private events: EventBus) {
    this.debrisMesh.name = 'destruction-debris-billboards';
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.count = 0;
    this.debrisMesh.frustumCulled = false;
    this.scene.add(this.debrisMesh);
  }

  /** Fragments are visual; pedestrians, vehicles and route finding ignore them. */
  get colliders(): THREE.Object3D[] { return []; }

  damageInterior(piece: InteriorPiece, amount: number, sub = 0): boolean {
    if (!piece.alive || sub < 0 || sub >= piece.mask.length || !piece.mask[sub]) return false;
    this.prefabs.preparePieceDamage(piece);
    piece.health[sub] -= amount;
    if (piece.health[sub] > 0) return false;
    const point = this.prefabs.sceneVoxelPosition(piece, sub);
    this.prefabs.eraseSceneVoxels(piece, [sub]);
    this.spawnDebris(point, this.sceneColor(piece, sub));
    if (this.prefabs.vehicleDisabled(piece)) this.scatterDisabledVehicle(piece);
    const reopened = this.prefabs.takeNavigationChanges();
    if (reopened.length) this.events.emit('terrainChanged', { cells: reopened });
    return true;
  }

  damageVehicleImpact(vehicle: THREE.Group, toward: THREE.Vector3, speed: number): number {
    if (vehicle.userData.destroyed || speed < 2.4) return 0;
    const specs = vehicle.userData.vehicle as { length: number; width: number } | undefined;
    if (!specs) return 0;
    const direction = toward.clone().setY(0);
    if (direction.lengthSq() < 0.001) direction.set(Math.sin(vehicle.rotation.y), 0, Math.cos(vehicle.rotation.y));
    direction.normalize();
    const forward = new THREE.Vector3(Math.sin(vehicle.rotation.y), 0, Math.cos(vehicle.rotation.y));
    const side = new THREE.Vector3(forward.z, 0, -forward.x);
    const along = direction.dot(forward), across = direction.dot(side);
    const reach = 1 / Math.max(Math.abs(along) / (specs.length / 2), Math.abs(across) / (specs.width / 2));
    const contact = vehicle.position.clone().addScaledVector(direction, reach);
    contact.y += 0.72;
    const limit = THREE.MathUtils.clamp(Math.round(speed * 0.9), 4, 16);
    let removed = 0;
    for (const piece of this.prefabs.vehicleDamageParts(vehicle)) {
      if (!piece.alive) continue;
      const hits = this.prefabs.sceneVoxelsInRadius(piece, contact, 0.75)
        .sort((a, b) => a.point.distanceToSquared(contact) - b.point.distanceToSquared(contact))
        .slice(0, limit);
      if (!hits.length) continue;
      this.prefabs.eraseSceneVoxels(piece, hits.map((hit) => hit.sub));
      for (const hit of hits) this.spawnDebris(hit.point, this.sceneColor(piece, hit.sub), direction.x, direction.z);
      removed += hits.length;
      if (this.prefabs.vehicleDisabled(piece)) this.scatterDisabledVehicle(piece);
      break;
    }
    return removed;
  }

  damageVoxel(index: number, amount: number, sub = 0): boolean {
    const voxel = this.prefabs.voxels[index];
    if (!voxel || !this.prefabs.pieceVisible(voxel, sub)) return false;
    voxel.pieces[sub] -= amount;
    if (voxel.pieces[sub] > 0) { this.prefabs.tintPiece(index, sub); return false; }
    voxel.damaged = true;
    const impact = this.prefabs.piecePosition(voxel, sub);
    const exhausted = !this.prefabs.hasPieces(voxel);
    if (exhausted) voxel.alive = false;
    if (exhausted) this.scatterUnsupported(this.prefabs.attachedPieces(voxel));
    this.prefabs.writeVoxel(index);
    this.spawnDebris(impact, voxel.color, impact.x - voxel.x, impact.z - voxel.z);
    if (exhausted && voxel.structural !== false && voxel.y-(voxel.baseY??0) < FLOOR_HEIGHT) {
      for (const aboveIndex of this.prefabs.voxelIndexesInCell(voxel.cellIndex)) {
        const above = this.prefabs.voxels[aboveIndex];
        if (!above.alive || above.cellIndex !== voxel.cellIndex || above.y <= voxel.y) continue;
        this.scatterModule(above, impact.x, impact.z);
        above.alive = false;
        this.prefabs.writeVoxel(aboveIndex);
      }
    }
    if (exhausted && voxel.structural !== false) {
      if (!this.prefabs.voxelIndexesInCell(voxel.cellIndex).some((part) => {
        const candidate = this.prefabs.voxels[part];
        return candidate.structural !== false && candidate.alive && candidate.y-(candidate.baseY??0) < FLOOR_HEIGHT;
      })) this.grid.cells[voxel.cellIndex].blocked = false;
      this.scatterUnsupported(this.prefabs.refreshDecorations());
      this.events.emit('terrainChanged', { cells: [voxel.cellIndex, ...this.prefabs.takeNavigationChanges()] });
    }
    return true;
  }

  damageRoadSurface(x: number, z: number, amount: number): boolean {
    const color = this.prefabs.damageRoadSurface(x, z, amount);
    if (!color) return false;
    this.spawnDebris(new THREE.Vector3(x, this.grid.groundHeight(x, z) + 0.035, z), color);
    return true;
  }

  blast(x: number, z: number, radius = 4.1, source: 'player' | 'enemy' = 'player', y = 0.9): number {
    if (y - this.grid.groundHeight(x, z) < 2.2) this.prefabs.scorchGround(x, z, radius * 0.8);
    const changed = new Set<number>();
    let destroyed = 0;
    for (const index of this.prefabs.voxelIndexesNear(x, z, radius + 1.7)) {
      const voxel = this.prefabs.voxels[index];
      if (!voxel.alive || Math.hypot(voxel.x - x, voxel.z - z) > radius + 1.7) continue;
      let hit = false, emitted = false;
      let first: THREE.Vector3 | null = null;
      for (let sub = 0; sub < voxel.pieces.length; sub++) {
        if (!this.prefabs.pieceVisible(voxel, sub)) continue;
        const point = this.prefabs.piecePosition(voxel, sub);
        const distance = Math.hypot(point.x - x, point.z - z, (point.y - y) * 0.72);
        if (distance > radius) continue;
        voxel.pieces[sub] = 0;
        destroyed++; hit = true;
        first ||= point;
        if (sub % 9 === 0) { this.spawnDebris(point, voxel.color, point.x - x, point.z - z); emitted = true; }
      }
      if (!hit) continue;
      if (!emitted && first) this.spawnDebris(first, voxel.color, first.x - x, first.z - z);
      voxel.damaged = true;
      voxel.alive = this.prefabs.hasPieces(voxel);
      if (!voxel.alive) this.scatterUnsupported(this.prefabs.attachedPieces(voxel));
      this.prefabs.writeVoxel(index);
      if (voxel.structural !== false) changed.add(voxel.cellIndex);
    }
    const explosion = new THREE.Vector3(x, y, z);
    for (const piece of this.prefabs.interiorPiecesNear(x, z, radius + 5)) {
      if (!piece.alive || piece.bounds.distanceToPoint(explosion) > radius + 1) continue;
      const removed: number[] = [];
      let emitted = false;
      let first: THREE.Vector3 | null = null;
      for (const { sub, point } of this.prefabs.sceneVoxelsInRadius(piece, explosion, radius)) {
        removed.push(sub);
        first ||= point;
        if (sub % 9 === 0) { this.spawnDebris(point, this.sceneColor(piece, sub), point.x - x, point.z - z); emitted = true; }
      }
      if (!removed.length) continue;
      if (!emitted && first) this.spawnDebris(first, this.sceneColor(piece, removed[0]), first.x - x, first.z - z);
      this.prefabs.eraseSceneVoxels(piece, removed);
      destroyed += removed.length;
      if (this.prefabs.vehicleDisabled(piece)) this.scatterDisabledVehicle(piece);
    }
    // Only actual building structure changes navigation. Debris never marks a cell blocked.
    changed.forEach((cellIndex) => {
      const column = this.prefabs.voxelIndexesInCell(cellIndex).filter((index) => this.prefabs.voxels[index].structural !== false);
      const ground = column.find((index) => this.prefabs.voxels[index].y-(this.prefabs.voxels[index].baseY??0) < FLOOR_HEIGHT);
      if (ground !== undefined && !this.prefabs.voxels[ground].alive) {
        for (const voxelIndex of column) {
          const voxel = this.prefabs.voxels[voxelIndex];
          if (!voxel.alive || voxel.y-(voxel.baseY??0) < FLOOR_HEIGHT) continue;
          this.scatterModule(voxel, x, z);
          voxel.alive = false;
          this.prefabs.writeVoxel(voxelIndex);
        }
      }
      if (!column.some((index) => this.prefabs.voxels[index].alive && this.prefabs.voxels[index].y-(this.prefabs.voxels[index].baseY??0) < FLOOR_HEIGHT)) this.grid.cells[cellIndex].blocked = false;
    });
    if (changed.size) this.scatterUnsupported(this.prefabs.refreshDecorations());
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.1, 48), new THREE.MeshBasicMaterial({ color: source === 'player' ? '#52e4d1' : '#ff9466', transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, Math.max(this.prefabs.supportHeight(x,z,y)+0.08, y + 0.08), z);
    this.scene.add(ring);
    this.rings.push({ mesh: ring, age: 0 });
    this.events.emit('blast', { x, z, radius: radius * 2.4, source });
    for (const prop of this.prefabs.interactiveProps) {
      if (!prop.active || Math.hypot(prop.position.x - x, prop.position.z - z) > radius) continue;
      prop.active = false;
      prop.mesh.visible = false;
      this.events.emit('environment', { x: prop.position.x, z: prop.position.z, kind: prop.kind });
      this.events.emit('alert', { text: prop.kind === 'water' ? 'HIDRANTE ROTO · CALLE INUNDADA' : 'FALLA ELÉCTRICA · ZONA PELIGROSA', tone: 'danger' });
      const effect = new THREE.Mesh(new THREE.RingGeometry(0.6, 1, 32), new THREE.MeshBasicMaterial({ color: prop.kind === 'water' ? '#5bcfe0' : '#f4da70', transparent: true, opacity: 0.88, side: THREE.DoubleSide, depthWrite: false }));
      effect.rotation.x = -Math.PI / 2;
      effect.position.set(prop.position.x, this.prefabs.supportHeight(prop.position.x,prop.position.z,prop.position.y)+0.23, prop.position.z);
      this.scene.add(effect);
      this.rings.push({ mesh: effect, age: 0 });
    }
    for (const cell of this.prefabs.takeNavigationChanges()) changed.add(cell);
    if (changed.size) this.events.emit('terrainChanged', { cells: [...changed] });
    return destroyed;
  }

  private sceneColor(piece: InteriorPiece, sub = 0): THREE.Color {
    if (piece.palette) return new THREE.Color().setRGB(piece.palette[sub * 3], piece.palette[sub * 3 + 1], piece.palette[sub * 3 + 2]);
    const paint = piece.mesh.material;
    if (!Array.isArray(paint) && 'color' in paint && paint.color instanceof THREE.Color) return paint.color;
    return new THREE.Color('#ab9f91');
  }

  private scatterModule(voxel: Voxel, x: number, z: number): void {
    let emitted = false;
    for (let sub = 0; sub < voxel.pieces.length; sub++) {
      if (!this.prefabs.pieceVisible(voxel, sub) || sub % 3 !== 0) continue;
      const point = this.prefabs.piecePosition(voxel, sub);
      this.spawnDebris(point, voxel.color, point.x - x, point.z - z);
      emitted = true;
    }
    if (!emitted && voxel.pieces.length) {
      const point = this.prefabs.piecePosition(voxel, 0);
      this.spawnDebris(point, voxel.color);
    }
    this.scatterUnsupported(this.prefabs.attachedPieces(voxel));
  }

  private scatterUnsupported(pieces: InteriorPiece[]): void {
    for (const piece of pieces) {
      const paint = this.sceneColor(piece);
      const removed: number[] = [];
      let emitted = false;
      for (let sub = 0; sub < piece.mask.length; sub++) {
        if (!piece.mask[sub]) continue;
        removed.push(sub);
        if (sub % 9 !== 0) continue;
        this.spawnDebris(this.prefabs.sceneVoxelPosition(piece, sub), piece.palette ? this.sceneColor(piece, sub) : paint);
        emitted = true;
      }
      if (!emitted && removed.length) this.spawnDebris(this.prefabs.sceneVoxelPosition(piece, removed[0]), this.sceneColor(piece, removed[0]));
      this.prefabs.eraseSceneVoxels(piece, removed);
    }
  }

  private scatterDisabledVehicle(core: InteriorPiece): void {
    const disabled = this.prefabs.disableVehicle(core);
    if (!disabled) return;
    if (disabled.cells.length) this.events.emit('terrainChanged', { cells: disabled.cells });
  }

  /** Surviving exposed voxel tops become stable anchors for explosion flames. */
  fireAnchors(center: THREE.Vector3, radius = 5.5): THREE.Vector3[] {
    const candidates: THREE.Vector3[] = [];
    for (const index of this.prefabs.voxelIndexesNear(center.x, center.z, radius + 1)) {
      const voxel = this.prefabs.voxels[index];
      if (!voxel.alive) continue;
      for (let sub = 0; sub < voxel.pieces.length; sub++) {
        if (!this.prefabs.pieceVisible(voxel, sub)) continue;
        const position = this.prefabs.piecePosition(voxel, sub);
        if (position.distanceTo(center) > radius) continue;
        candidates.push(position.add(new THREE.Vector3(0, voxel.voxelSize / 2 + 0.04, 0)));
      }
    }
    for (const piece of this.prefabs.interiorPiecesNear(center.x, center.z, radius + 1)) {
      if (!piece.alive) continue;
      const { nx, ny, nz } = piece.dimensions;
      for (const { sub, point: position } of this.prefabs.sceneVoxelsInRadius(piece, center, radius)) {
        if (Math.floor(sub / (nx * nz)) + 1 < ny && piece.mask[sub + nx * nz]) continue;
        candidates.push(position.add(new THREE.Vector3(0, (piece.dimensions.voxelSize ?? VOXEL_SIZE) / 2 + 0.04, 0)));
      }
    }
    const exposed = new Map<string, THREE.Vector3>();
    for (const point of candidates) {
      const key = `${Math.round(point.x / VOXEL_SIZE)}:${Math.round(point.z / VOXEL_SIZE)}`;
      if (point.y > (exposed.get(key)?.y ?? -Infinity)) exposed.set(key, point);
    }
    const tops = [...exposed.values()].sort((a, b) => a.distanceToSquared(center) - b.distanceToSquared(center));
    const selected: THREE.Vector3[] = [];
    for (const point of tops) {
      if (selected.every((other) => other.distanceToSquared(point) > 0.65 * 0.65)) selected.push(point);
      if (selected.length === 8) break;
    }
    return selected;
  }

  private spawnDebris(point: THREE.Vector3, paint: THREE.Color, dx = 0, dz = 0): void {
    const index = this.debris.length < MAX_DEBRIS ? this.debris.length : this.nextDebris++ % MAX_DEBRIS;
    const particle: Debris = {
      position: point.clone(), velocity: new THREE.Vector3(dx * 0.45 + (this.grid.random() - 0.5) * 3.1, 2.4 + this.grid.random() * 4, dz * 0.45 + (this.grid.random() - 0.5) * 3.1),
      spin: (this.grid.random() - 0.5) * 9, angle: 0, age: 0, settled: false
    };
    this.debris[index] = particle;
    this.debrisMesh.count = this.debris.length;
    this.debrisMesh.setColorAt(index, paint);
    if (this.debrisMesh.instanceColor) this.debrisMesh.instanceColor.needsUpdate = true;
  }

  update(dt: number, camera: THREE.Camera): void {
    for (let index = this.debris.length - 1; index >= 0; index--) {
      const item = this.debris[index];
      item.age += dt;
      if (item.age >= DEBRIS_LIFE) {
        const last = this.debris.pop()!;
        if (index < this.debris.length) {
          this.debris[index] = last;
          const lastColor = new THREE.Color();
          this.debrisMesh.getColorAt(this.debris.length, lastColor);
          this.debrisMesh.setColorAt(index, lastColor);
          if (this.debrisMesh.instanceColor) this.debrisMesh.instanceColor.needsUpdate = true;
        }
        continue;
      }
      const inWater=this.grid.water.currentAt(item.position.x,item.position.y,item.position.z,this.waterCurrent);
      if(inWater) item.settled=false;
      if (!item.settled) {
        if(inWater) {
          item.velocity.x=THREE.MathUtils.lerp(item.velocity.x,this.waterCurrent.x,Math.min(1,dt*5));
          item.velocity.z=THREE.MathUtils.lerp(item.velocity.z,this.waterCurrent.z,Math.min(1,dt*5));
          item.velocity.y+=(CANAL_SURFACE_Y+.1-item.position.y)*dt*8-item.velocity.y*dt*2;
        } else item.velocity.y -= 18 * dt;
        item.position.addScaledVector(item.velocity, dt);
        item.angle += item.spin * dt;
        const floor=inWater?CANAL_SURFACE_Y+.1:this.prefabs.supportHeight(item.position.x,item.position.z,item.position.y)+.14;
        if (item.position.y < floor) {
          item.position.y = floor;
          if(inWater) item.velocity.y=0;
          else {
            item.velocity.multiplyScalar(0.22);
            item.velocity.y = Math.abs(item.velocity.y) * 0.2;
            if (item.age > 1.1 || item.velocity.length() < 0.9) item.settled = true;
          }
        }
      }
      this.dummy.position.copy(item.position);
      this.dummy.quaternion.copy(camera.quaternion).multiply(this.billboardSpin.setFromAxisAngle(BILLBOARD_AXIS, item.angle));
      this.dummy.scale.setScalar(Math.min(1, (DEBRIS_LIFE - item.age) * 2.5));
      this.dummy.updateMatrix();
      this.debrisMesh.setMatrixAt(index, this.dummy.matrix);
    }
    this.debrisMesh.count = this.debris.length;
    if (this.debris.length) this.debrisMesh.instanceMatrix.needsUpdate = true;
    for (const ring of this.rings) {
      ring.age += dt;
      ring.mesh.scale.setScalar(1 + ring.age * 4);
      (ring.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 - ring.age * 1.5);
    }
    this.rings = this.rings.filter((ring) => {
      if (ring.age < 0.57) return true;
      this.scene.remove(ring.mesh);
      ring.mesh.geometry.dispose(); (ring.mesh.material as THREE.Material).dispose();
      return false;
    });
  }
}
