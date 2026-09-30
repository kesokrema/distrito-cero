import * as THREE from 'three';
import type { PrefabManager, CityLightAnchor } from '../world/PrefabManager';
import type { CityClock } from './CityClock';

/** Reuses a small light pool for the fixtures closest to the camera. */
export class CityLightSystem {
  private readonly lights: THREE.PointLight[] = [];
  private elapsed = 0;
  private readonly origin = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private prefabs: PrefabManager) {
    for (let i = 0; i < 12; i++) {
      const light = new THREE.PointLight('#ffe0a4', 0, 10, 2);
      light.castShadow = false;
      light.visible = false;
      scene.add(light);
      this.lights.push(light);
    }
  }

  update(dt: number, focus: THREE.Vector3, clock: CityClock): void {
    this.elapsed += dt;
    if (this.elapsed < 0.15) return;
    this.elapsed = 0;
    const dark = 1 - clock.daylight;
    this.prefabs.setNightLightLevel(dark);
    if (dark < 0.08) { for (const light of this.lights) light.visible = false; return; }
    this.origin.copy(focus);
    const candidates: Array<{ anchor: CityLightAnchor; position: THREE.Vector3; distance: number }> = [];
    for (const anchor of this.prefabs.lightAnchors) {
      const position = anchor.position;
      const distance = position.distanceToSquared(this.origin);
      if (distance < 27 * 27 && this.prefabs.cityLightActive(anchor)) candidates.push({ anchor, position, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const selected = [
      ...candidates.filter((candidate) => candidate.anchor.kind === 'street').slice(0, 4),
      ...candidates.filter((candidate) => candidate.anchor.kind === 'signal').slice(0, 1),
      ...candidates.filter((candidate) => candidate.anchor.kind === 'interior').slice(0, 3)
    ];
    for (const candidate of candidates) {
      if (selected.length >= 8) break;
      if (!selected.includes(candidate)) selected.push(candidate);
    }
    let used = 0;
    for (const candidate of selected) {
      const light = this.lights[used++];
      light.position.copy(candidate.position);
      light.color.set(candidate.anchor.color);
      light.intensity = candidate.anchor.power * dark;
      light.distance = candidate.anchor.range;
      light.visible = true;
    }
    const vehicles = this.prefabs.vehicles.filter((vehicle) => !vehicle.userData.destroyed && !vehicle.userData.offDutyTraffic &&
      vehicle.parent === this.scene && vehicle.visible && vehicle.position.distanceToSquared(this.origin) < 22 * 22)
      .sort((a, b) => a.position.distanceToSquared(this.origin) - b.position.distanceToSquared(this.origin));
    for (const vehicle of vehicles.slice(0, 2)) {
      const specs = vehicle.userData.vehicle as { length: number } | undefined;
      if (!specs) continue;
      const forward = new THREE.Vector3(Math.sin(vehicle.rotation.y), 0, Math.cos(vehicle.rotation.y));
      const lamp = this.lights[used++];
      lamp.position.copy(vehicle.position).addScaledVector(forward, specs.length * 0.42).add(new THREE.Vector3(0, 0.85, 0));
      lamp.color.set('#fff0c7'); lamp.intensity = 30 * dark; lamp.distance = 12;
      lamp.visible = true;
      const cabin = this.lights[used++];
      cabin.position.copy(vehicle.position).add(new THREE.Vector3(0, 1.4, 0));
      cabin.color.set('#b7d9ed'); cabin.intensity = 8 * dark; cabin.distance = 4;
      cabin.visible = true;
    }
    for (; used < this.lights.length; used++) this.lights[used].visible = false;
  }
}
