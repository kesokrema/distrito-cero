import * as THREE from 'three';
import { meshVoxelCells, type SurfaceMesh } from './GreedyMesher';
import { VOXEL_SIZE } from './VoxelConstants';
import type { VoxelDimensions } from './VoxelSystem';

const AXIS_EPSILON = 0.001;

function hasUnitAxisTransform(mesh: THREE.Mesh): boolean {
  mesh.updateWorldMatrix(true, false);
  const elements = mesh.matrixWorld.elements;
  for (const column of [0, 4, 8]) {
    const values = [elements[column], elements[column + 1], elements[column + 2]];
    const nonZero = values.filter((value) => Math.abs(value) > AXIS_EPSILON);
    if (nonZero.length !== 1 || Math.abs(Math.abs(nonZero[0]) - 1) > AXIS_EPSILON) return false;
  }
  return true;
}

/**
 * Move a voxel cuboid by whole voxels so its lower faces sit on the shared
 * world lattice. The transform may include cardinal rotations, as used by
 * mirrored and side-facing street props.
 */
export function snapVoxelMeshToGrid(mesh: THREE.Mesh, gridSize = VOXEL_SIZE): boolean {
  const dimensions = mesh.userData.voxelDimensions as VoxelDimensions | undefined;
  if (!dimensions || !hasUnitAxisTransform(mesh)) return false;

  const box = new THREE.Box3().setFromObject(mesh);
  if (box.isEmpty()) return false;
  const delta = new THREE.Vector3(
    Math.round(box.min.x / gridSize) * gridSize - box.min.x,
    Math.round(box.min.y / gridSize) * gridSize - box.min.y,
    Math.round(box.min.z / gridSize) * gridSize - box.min.z
  );
  if (delta.lengthSq() < 1e-10) return true;

  const worldPosition = mesh.getWorldPosition(new THREE.Vector3()).add(delta);
  if (mesh.parent) {
    mesh.parent.updateWorldMatrix(true, false);
    worldPosition.applyMatrix4(mesh.parent.matrixWorld.clone().invert());
  }
  mesh.position.copy(worldPosition);
  mesh.updateWorldMatrix(false, false);
  return true;
}

/**
 * Revoxelize aligned decorative cuboids at the fine shared lattice, then
 * emit only their exposed faces. Coarser city voxels are represented by an
 * exact integer group of fine cells, so mixed detail sizes still meet cleanly.
 */
export function meshVoxelDecorations(meshes: readonly THREE.Mesh[], gridSize = VOXEL_SIZE): SurfaceMesh | null {
  const cells: number[] = [];
  const owners: number[] = [];
  let pieceCount = 0;

  for (const mesh of meshes) {
    const dimensions = mesh.userData.voxelDimensions as VoxelDimensions | undefined;
    const paint = mesh.material;
    if (!dimensions || dimensions.signUv || !(paint instanceof THREE.MeshStandardMaterial) || paint.map ||
        mesh.userData.voxelPalette || !hasUnitAxisTransform(mesh)) continue;
    const voxelSize = dimensions.voxelSize ?? VOXEL_SIZE;
    const ratio = Math.round(voxelSize / gridSize);
    if (ratio < 1 || Math.abs(ratio * gridSize - voxelSize) > AXIS_EPSILON) continue;

    const vertexColor = mesh.geometry.getAttribute('color');
    const tint = paint.color.clone();
    if (vertexColor && vertexColor.count) tint.multiply(new THREE.Color().setRGB(vertexColor.getX(0), vertexColor.getY(0), vertexColor.getZ(0)));
    const { nx, ny, nz } = dimensions;
    const mask = mesh.userData.voxelMask as Uint8Array | undefined;
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      if (mask && !mask[x + nx * (z + nz * y)]) continue;
      const local = new THREE.Vector3((x - (nx - 1) / 2) * voxelSize,
        (y - (ny - 1) / 2) * voxelSize, (z - (nz - 1) / 2) * voxelSize);
      const center = mesh.localToWorld(local);
      const startX = Math.round((center.x - voxelSize / 2) / gridSize);
      const startY = Math.round((center.y - voxelSize / 2) / gridSize);
      const startZ = Math.round((center.z - voxelSize / 2) / gridSize);
      for (let sy = 0; sy < ratio; sy++) for (let sz = 0; sz < ratio; sz++) for (let sx = 0; sx < ratio; sx++) {
        cells.push(startX + sx, startY + sy, startZ + sz, tint.r, tint.g, tint.b);
        owners.push(pieceCount);
      }
    }
    pieceCount++;
  }

  if (pieceCount < 2 || !cells.length) return null;
  return meshVoxelCells(Float32Array.from(cells), Uint32Array.from(owners), true);
}
