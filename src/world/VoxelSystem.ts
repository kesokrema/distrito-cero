import * as THREE from 'three';
import { VOXEL_SIZE } from './VoxelConstants';
import { meshVoxelCells } from './GreedyMesher';
export { VOXEL_SIZE, VOXELS_PER_CELL } from './VoxelConstants';

/** Fine voxel unit for actors, vehicles, and thin interactive details. */
export const voxelGeometry = new THREE.BoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE);

const materials = new Map<string, THREE.MeshStandardMaterial>();
const surfaceGeometries = new Map<string, THREE.BufferGeometry>();

function material(hex: string, roughness: number): THREE.MeshStandardMaterial {
  const key = `${hex}:${roughness}`;
  let result = materials.get(key);
  if (!result) {
    result = new THREE.MeshStandardMaterial({ color: hex, roughness, vertexColors: true });
    materials.set(key, result);
  }
  return result;
}

export type VoxelDimensions = { nx: number; ny: number; nz: number; signUv?: boolean; voxelSize?: number; suppressBottomBoundary?: boolean };

/** Build only faces touching air. The triangle map makes each standard cube addressable. */
export function voxelSurfaceGeometry(nx: number, ny: number, nz: number, alive?: Uint8Array, signUv = false,
  voxelColors?: Float32Array, voxelSize = VOXEL_SIZE, suppressBottomBoundary = false): THREE.BufferGeometry {
  if (!alive && !voxelColors) {
    const geometry = new THREE.BoxGeometry(nx * voxelSize, ny * voxelSize, nz * voxelSize);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(72).fill(1), 3));
    return geometry;
  }
  const cells: number[] = [];
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const i = x + nx * (z + nz * y);
    if (alive && !alive[i]) continue;
    cells.push(x, y, z, voxelColors?.[i * 3] ?? 1, voxelColors?.[i * 3 + 1] ?? 1, voxelColors?.[i * 3 + 2] ?? 1);
  }
  const surface = meshVoxelCells(Float32Array.from(cells), new Uint32Array(cells.length / 6), false, undefined, suppressBottomBoundary);
  const uv: number[] = [];
  for (let i = 0; i < surface.positions.length; i += 3) {
    if (signUv) uv.push(surface.positions[i] / nx, surface.positions[i + 1] / ny);
    surface.positions[i] = (surface.positions[i] - nx / 2) * voxelSize;
    surface.positions[i + 1] = (surface.positions[i + 1] - ny / 2) * voxelSize;
    surface.positions[i + 2] = (surface.positions[i + 2] - nz / 2) * voxelSize;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(surface.normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(surface.colors, 3));
  if (signUv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(surface.indexes, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Bounds are rounded to an integer count of identical cubes. */
export function voxelCuboid(width: number, height: number, depth: number, hex: string, roughness = 0.85,
  voxelSize = VOXEL_SIZE): THREE.Mesh {
  const mesh = voxelShape(width, height, depth, material(hex, roughness), voxelSize);
  mesh.userData.voxelDimensions = {
    nx: Math.max(1, Math.round(width / voxelSize)),
    ny: Math.max(1, Math.round(height / voxelSize)),
    nz: Math.max(1, Math.round(depth / voxelSize)), voxelSize
  } satisfies VoxelDimensions;
  return mesh;
}

export function voxelShape(width: number, height: number, depth: number, paint: THREE.Material, voxelSize = VOXEL_SIZE): THREE.Mesh {
  if ('vertexColors' in paint && paint.vertexColors !== true) {
    paint.vertexColors = true;
    paint.needsUpdate = true;
  }
  const nx = Math.max(1, Math.round(width / voxelSize));
  const ny = Math.max(1, Math.round(height / voxelSize));
  const nz = Math.max(1, Math.round(depth / voxelSize));
  const key = `${nx}:${ny}:${nz}:${voxelSize}`;
  let geometry = surfaceGeometries.get(key);
  if (!geometry) {
    geometry = voxelSurfaceGeometry(nx, ny, nz, undefined, false, undefined, voxelSize);
    surfaceGeometries.set(key, geometry);
  }
  return new THREE.Mesh(geometry, paint);
}
