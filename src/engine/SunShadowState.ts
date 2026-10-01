import * as THREE from 'three';

/** Stable light projection for cached city shadows. Moving actors use contact shadows. */
export class SunShadowState {
  readonly center = new THREE.Vector3();
  readonly offset = new THREE.Vector3();
  private solarMinute = -1;
  private initialized = false;

  update(focus: THREE.Vector3, hour: number): boolean {
    let changed = false;
    // Do not drag the shadow camera after every player/camera movement.
    if (!this.initialized || Math.hypot(focus.x - this.center.x, focus.z - this.center.z) > 12 ||
        Math.abs(focus.y - this.center.y) > 8) {
      this.center.set(Math.round(focus.x / 8) * 8, focus.y, Math.round(focus.z / 8) * 8);
      this.initialized = true;
      changed = true;
    }
    // One game minute is 2.5 real seconds; the sun moves by only 0.25 degrees.
    const minute = Math.floor(hour * 60);
    if (minute !== this.solarMinute) {
      this.solarMinute = minute;
      const solarHour = minute / 60;
      const angle = solarHour * Math.PI / 12;
      this.offset.set(Math.cos(angle) * 50,
        15 + 55 * Math.max(0.05, Math.sin((solarHour - 6) * Math.PI / 12)), Math.sin(angle) * 38);
      changed = true;
    }
    return changed;
  }
}
