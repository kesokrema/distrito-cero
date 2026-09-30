export class SpatialHash<T> {
  private buckets = new Map<string, T[]>();
  private itemBuckets = new Map<T, string>();

  constructor(private cellSize: number, private position: (item: T) => { x: number; z: number }) {}

  rebuild(items: Iterable<T>): void {
    this.buckets.clear();
    this.itemBuckets.clear();
    for (const item of items) this.insert(item);
  }

  /** Move one dynamic object between buckets without rebuilding the whole index. */
  update(item: T): void {
    const { x, z } = this.position(item);
    const key = `${Math.floor(x / this.cellSize)}:${Math.floor(z / this.cellSize)}`;
    const previous = this.itemBuckets.get(item);
    if (previous === key) return;
    if (previous) {
      const bucket = this.buckets.get(previous);
      if (bucket) {
        const index = bucket.indexOf(item);
        if (index >= 0) bucket.splice(index, 1);
        if (!bucket.length) this.buckets.delete(previous);
      }
    }
    this.addToBucket(item, key);
  }

  remove(item: T): void {
    const key = this.itemBuckets.get(item);
    if (!key) return;
    const bucket = this.buckets.get(key);
    if (bucket) {
      const index = bucket.indexOf(item);
      if (index >= 0) bucket.splice(index, 1);
      if (!bucket.length) this.buckets.delete(key);
    }
    this.itemBuckets.delete(item);
  }

  private insert(item: T): void {
    const { x, z } = this.position(item);
    this.addToBucket(item, `${Math.floor(x / this.cellSize)}:${Math.floor(z / this.cellSize)}`);
  }

  private addToBucket(item: T, key: string): void {
    let bucket = this.buckets.get(key);
    if (!bucket) { bucket = []; this.buckets.set(key, bucket); }
    bucket.push(item);
    this.itemBuckets.set(item, key);
  }

  nearby(x: number, z: number, radius: number): T[] {
    const result: T[] = [];
    // Entries can move during a frame; scan one extra bucket and test current positions below.
    const startX = Math.floor((x - radius) / this.cellSize) - 1;
    const endX = Math.floor((x + radius) / this.cellSize) + 1;
    const startZ = Math.floor((z - radius) / this.cellSize) - 1;
    const endZ = Math.floor((z + radius) / this.cellSize) + 1;
    const limit = radius * radius;
    for (let bz = startZ; bz <= endZ; bz++) for (let bx = startX; bx <= endX; bx++) {
      const bucket = this.buckets.get(`${bx}:${bz}`);
      if (!bucket) continue;
      for (const item of bucket) {
        const point = this.position(item);
        const dx = point.x - x, dz = point.z - z;
        if (dx * dx + dz * dz <= limit) result.push(item);
      }
    }
    return result;
  }
}
