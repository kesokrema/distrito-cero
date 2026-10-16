/** Bounded catch-up, independent of render frequency. Reset on pause/focus loss. */
export class FixedStep {
  private accumulator = 0;
  droppedSeconds = 0;
  constructor(readonly step = 1 / 60, readonly maxSteps = 4) {}
  reset(): void { this.accumulator = 0; }
  get alpha(): number { return this.accumulator / this.step; }
  advance(elapsed: number, update: (dt: number) => void): number {
    if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
    this.accumulator += elapsed;
    let count = 0;
    while (this.accumulator + 1e-9 >= this.step && count < this.maxSteps) {
      update(this.step); this.accumulator -= this.step; count++;
    }
    if (this.accumulator >= this.step) {
      const dropped = Math.floor(this.accumulator / this.step) * this.step;
      this.droppedSeconds += dropped; this.accumulator -= dropped;
    }
    this.accumulator = Math.max(0, this.accumulator);
    return count;
  }
}
