import { FLOOR_HEIGHT, VOXEL_SIZE, VOXELS_PER_FLOOR } from './VoxelConstants';

/** Shared dimensions and composition rules for every generated building module.
 * Dimensions are authored in standard voxel or street-cell counts, then
 * converted to world units at the edge of the renderer. */
export type StructureUse = 'factory' | 'shop' | 'hotel' | 'workshop' | 'house' | 'apartment';

export interface DoorPrefab {
  widthVoxels: number;
  heightVoxels: number;
  frameVoxels: number;
  transomVoxels: number;
  sillVoxels: number;
  glazing: 'none' | 'upper' | 'storefront';
}

export interface WindowPrefab {
  widthVoxels: number;
  heightVoxels: number;
  centerYVoxels: number;
  frameVoxels: number;
}

export interface AreaPrefab {
  /** Room and circulation dimensions use the same grid as the city. */
  aisleCells: number;
  entranceClearanceCells: number;
  stationOffsetCells: number;
  groundStation: 'rest' | 'shop' | 'reception' | 'workshop';
  upperStations: readonly ('rest' | 'shop' | 'reception' | 'workshop' | 'cabinet' | 'supply')[];
}

export interface VoxelComponentPrefab {
  readonly role: string;
  readonly size: readonly [number, number, number];
  readonly offset: readonly [number, number, number];
  readonly paint: string;
}

export interface RoomPrefab {
  readonly station: AreaPrefab['groundStation'] | 'cabinet' | 'supply' | 'partition' | 'ceilingLight';
  readonly parts: readonly VoxelComponentPrefab[];
}

export interface FacadePrefab {
  style: 'industrial' | 'commercial' | 'residential';
  corniceVoxels: number;
  accentColumns: boolean;
  shopCanopy: boolean;
  loadingBay: boolean;
  balconies: boolean;
  entrancePlanter: boolean;
}

export type RoofFeature = 'chimney' | 'solar' | 'hvac' | 'vent' | 'coolingTower' | 'waterTank' |
  'seating' | 'garden' | 'pergola' | 'greenhouse' | 'laundry' | 'antenna' | 'skylight' | 'pool' | 'billboard';

export interface RoofPrefab {
  /** Reusable rooftop fixtures selected and placed deterministically per building. */
  features: readonly RoofFeature[];
  parapetVoxels: number;
}

export interface BuildingPrefab {
  use: StructureUse;
  floorHeightVoxels: number;
  floorThicknessVoxels: number;
  minimumStructuralLevels: number;
  maximumStructuralLevels: number;
  minimumFootprintCells: number;
  door: DoorPrefab;
  storefrontWindow: WindowPrefab;
  regularWindow: WindowPrefab;
  area: AreaPrefab;
  facade: FacadePrefab;
  roof: RoofPrefab;
}

const door = (widthVoxels: number, glazing: DoorPrefab['glazing']): DoorPrefab => ({
  widthVoxels,
  heightVoxels: 13,
  frameVoxels: 1,
  transomVoxels: 1,
  sillVoxels: 1,
  glazing,
});

const window = (widthVoxels: number, heightVoxels: number, centerYVoxels: number): WindowPrefab => ({
  widthVoxels,
  heightVoxels,
  centerYVoxels,
  frameVoxels: 1,
});

const areas: Record<StructureUse, AreaPrefab> = {
  factory: { aisleCells: 2, entranceClearanceCells: 1, stationOffsetCells: 1, groundStation: 'workshop', upperStations: ['workshop', 'supply'] },
  workshop: { aisleCells: 1, entranceClearanceCells: 1, stationOffsetCells: 1, groundStation: 'workshop', upperStations: ['workshop', 'supply', 'cabinet'] },
  shop: { aisleCells: 1, entranceClearanceCells: 1, stationOffsetCells: 1, groundStation: 'shop', upperStations: ['shop', 'cabinet', 'rest'] },
  hotel: { aisleCells: 1, entranceClearanceCells: 1, stationOffsetCells: 1, groundStation: 'reception', upperStations: ['rest', 'reception', 'cabinet'] },
  house: { aisleCells: 1, entranceClearanceCells: 1, stationOffsetCells: 1, groundStation: 'rest', upperStations: ['rest', 'cabinet', 'supply'] },
  apartment: { aisleCells: 1, entranceClearanceCells: 1, stationOffsetCells: 1, groundStation: 'rest', upperStations: ['rest', 'cabinet', 'supply'] },
};

const component = (role: string, size: readonly [number, number, number], offset: readonly [number, number, number], paint: string): VoxelComponentPrefab => ({ role, size, offset, paint });

/** Reusable room contents composed only from integer standard-voxel counts.
 * Offsets are relative to the center of the host grid cell. */
export const ROOM_PREFABS: Readonly<Record<RoomPrefab['station'], RoomPrefab>> = {
  rest: { station: 'rest', parts: [
    component('bed-base', [6, 2, 8], [0, 2, 0], '#a87b5f'),
    component('mattress', [6, 1, 8], [0, 3.5, 0], '#78b7a2'),
    component('pillow', [4, 1, 2], [0, 4.5, -2], '#f5e5ce'),
    component('bedside-cabinet', [2, 3, 2], [-4, 2.5, -2], '#f0bf73'),
  ] },
  shop: { station: 'shop', parts: [
    component('counter-body', [7, 3, 4], [0, 2.5, 0], '#aa7959'),
    component('counter-top', [8, 1, 5], [0, 4.5, 0], '#ecc891'),
    component('display-screen', [2, 2, 1], [-2, 6, -1], '#6ab5ad'),
    component('register', [2, 1, 2], [2, 5.5, 0], '#d96169'),
  ] },
  reception: { station: 'reception', parts: [
    component('reception-desk', [7, 3, 4], [0, 2.5, 0], '#6f9b9a'),
    component('desk-top', [8, 1, 5], [0, 4.5, 0], '#ecc891'),
    component('terminal', [2, 2, 2], [-2, 6, 0], '#6ab5ad'),
    component('lamp', [1, 2, 1], [2, 6, -1], '#f3e3b7'),
  ] },
  workshop: { station: 'workshop', parts: [
    component('workbench', [7, 3, 4], [0, 2.5, 0], '#617f83'),
    component('steel-top', [8, 1, 5], [0, 4.5, 0], '#a9c5bf'),
    component('toolbox', [3, 2, 2], [-2, 6, 0], '#e7b96f'),
    component('vise', [2, 1, 2], [2, 5.5, 1], '#43575c'),
  ] },
  cabinet: { station: 'cabinet', parts: [
    component('cabinet-body', [5, 7, 3], [0, 4.5, 0], '#bc8d67'),
    component('left-door', [2, 5, 1], [-1, 3.5, 2], '#e7c390'),
    component('right-door', [2, 5, 1], [1, 3.5, 2], '#d7ad78'),
    component('handle', [1, 1, 1], [1, 3.5, 3], '#f9e8ba'),
  ] },
  supply: { station: 'supply', parts: [
    component('supply-table', [7, 3, 4], [0, 2.5, 0], '#667f80'),
    component('crate-left', [3, 3, 3], [-2, 5.5, 0], '#e3ae6d'),
    component('crate-right', [3, 3, 3], [2, 5.5, 0], '#82b5a8'),
    component('shelf', [5, 1, 4], [0, 7.5, 0], '#364a4f'),
  ] },
  partition: { station: 'partition', parts: [
    component('partition-panel', [7, 7, 1], [0, 0, 0], '#e3c9a8'),
    component('partition-shelf', [4, 1, 2], [0, 4, 2], '#b58866'),
  ] },
  ceilingLight: { station: 'ceilingLight', parts: [
    component('ceiling-fixture', [2, 1, 2], [0, 0, 0], '#ffe2a2'),
  ] },
};

/** A building is composed from a shell, one access module, repeatable storeys,
 * facade openings and a use-specific area layout. The shared storey height is
 * the physical clearance promise for all these child prefabs. */
export const BUILDING_PREFABS: Readonly<Record<StructureUse, BuildingPrefab>> = {
  factory: {
    use: 'factory', floorHeightVoxels: VOXELS_PER_FLOOR, floorThicknessVoxels: 1, minimumStructuralLevels: 2, maximumStructuralLevels: 3, minimumFootprintCells: 4,
    door: door(7, 'none'), storefrontWindow: window(7, 6, -0.5), regularWindow: window(5, 4, 0.75), area: areas.factory,
    facade: { style: 'industrial', corniceVoxels: 1, accentColumns: false, shopCanopy: false, loadingBay: true, balconies: false, entrancePlanter: false },
    roof: { parapetVoxels: 2, features: ['coolingTower', 'vent', 'waterTank', 'solar', 'antenna'] },
  },
  workshop: {
    use: 'workshop', floorHeightVoxels: VOXELS_PER_FLOOR, floorThicknessVoxels: 1, minimumStructuralLevels: 2, maximumStructuralLevels: 3, minimumFootprintCells: 4,
    door: door(6, 'upper'), storefrontWindow: window(7, 6, -0.5), regularWindow: window(5, 4, 0.75), area: areas.workshop,
    facade: { style: 'industrial', corniceVoxels: 1, accentColumns: false, shopCanopy: false, loadingBay: true, balconies: false, entrancePlanter: false },
    roof: { parapetVoxels: 2, features: ['skylight', 'hvac', 'vent', 'waterTank', 'solar'] },
  },
  shop: {
    use: 'shop', floorHeightVoxels: VOXELS_PER_FLOOR, floorThicknessVoxels: 1, minimumStructuralLevels: 2, maximumStructuralLevels: 4, minimumFootprintCells: 4,
    door: door(6, 'storefront'), storefrontWindow: window(7, 6, -0.5), regularWindow: window(5, 5, 0.75), area: areas.shop,
    facade: { style: 'commercial', corniceVoxels: 1, accentColumns: true, shopCanopy: true, loadingBay: false, balconies: false, entrancePlanter: false },
    roof: { parapetVoxels: 2, features: ['solar', 'greenhouse', 'pergola', 'garden', 'billboard', 'hvac'] },
  },
  hotel: {
    use: 'hotel', floorHeightVoxels: VOXELS_PER_FLOOR, floorThicknessVoxels: 1, minimumStructuralLevels: 5, maximumStructuralLevels: 6, minimumFootprintCells: 4,
    door: door(6, 'storefront'), storefrontWindow: window(7, 6, -0.5), regularWindow: window(5, 5, 0.75), area: areas.hotel,
    facade: { style: 'commercial', corniceVoxels: 1, accentColumns: true, shopCanopy: true, loadingBay: false, balconies: false, entrancePlanter: false },
    roof: { parapetVoxels: 2, features: ['garden', 'pool', 'pergola', 'hvac', 'greenhouse', 'antenna'] },
  },
  house: {
    use: 'house', floorHeightVoxels: VOXELS_PER_FLOOR, floorThicknessVoxels: 1, minimumStructuralLevels: 2, maximumStructuralLevels: 3, minimumFootprintCells: 4,
    door: door(6, 'upper'), storefrontWindow: window(5, 5, 0.75), regularWindow: window(4, 5, 0.75), area: areas.house,
    facade: { style: 'residential', corniceVoxels: 1, accentColumns: false, shopCanopy: false, loadingBay: false, balconies: false, entrancePlanter: true },
    roof: { parapetVoxels: 0, features: ['chimney', 'skylight', 'garden', 'waterTank', 'solar'] },
  },
  apartment: {
    use: 'apartment', floorHeightVoxels: VOXELS_PER_FLOOR, floorThicknessVoxels: 1, minimumStructuralLevels: 3, maximumStructuralLevels: 7, minimumFootprintCells: 4,
    door: door(6, 'upper'), storefrontWindow: window(5, 5, 0.75), regularWindow: window(5, 5, 0.75), area: areas.apartment,
    facade: { style: 'residential', corniceVoxels: 1, accentColumns: false, shopCanopy: false, loadingBay: false, balconies: true, entrancePlanter: false },
    roof: { parapetVoxels: 2, features: ['solar', 'laundry', 'garden', 'waterTank', 'antenna', 'pergola'] },
  },
};

export const buildingPrefab = (use: StructureUse): BuildingPrefab => BUILDING_PREFABS[use];
export const voxelUnits = (count: number): number => count * VOXEL_SIZE;
export const storeyHeight = (prefab: BuildingPrefab): number => voxelUnits(prefab.floorHeightVoxels);
export const buildingLevels = (use: StructureUse, variant: number): number => {
  const prefab = BUILDING_PREFABS[use];
  return prefab.minimumStructuralLevels + (Math.abs(variant) % (prefab.maximumStructuralLevels - prefab.minimumStructuralLevels + 1));
};

// Keep the catalog tied to the world scale: a future scale change must update
// these prefabs in voxel counts, never by independently scaling a mesh.
export const STANDARD_STOREY_HEIGHT = FLOOR_HEIGHT;
