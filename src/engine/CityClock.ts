import * as THREE from 'three';

/** One game day in one real hour. An explicit hour keeps visual tests reproducible. */
export class CityClock {
  hour: number;
  constructor(initialHour = Math.random() * 24) {
    this.hour = ((initialHour % 24) + 24) % 24;
  }

  update(dt: number): void { this.hour = (this.hour + dt * 24 / 3600) % 24; }

  get daylight(): number {
    return THREE.MathUtils.smoothstep(Math.sin((this.hour - 6) * Math.PI / 12), -0.12, 0.42);
  }

  get sunset(): number {
    return Math.exp(-Math.pow((this.hour - 18.6) / 1.35, 2)) +
      Math.exp(-Math.pow((this.hour - 5.75) / 1.2, 2)) * 0.65;
  }

  get streetActivity(): number {
    const evening = THREE.MathUtils.smoothstep(this.hour, 18, 23);
    const morning = THREE.MathUtils.smoothstep(this.hour, 5, 9);
    return THREE.MathUtils.lerp(0.27, 1, Math.min(morning, 1 - evening));
  }

  get label(): string {
    const hour = Math.floor(this.hour), minute = Math.floor((this.hour - hour) * 60);
    const phase = this.hour >= 17 && this.hour < 20 ? 'ATARDECER' :
      this.hour >= 20 || this.hour < 5 ? 'NOCHE' : this.hour < 8 ? 'AMANECER' : 'DÍA';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} · ${phase}`;
  }
}
