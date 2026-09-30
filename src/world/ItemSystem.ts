import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import { GridSystem, type Cell } from './GridSystem';
import { InventorySystem, type PickupKind } from '../actors/InventorySystem';
import { voxelCuboid, voxelShape } from './VoxelSystem';

type Pickup = { kind: PickupKind; cell: Cell; group: THREE.Group; phase: number; collected: boolean };

const names: Record<PickupKind, string> = {
  smg: 'MUNICIÓN SMG', pistolAmmo: 'MUNICIÓN', smgAmmo: 'MUNICIÓN SMG', shotgunAmmo: 'CARTUCHOS', rifleAmmo: 'MUNICIÓN FUSIL', medkit: 'BOTIQUÍN',
  armor: 'CHALECO', supply: 'SUMINISTROS', charge: 'CARGAS'
};
const colors: Record<PickupKind, string> = {
  smg: '#f3b64e', pistolAmmo: '#e0bc75', smgAmmo: '#e79c56', shotgunAmmo: '#e89f64', rifleAmmo: '#a6c9d0', medkit: '#ee7773',
  armor: '#6cc9d1', supply: '#76da9c', charge: '#ec8f62'
};

export class ItemSystem {
  readonly pickups: Pickup[] = [];
  readonly shelter = new THREE.Vector3();
  private pending: Array<{ kind: PickupKind; gx: number; gz: number }> = [];
  private beacon: THREE.Group;
  private time = 0;

  constructor(private scene: THREE.Scene, private grid: GridSystem, private inventory: InventorySystem, private events: EventBus) {
    const park = grid.landmark('park');
    const [sx, sz] = grid.world(park.x, park.z);
    this.shelter.set(sx, this.grid.groundHeight(sx,sz), sz);
    this.beacon = new THREE.Group();
    const beam = voxelShape(0.25, 4.5, 0.25, new THREE.MeshBasicMaterial({ color: '#55e7cf', transparent: true, opacity: 0.33, depthWrite: false }));
    beam.position.y = 3.6; this.beacon.add(beam);
    const diamond = voxelShape(0.82, 0.82, 0.82, new THREE.MeshStandardMaterial({ color: '#70f5d5', emissive: '#2dcbb1', emissiveIntensity: 1.2 }));
    diamond.position.y = 6.3; this.beacon.add(diamond);
    this.beacon.position.copy(this.shelter);
    scene.add(this.beacon);
    const c = grid.center;
    this.place('smg', c + 2, c + 1);
    this.place('medkit', c + 1, c - 5);
    this.place('armor', c - 5, c + 1);
    this.place('supply', c, c + 1);
    this.place('supply', c + 13, c - 6);
    this.place('supply', c + 15, c + 15);
    this.place('pistolAmmo', c - 12, c - 6);
    this.place('smgAmmo', c + 11, c + 2);
    this.place('shotgunAmmo', c - 7, c + 9);
    this.place('rifleAmmo', c + 10, c - 8);
    this.place('charge', park.x + 1, park.z + 1);
    events.on('terrainChanged', () => this.flushPending());
  }

  private place(kind: PickupKind, gx: number, gz: number): void {
    const original = this.grid.cell(gx, gz);
    if (!original?.active) { this.pending.push({ kind, gx, gz }); return; }
    const nearby: Cell[] = [];
    for (let z = gz - 3; z <= gz + 3; z++) for (let x = gx - 3; x <= gx + 3; x++) {
      const candidate = this.grid.cell(x, z);
      if (candidate?.active && !candidate.blocked && !candidate.rubble && !this.pickups.some((pickup) => pickup.cell === candidate)) nearby.push(candidate);
    }
    nearby.sort((a, b) => Math.abs(a.x - gx) + Math.abs(a.z - gz) - Math.abs(b.x - gx) - Math.abs(b.z - gz));
    const cell = nearby[0];
    if (!cell) { this.pending.push({ kind, gx, gz }); return; }
    const [x, z] = this.grid.world(cell.x, cell.z);
    const group = new THREE.Group();
    const base = voxelCuboid(0.9, 0.72, 0.7, colors[kind], 0.45);
    base.castShadow = true; group.add(base);
    const trim = voxelShape(1.02, 0.15, 0.8, new THREE.MeshStandardMaterial({ color: '#263e45', roughness: 0.68 }));
    trim.position.y = 0.2; group.add(trim);
    if (kind === 'medkit') {
      const crossV = voxelShape(0.16, 0.49, 0.05, new THREE.MeshBasicMaterial({ color: '#fff7e9' }));
      const crossH = voxelShape(0.43, 0.15, 0.05, new THREE.MeshBasicMaterial({ color: '#fff7e9' }));
      crossV.position.z = 0.38; crossH.position.z = 0.4; group.add(crossV, crossH);
    }
    if (kind === 'smg') {
      const barrel = voxelShape(0.16, 0.17, 0.85, new THREE.MeshStandardMaterial({ color: '#263b43', metalness: 0.42 }));
      barrel.position.set(0, 0.3, 0.5); group.add(barrel);
    }
    const glow = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.66, 24), new THREE.MeshBasicMaterial({ color: colors[kind], side: THREE.DoubleSide, transparent: true, opacity: 0.66, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2; glow.position.y = -0.7; group.add(glow);
    group.position.set(x, this.grid.groundHeight(x,z)+1.1, z);
    this.scene.add(group);
    this.pickups.push({ kind, cell, group, phase: this.grid.random() * Math.PI * 2, collected: false });
  }

  private flushPending(): void {
    const pending = this.pending;
    this.pending = [];
    for (const item of pending) this.place(item.kind, item.gx, item.gz);
  }

  update(dt: number, visibleAt?: (x: number, z: number) => boolean): void {
    this.time += dt;
    this.beacon.visible = visibleAt?.(this.shelter.x, this.shelter.z) ?? true;
    if (this.beacon.visible) {
      this.beacon.children[1].rotation.y += dt;
      this.beacon.children[1].position.y = 6.3 + Math.sin(this.time * 2.2) * 0.18;
    }
    for (const pickup of this.pickups) {
      if (pickup.collected) continue;
      pickup.group.visible = visibleAt?.(pickup.group.position.x, pickup.group.position.z) ?? true;
      if (!pickup.group.visible) continue;
      pickup.group.rotation.y += dt * 0.7;
      pickup.group.position.y = this.grid.groundHeight(pickup.group.position.x,pickup.group.position.z)+1.1 + Math.sin(this.time * 2.4 + pickup.phase) * 0.16;
    }
  }

  prompt(position: THREE.Vector3): string | null {
    const pickup = this.nearest(position);
    if (pickup) return `E · RECOGER ${names[pickup.kind]}`;
    if (this.inventory.supplies >= 3 && !this.inventory.delivered && position.distanceTo(this.shelter) < 5) return 'E · ENTREGAR SUMINISTROS';
    return null;
  }

  interact(position: THREE.Vector3): string | null {
    const pickup = this.nearest(position);
    if (pickup) {
      pickup.collected = true;
      this.scene.remove(pickup.group);
      return this.inventory.pickup(pickup.kind);
    }
    if (this.inventory.supplies >= 3 && !this.inventory.delivered && position.distanceTo(this.shelter) < 5) {
      this.inventory.delivered = true;
      this.inventory.supplies = 0;
      this.events.emit('alert', { text: 'ENCARGO COMPLETADO · REFUGIO ABASTECIDO', tone: 'success' });
      return 'ENCARGO COMPLETADO · REFUGIO ABASTECIDO';
    }
    return null;
  }

  private nearest(position: THREE.Vector3): Pickup | undefined {
    return this.pickups.find((pickup) => !pickup.collected && pickup.group.position.distanceTo(position) < 3.25);
  }
}
