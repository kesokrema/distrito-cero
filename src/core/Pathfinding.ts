/** Sparse navigation: ungenerated cells never allocate pathfinding state. */
export type PathAvoidance = { x: number; z: number; radius: number };

export class SparsePathfinder {
  private layers=new Map<number,Set<number>>();
  private heights = new Map<number,number>();
  private walkable = new Map<number, number>();
  constructor(readonly size: number) {}
  update(indexes: Uint32Array, blocked: Uint8Array, costs?: Uint8Array, heights?: Float32Array): void {
    for (let i = 0; i < indexes.length; i++) {
      const cell=indexes[i]%(this.size*this.size);
      let layers=this.layers.get(cell);if(!layers){layers=new Set();this.layers.set(cell,layers);}layers.add(indexes[i]);
      if(heights)this.heights.set(indexes[i],heights[i]);
      if (blocked[i]) {this.walkable.delete(indexes[i]);layers.delete(indexes[i]);if(indexes[i]>=this.size*this.size)this.heights.delete(indexes[i]);}
      else this.walkable.set(indexes[i], costs?.[i] || this.walkable.get(indexes[i]) || 1);
    }
  }
  get cellCount(): number { return this.walkable.size; }
  find(start: number, goal: number, avoid?: PathAvoidance): number[] {
    if (start === goal) return [goal];
    if (!this.walkable.has(goal)) return [];
    const came = new Map<number, number>(), scores = new Map<number, number>([[start, 0]]), closed = new Set<number>();
    const heap: Array<{ id: number; priority: number }> = [];
    const area=this.size*this.size,baseGoal=goal%area;
    const h = (id: number) => Math.abs(id % this.size - baseGoal % this.size) + Math.abs(Math.floor((id%area) / this.size) - Math.floor(baseGoal / this.size));
    const push = (id: number, priority: number) => {
      const entry = { id, priority }; let i = heap.length; heap.push(entry);
      while (i > 0) { const parent = (i - 1) >> 1; if (heap[parent].priority <= priority) break; heap[i] = heap[parent]; i = parent; }
      heap[i] = entry;
    };
    const pop = () => {
      const result = heap[0], last = heap.pop()!;
      if (heap.length) {
        let i = 0;
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1;
          if (child + 1 < heap.length && heap[child + 1].priority < heap[child].priority) child++;
          if (heap[child].priority >= last.priority) break;
          heap[i] = heap[child]; i = child;
        }
        heap[i] = last;
      }
      return result.id;
    };
    push(start, h(start));
    while (heap.length && closed.size < 40000) {
      const current = pop();
      if (closed.has(current)) continue;
      if (current === goal) {
        const path = [current]; let cursor = current;
        while (came.has(cursor)) { cursor = came.get(cursor)!; path.push(cursor); }
        return path.reverse();
      }
      closed.add(current);
      const base=current%area,x = base % this.size, z = Math.floor(base / this.size);
      const adjacentCells = [x > 0 ? base - 1 : -1, x < this.size - 1 ? base + 1 : -1, z > 0 ? base - this.size : -1, z < this.size - 1 ? base + this.size : -1];
      const adjacent=adjacentCells.flatMap(cell=>[...(this.layers.get(cell)??[])]);
      for (const next of adjacent) {
        const cost = this.walkable.get(next);
        if (!cost || closed.has(next)) continue;
        if(Math.abs((this.heights.get(next)??0)-(this.heights.get(current)??0))>.85)continue;
        let dangerCost = 0;
        if (avoid) {
          const currentDistance = Math.hypot(x - avoid.x, z - avoid.z);
          const nextDistance = Math.hypot(next % this.size - avoid.x, Math.floor((next%area) / this.size) - avoid.z);
          const exposure = Math.max(0, 1 - Math.min(currentDistance, nextDistance) / avoid.radius);
          dangerCost = Math.max(0, currentDistance - nextDistance) * exposure * 12;
        }
        const score = scores.get(current)! + cost + dangerCost;
        if (score >= (scores.get(next) ?? Infinity)) continue;
        came.set(next, current); scores.set(next, score); push(next, score + h(next));
      }
    }
    return [];
  }
}
