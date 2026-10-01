/// <reference lib="webworker" />
import { meshVoxelCells } from '../world/GreedyMesher';

type PieceData = {
  nx: number; ny: number; nz: number; voxelSize: number;
  tint: readonly [number, number, number]; mask: Uint8Array; matrixWorld: Float32Array;
};
type Request = { id: number; revision: number; gridSize: number; pieces: PieceData[] };

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, revision, gridSize, pieces } = event.data;
  const cells: number[] = [];
  const owners: number[] = [];
  for (let owner = 0; owner < pieces.length; owner++) {
    const piece = pieces[owner];
    const ratio = Math.round(piece.voxelSize / gridSize);
    if (ratio < 1 || Math.abs(ratio * gridSize - piece.voxelSize) > 0.001) continue;
    const e = piece.matrixWorld;
    for (let y = 0; y < piece.ny; y++) for (let z = 0; z < piece.nz; z++) for (let x = 0; x < piece.nx; x++) {
      if (!piece.mask[x + piece.nx * (z + piece.nz * y)]) continue;
      const lx = (x - (piece.nx - 1) / 2) * piece.voxelSize;
      const ly = (y - (piece.ny - 1) / 2) * piece.voxelSize;
      const lz = (z - (piece.nz - 1) / 2) * piece.voxelSize;
      const wx = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
      const wy = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
      const wz = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
      const sx = Math.round((wx - piece.voxelSize / 2) / gridSize);
      const sy = Math.round((wy - piece.voxelSize / 2) / gridSize);
      const sz = Math.round((wz - piece.voxelSize / 2) / gridSize);
      for (let cy = 0; cy < ratio; cy++) for (let cz = 0; cz < ratio; cz++) for (let cx = 0; cx < ratio; cx++) {
        cells.push(sx + cx, sy + cy, sz + cz, piece.tint[0], piece.tint[1], piece.tint[2]);
        owners.push(owner);
      }
    }
  }
  const surface = cells.length
    ? meshVoxelCells(Float32Array.from(cells), Uint32Array.from(owners), true)
    : { positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), indexes: new Uint32Array(),
        voxelForFace: new Uint32Array(), exposedFaces: 0, quads: 0 };
  self.postMessage({ id, revision, ...surface }, [surface.positions.buffer, surface.normals.buffer,
    surface.colors.buffer, surface.indexes.buffer, surface.voxelForFace.buffer]);
};

export {};
