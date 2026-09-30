import * as THREE from 'three';
import { CITY_VOXEL_SIZE } from './VoxelConstants';
import { voxelSurfaceGeometry, type VoxelDimensions } from './VoxelSystem';

export interface RoofVoxel { x: number; y: number; z: number; paint: string }

const roofMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.86, vertexColors: true });
/** Assemble a reusable roof fixture from one shared integer voxel grid. */
export function createRoofFeatureMesh(voxels: readonly RoofVoxel[], name: string): THREE.Mesh | null {
  if (!voxels.length) return null;
  const occupied = new Map<string, { x: number; y: number; z: number; paint: string }>();
  for (const voxel of voxels) occupied.set(`${voxel.x}:${voxel.y}:${voxel.z}`, voxel);
  const cells = [...occupied.values()];
  const minX = Math.min(...cells.map((cell) => cell.x)), maxX = Math.max(...cells.map((cell) => cell.x));
  const minY = Math.min(...cells.map((cell) => cell.y)), maxY = Math.max(...cells.map((cell) => cell.y));
  const minZ = Math.min(...cells.map((cell) => cell.z)), maxZ = Math.max(...cells.map((cell) => cell.z));
  const nx = maxX - minX + 1, ny = maxY - minY + 1, nz = maxZ - minZ + 1, count = nx * ny * nz;
  const mask = new Uint8Array(count), palette = new Float32Array(count * 3);
  for (const cell of cells) {
    const index = cell.x - minX + nx * (cell.z - minZ + nz * (cell.y - minY));
    mask[index] = 1;
    const paint = new THREE.Color(cell.paint);
    palette[index * 3] = paint.r; palette[index * 3 + 1] = paint.g; palette[index * 3 + 2] = paint.b;
  }
  const geometry = voxelSurfaceGeometry(nx, ny, nz, mask, false, palette, CITY_VOXEL_SIZE, true);
  const mesh = new THREE.Mesh(geometry, roofMaterial);
  mesh.name = `roof-feature-${name}`;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.position.set((minX + maxX) * CITY_VOXEL_SIZE / 2, (minY + maxY) * CITY_VOXEL_SIZE / 2,
    (minZ + maxZ) * CITY_VOXEL_SIZE / 2);
  mesh.userData.voxelDimensions = { nx, ny, nz, voxelSize: CITY_VOXEL_SIZE, suppressBottomBoundary: true } satisfies VoxelDimensions;
  mesh.userData.voxelMask = mask;
  mesh.userData.voxelPalette = palette;
  mesh.userData.ownsVoxelGeometry = true;
  mesh.userData.roofFeature = name;
  return mesh;
}

