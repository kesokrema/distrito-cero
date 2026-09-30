export const VOXEL_SIZE = 0.22;
export const VOXELS_PER_CELL = 10;
// A storey is 18 standard voxels high; each street cell is 10 voxels wide.
export const VOXELS_PER_FLOOR = 18;
export const FLOOR_HEIGHT = VOXEL_SIZE * VOXELS_PER_FLOOR;

// City architecture uses 2x macrovoxels while actors and vehicles keep the
// original lattice. Both resolutions map exactly to the same 2.2 m cell and
// 3.96 m floor, so navigation and world dimensions stay unchanged.
export const CITY_VOXEL_SIZE = VOXEL_SIZE * 2;
export const CITY_VOXELS_PER_CELL = VOXELS_PER_CELL / 2;
export const CITY_VOXELS_PER_FLOOR = VOXELS_PER_FLOOR / 2;
