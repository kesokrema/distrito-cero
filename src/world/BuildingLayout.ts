import type { BlockBounds, District, GridSystem } from './GridSystem';
import { buildingLevels, buildingPrefab, type StructureUse } from './StructurePrefabCatalog';

export interface BuildingPlan {
  x: number; z: number; width: number; depth: number; height: number;
  type: StructureUse; variant: number; front: 'north' | 'south';
}
export const frontageZ = (plan: BuildingPlan): number => plan.front === 'north' ? plan.z : plan.z + plan.depth - 1;
export const frontageDirection = (plan: BuildingPlan): number => plan.front === 'north' ? -1 : 1;
export function stairBay(plan: BuildingPlan): { x: number; z0: number; z1: number } {
  const doorX = plan.x + Math.floor(plan.width / 2);
  const right = plan.x + plan.width - 2;
  const x = right !== doorX && plan.variant % 2 === 0 ? right : plan.x + 1;
  const z0 = plan.front === 'north' ? plan.z + plan.depth - 3 : plan.z + 1;
  return { x, z0, z1: z0 + 1 };
}
export function circulationCell(plan: BuildingPlan, x: number, z: number): boolean {
  const stair = stairBay(plan);
  return x === plan.x + Math.floor(plan.width / 2) ||
    (plan.height > 2 && x === stair.x && z >= stair.z0 - 1 && z <= stair.z1 + 1) ||
    z === frontageZ(plan) - frontageDirection(plan);
}

/** Place complete, street-facing parcels around a block's public space. */
export function planBlock(grid: GridSystem, bounds: BlockBounds, district: District): BuildingPlan[] {
  if (district === 'park' || bounds.bx === grid.terrain.canalColumn) return [];
  const profile = grid.blockProfile(bounds.bx, bounds.bz);
  const x0 = bounds.x0 + 4, z0 = bounds.z0 + 4;
  const width = bounds.x1 - x0 - 1, depth = bounds.z1 - z0 - 1;
  if (width < 4 || depth < 5) return [];
  const plans: BuildingPlan[] = [];
  const courtGap = profile.form === 'courtyard' ? 4 : 2;
  const twoRows = depth >= 10 + courtGap && profile.form !== 'yard' && profile.form !== 'pocket';
  const rows = twoRows ? 2 : 1;
  const chooseType = (choice: number, parcelWidth: number, row: number): StructureUse => {
    if (district === 'industrial') return choice < 0.62 ? 'factory' : 'workshop';
    if (district === 'commercial') {
      if (row === 1 && choice > 0.72) return 'apartment';
      return choice < 0.20 && parcelWidth >= 5 ? 'hotel' : choice > 0.88 ? 'workshop' : 'shop';
    }
    if (row === 0 && profile.form === 'corner' && choice > 0.52) return 'shop';
    return choice > 0.54 && parcelWidth >= 5 ? 'apartment' : 'house';
  };
  const append = (x: number, z: number, parcelWidth: number, parcelDepth: number, front: BuildingPlan['front'], salt: number, row: number): void => {
    if (parcelWidth < 4 || parcelDepth < 5) return;
    const variant = Math.floor(grid.hash(bounds.bx, bounds.bz, 512 + salt) * 96);
    const type = chooseType(grid.hash(bounds.bx, bounds.bz, 641 + salt), parcelWidth, row);
    const prefab = buildingPrefab(type);
    const densityShift = profile.density > 0.63 ? 1 : profile.density < 0.36 ? -1 : 0;
    const height = Math.max(prefab.minimumStructuralLevels, Math.min(prefab.maximumStructuralLevels,
      buildingLevels(type, variant) + densityShift + (type === 'hotel' || type === 'apartment' ? Number(profile.density > .55) : 0)));
    plans.push({ x, z, width: parcelWidth, depth: parcelDepth, height, type, variant, front });
  };

  if (profile.form === 'corner' && width >= 10 && depth >= 11) {
    const split = Math.floor(width * (0.43 + grid.hash(bounds.bx, bounds.bz, 624) * 0.14));
    const frontDepth = Math.max(5, Math.min(depth - 2, 6 + Math.floor(grid.hash(bounds.bx, bounds.bz, 625) * 3)));
    append(x0, z0, split, frontDepth, 'north', 1, 0);
    append(x0 + split + 1, z0 + depth - frontDepth, width - split - 1, frontDepth, 'south', 2, 1);
    return plans;
  }

  for (let row = 0; row < rows; row++) {
    const front: BuildingPlan['front'] = row === 0 ? 'north' : 'south';
    const pocketDepth = grid.pocketStart(bounds) - z0 - 1;
    const maxDepth = profile.form === 'pocket' ? Math.min(depth, pocketDepth) :
      twoRows ? Math.floor((depth - courtGap) / 2) : Math.min(depth, district === 'industrial' ? 9 : 8);
    if (maxDepth < 5) continue;
    const countRoll = grid.hash(bounds.bx, bounds.bz, 613 + row);
    const maximum = Math.max(1, Math.min(3, Math.floor((width + 1) / 5)));
    const count = district === 'industrial' ? (width >= 13 && countRoll > 0.32 ? 2 : 1) :
      profile.form === 'yard' ? Math.min(2, maximum) : Math.max(1, maximum - Number(countRoll < 0.32));
    const availableWidth = width - (count - 1);
    let cursor = x0;
    let remaining = availableWidth;
    for (let column = 0; column < count; column++) {
      const left = count - column;
      const salt = row * 17 + column * 5;
      const variant = Math.floor(grid.hash(bounds.bx, bounds.bz, 512 + salt) * 96);
      const partWidth = left === 1 ? remaining : Math.max(4, Math.min(remaining - 4 * (left - 1), Math.floor(remaining / left) + variant % 2));
      const partDepth = Math.max(5, maxDepth - (variant % 4 === 0 && maxDepth > 5 ? 1 : 0));
      const setback = front === 'north' && profile.form === 'courtyard' && column % 2 === 1 && partDepth > 5 ? 1 : 0;
      append(cursor, front === 'north' ? z0 + setback : z0 + depth - partDepth,
        partWidth, partDepth - setback, front, salt, row);
      cursor += partWidth + 1; remaining -= partWidth;
    }
  }
  return plans;
}
