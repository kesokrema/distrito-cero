/// <reference lib="webworker" />
import { meshVoxelCells } from '../world/GreedyMesher';

type MeshRequest = { id: number; pieces: Float32Array; references: Uint32Array; renderOwners: Uint8Array;
  voxelSize: number; latticeOffset: readonly [number, number, number] };
self.onmessage = (event: MessageEvent<MeshRequest>) => {
  const { id, pieces, references, renderOwners, voxelSize, latticeOffset } = event.data;
  for (let i = 0; i < pieces.length; i += 6) for (let axis = 0; axis < 3; axis++) pieces[i + axis] = Math.round(pieces[i + axis] / voxelSize - latticeOffset[axis]);
  const geometry = meshVoxelCells(pieces, references, true, renderOwners);
  for (let i = 0; i < geometry.positions.length; i++) {
    const axis = i % 3;
    geometry.positions[i] = (geometry.positions[i] + latticeOffset[axis] - 0.5) * voxelSize;
  }
  self.postMessage({ id, ...geometry }, [geometry.positions.buffer, geometry.normals.buffer, geometry.colors.buffer, geometry.indexes.buffer, geometry.voxelForFace.buffer]);
};
export {};
