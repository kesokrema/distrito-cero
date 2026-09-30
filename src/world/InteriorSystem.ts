import * as THREE from 'three';
import { InventorySystem } from '../actors/InventorySystem';
import { LocomotionIK } from '../actors/LocomotionIK';
import { PrefabManager, type InteriorStation } from './PrefabManager';

const labels: Record<InteriorStation['kind'], string> = {
  shop: 'RECOGER MUNICIÓN',
  rest: 'DESCANSAR',
  reception: 'REGISTRARSE EN EL HOTEL',
  workshop: 'USAR EL TALLER',
  cabinet: 'ABRIR EL BOTIQUÍN',
  supply: 'RECOGER CARGAS'
};

export class InteriorSystem {
  constructor(private prefabs: PrefabManager, private inventory: InventorySystem, private player: LocomotionIK) {}

  update(): void {
    if (this.player.floorLevel === 0) return;
    const position = this.player.group.position;
    if(this.prefabs.grid.surfaces.reachable(position.x,position.z,position.y))return;
    // Walking a stair landing or an outer room cell must never move the player
    // horizontally. LocomotionIK already handles missing slabs one floor at a time.
    if (this.prefabs.upperFloorPresent(position.x, position.z, this.player.floorLevel) ||
        this.prefabs.stairSurface(position.x, position.z, position.y)) return;
    // Locomotion owns gravity and support loss; never teleport between floors here.
  }

  prompt(position: THREE.Vector3): string | null {
    const stairs = this.nearestStairs(position);
    if (stairs) return 'ESCALERAS · CAMINA POR LOS PELDAÑOS';
    const station = this.nearest(position);
    return station ? `E · ${labels[station.kind]}` : null;
  }

  interact(position: THREE.Vector3, _descend = false): string | null {
    const station = this.nearest(position);
    if (!station) return null;
    station.used = true;
    if (station.kind === 'shop') {
      this.inventory.reserve.pistol += 18;
      if (this.inventory.unlocked.has('smg')) this.inventory.reserve.smg += 30;
      return 'MUNICIÓN RECOGIDA EN EL LOCAL';
    }
    if (station.kind === 'workshop') {
      this.inventory.armor = Math.min(100, this.inventory.armor + 35);
      return 'EQUIPO REPARADO EN EL TALLER';
    }
    if (station.kind === 'supply') {
      return 'CARGAS DISPONIBLES SIN LÍMITE';
    }
    if (station.kind === 'cabinet') {
      this.inventory.medkits++;
      return 'BOTIQUÍN RECOGIDO DEL ARMARIO';
    }
    if (station.kind === 'reception') {
      this.player.health = Math.min(100, this.player.health + 45);
      this.player.stamina = 100;
      return 'HABITACIÓN ASIGNADA · TE HAS RECUPERADO';
    }
    this.player.health = Math.min(100, this.player.health + 35);
    this.player.stamina = 100;
    return 'HAS DESCANSADO EN LA VIVIENDA';
  }

  private nearestStairs(position: THREE.Vector3) {
    const cell = this.prefabs.grid.cellAtWorld(position.x, position.z);
    if (!cell) return undefined;
    return this.prefabs.staircases.find((stairs) =>
      stairs.group.parent?.visible !== false &&
      cell.x > stairs.room.x0 && cell.x < stairs.room.x1 - 1 &&
      cell.z > stairs.room.z0 && cell.z < stairs.room.z1 - 1 &&
      Math.hypot(stairs.position.x - position.x, stairs.position.z - position.z) < 1.55
    );
  }

  private nearest(position: THREE.Vector3): InteriorStation | undefined {
    const cell = this.prefabs.grid.cellAtWorld(position.x, position.z);
    if (!cell) return undefined;
    let closest: InteriorStation | undefined;
    let distance = 2.85;
    for (const station of this.prefabs.interiorStations) {
      if (station.used || !this.prefabs.stationIntact(station) || station.group.parent?.visible === false || station.group.parent?.parent?.visible === false) continue;
      if (cell.x <= station.room.x0 || cell.x >= station.room.x1 - 1 || cell.z <= station.room.z0 || cell.z >= station.room.z1 - 1) continue;
      const current = station.position.distanceTo(position);
      if (current < distance) { closest = station; distance = current; }
    }
    return closest;
  }
}
