import { stairBay, frontageZ, type BuildingPlan } from './BuildingLayout';

export type BuildingForm = 'street-terrace' | 'side-wing' | 'corner-terrace' | 'stepped' | 'courtyard';
export interface TerraceDoor { x: number; z: number; level: number; face: number }
export interface BuildingArchitecture {
  form: BuildingForm;
  roofLevel(x: number, z: number): number;
  wallMask(x: number, z: number, level: number): number;
  doors: TerraceDoor[];
}
const cache = new WeakMap<BuildingPlan, BuildingArchitecture>();
export const WALL_DIRECTIONS = [ { dx: -1, dz: 0, bit: 1 }, { dx: 1, dz: 0, bit: 2 },
  { dx: 0, dz: -1, bit: 4 }, { dx: 0, dz: 1, bit: 8 } ] as const;

/** One shared occupancy plan drives walls, floors, terraces, access and furnishing.
 * A complete ground storey retains the street entrance; upper volumes retreat
 * around the protected stair core. No decorative mesh invents a second floor. */
export function buildingArchitecture(plan: BuildingPlan): BuildingArchitecture {
  const previous = cache.get(plan); if (previous) return previous;
  const top = plan.height - 1, stair = stairBay(plan), aisle = plan.x + Math.floor(plan.width / 2);
  const forms: BuildingForm[] = ['street-terrace', 'side-wing', 'corner-terrace', 'stepped', 'courtyard'];
  const form = forms[Math.abs(plan.variant) % forms.length];
  const levels = new Uint8Array(plan.width * plan.depth).fill(top);
  for (let z = plan.z; z < plan.z + plan.depth; z++) for (let x = plan.x; x < plan.x + plan.width; x++) {
    const frontDistance = Math.abs(z - frontageZ(plan));
    const oppositeSide = stair.x < aisle ? plan.x + plan.width - 1 - x : x - plan.x;
    const core = x >= Math.min(stair.x, aisle) - 1 && x <= Math.max(stair.x, aisle) + 1 && z >= stair.z0 - 1 && z <= stair.z1 + 1;
    let roof = top;
    if (top > 1 && !core) {
      if (form === 'street-terrace' && frontDistance < 2) roof = Math.max(1, top - 1);
      if (form === 'side-wing' && oppositeSide < 2) roof = Math.max(1, top - 1);
      if (form === 'corner-terrace' && (frontDistance < 2 || oppositeSide < 2)) roof = Math.max(1, top - 1);
      if (form === 'stepped') roof = Math.min(top, 1 + Math.floor(frontDistance / 2));
      if (form === 'courtyard' && Math.abs(x - aisle) <= 1 && frontDistance < Math.max(2, plan.depth - 3)) roof = 1;
    }
    levels[x - plan.x + plan.width * (z - plan.z)] = roof;
  }
  const roofLevel = (x: number, z: number): number => x < plan.x || z < plan.z || x >= plan.x + plan.width || z >= plan.z + plan.depth
    ? 0 : levels[x - plan.x + plan.width * (z - plan.z)];
  const wallMask = (x: number, z: number, level: number): number => WALL_DIRECTIONS.reduce((mask, d) =>
    roofLevel(x + d.dx, z + d.dz) <= level ? mask | d.bit : mask, 0);
  const doors: TerraceDoor[] = [];
  // Each connected terrace receives a real opening to an occupied room.
  for (let level = 1; level < top; level++) {
    const visited = new Set<string>();
    for (let z = plan.z; z < plan.z + plan.depth; z++) for (let x = plan.x; x < plan.x + plan.width; x++) {
      if (roofLevel(x, z) !== level || visited.has(`${x}:${z}`)) continue;
      const pending = [{x, z}], candidates: TerraceDoor[] = []; visited.add(`${x}:${z}`);
      for (let i = 0; i < pending.length; i++) for (const d of WALL_DIRECTIONS) {
        const nx = pending[i].x + d.dx, nz = pending[i].z + d.dz, key = `${nx}:${nz}`;
        if (roofLevel(nx, nz) === level && !visited.has(key)) { visited.add(key); pending.push({x: nx, z: nz}); }
        if (roofLevel(nx, nz) > level && !(nx === stair.x && nz >= stair.z0 && nz <= stair.z1))
          candidates.push({x: nx, z: nz, level, face: d.bit === 1 ? 2 : d.bit === 2 ? 1 : d.bit === 4 ? 8 : 4});
      }
      candidates.sort((a, b) => Math.abs(a.x - aisle) - Math.abs(b.x - aisle) || Math.abs(a.z - stair.z0) - Math.abs(b.z - stair.z0));
      if (candidates[0]) doors.push(candidates[0]);
    }
  }
  const result = { form, roofLevel, wallMask, doors }; cache.set(plan, result); return result;
}
