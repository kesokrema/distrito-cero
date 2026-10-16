type Series = { values: number[]; cursor: number; count: number };
/** Opt-in, bounded diagnostics. No per-frame DOM or unbounded sample arrays. */
export class PerformanceMonitor {
  private readonly series = new Map<string, Series>();
  private observer?: PerformanceObserver;
  constructor(readonly enabled: boolean, private readonly capacity = 600) {
    if (enabled && typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      this.observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) this.record('longTask', entry.duration); });
      this.observer.observe({ type: 'longtask', buffered: false });
    }
  }
  record(name: string, ms: number): void {
    if (!this.enabled) return;
    let entry = this.series.get(name);
    if (!entry) { entry = { values: new Array<number>(this.capacity), cursor: 0, count: 0 }; this.series.set(name, entry); }
    entry.values[entry.cursor] = ms; entry.cursor = (entry.cursor + 1) % this.capacity; entry.count++;
  }
  measure<T>(name: string, action: () => T): T {
    if (!this.enabled) return action();
    const start = performance.now();
    try { return action(); } finally { this.record(name, performance.now() - start); }
  }
  reset(): void { this.series.clear(); }
  snapshot(): Record<string, { count: number; samples: number; mean: number; p50: number; p95: number; p99: number; max: number }> {
    return Object.fromEntries([...this.series].map(([name, entry]) => {
      const values = entry.values.slice(0, Math.min(entry.count, this.capacity)).sort((a, b) => a - b);
      const q = (fraction: number) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
      return [name, { count: entry.count, samples: values.length, mean: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length),
        p50: q(.5), p95: q(.95), p99: q(.99), max: q(1) }];
    }));
  }
  dispose(): void { this.observer?.disconnect(); this.series.clear(); }
}
