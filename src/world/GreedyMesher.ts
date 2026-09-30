/** Surface compression only. Each occupied cell retains its independent owner and damage state. */
export interface SurfaceMesh {
  positions: Float32Array; normals: Float32Array; colors: Float32Array; indexes: Uint32Array;
  voxelForFace: Uint32Array; exposedFaces: number; quads: number;
}

/** Marker used when one rendered quad spans more than one damage owner. */
export const MERGED_VOXEL_OWNER = 0xffffffff;

type Plane = { axis: number; sign: number; plane: number; owner: number; color: number[]; cells: Map<number, number>; };

/** Cells contain integer x/y/z followed by linear RGB. Merging across owners is opt-in. */
export function meshVoxelCells(cells: Float32Array, owners: Uint32Array, mergeAcrossOwners = false, renderOwners?: Uint8Array,
  suppressBottomBoundary = false): SurfaceMesh {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < cells.length; i += 6) {
    minX = Math.min(minX, cells[i]); maxX = Math.max(maxX, cells[i]);
    minY = Math.min(minY, cells[i + 1]); maxY = Math.max(maxY, cells[i + 1]);
    minZ = Math.min(minZ, cells[i + 2]); maxZ = Math.max(maxZ, cells[i + 2]);
  }
  const low = [minX, minY, minZ], dimensions = [maxX - minX + 3, maxY - minY + 3, maxZ - minZ + 3];
  const strides = [1, dimensions[0], dimensions[0] * dimensions[1]];
  const occupied = new Map<number, number>();
  const key = (x: number, y: number, z: number) => (x - minX + 1) + (y - minY + 1) * strides[1] + (z - minZ + 1) * strides[2];
  for (let i = 0; i < cells.length; i += 6) occupied.set(key(cells[i], cells[i + 1], cells[i + 2]), i / 6);
  // Bake short-range occlusion into the existing vertex colors. Only voxels
  // outside the exposed face can darken it, so a flat wall stays evenly lit.
  const cornerLight = (axis: number, sign: number, plane: number, u: number, v: number,
    cornerU: number, cornerV: number): number => {
    const outside = plane + (sign > 0 ? 0 : -1);
    const insideU = u + (cornerU ? -1 : 0), outsideU = u + (cornerU ? 0 : -1);
    const insideV = v + (cornerV ? -1 : 0), outsideV = v + (cornerV ? 0 : -1);
    const sample = (sampleU: number, sampleV: number): boolean => {
      if (axis === 0) return occupied.has(key(outside, sampleU, sampleV));
      if (axis === 1) return occupied.has(key(sampleV, outside, sampleU));
      return occupied.has(key(sampleU, sampleV, outside));
    };
    const sideU = sample(outsideU, insideV), sideV = sample(insideU, outsideV);
    const occlusion = sideU && sideV ? 3 : Number(sideU) + Number(sideV) + Number(sample(outsideU, outsideV));
    return 1 - occlusion * 0.105;
  };
  const planes = new Map<string, Plane>();
  let exposedFaces = 0;
  for (const [address, index] of occupied) {
    // Halo cells participate in occlusion tests but their own faces belong to
    // a neighboring remesh region and must not be emitted here.
    if (renderOwners && !renderOwners[index]) continue;
    const offset = index * 6;
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      if (suppressBottomBoundary && axis === 1 && sign < 0 && cells[offset + 1] === minY) continue;
      if (occupied.has(address + sign * strides[axis])) continue;
      exposedFaces++;
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const plane = cells[offset + axis] + (sign > 0 ? 1 : 0);
      const rgb = [cells[offset + 3], cells[offset + 4], cells[offset + 5]];
      const owner = mergeAcrossOwners ? MERGED_VOXEL_OWNER : owners[index] ?? 0;
      const ownerKey = mergeAcrossOwners ? '*' : owner;
      const planeKey = `${axis}:${sign}:${plane}:${ownerKey}:${rgb.join(':')}`;
      let entry = planes.get(planeKey);
      if (!entry) { entry = { axis, sign, plane, owner, color: rgb, cells: new Map() }; planes.set(planeKey, entry); }
      entry.cells.set((cells[offset + v] - low[v]) * dimensions[u] + cells[offset + u] - low[u], index);
    }
  }
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], indexes: number[] = [], voxelForFace: number[] = [];
  for (const plane of planes.values()) {
    const { axis, sign } = plane, u = (axis + 1) % 3, v = (axis + 2) % 3, row = dimensions[u];
    for (const origin of [...plane.cells.keys()].sort((a, b) => a - b)) {
      if (!plane.cells.has(origin)) continue;
      const x = origin % row, y = Math.floor(origin / row);
      let width = 1, height = 1;
      while (x + width < row && plane.cells.has(origin + width)) width++;
      outer: while (true) {
        for (let dx = 0; dx < width; dx++) if (!plane.cells.has(origin + height * row + dx)) break outer;
        height++;
      }
      for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) plane.cells.delete(origin + dy * row + dx);
      const start = positions.length / 3;
      const corners = sign > 0 ? [[0, 0], [width, 0], [width, height], [0, height]] : [[0, 0], [0, height], [width, height], [width, 0]];
      for (const [du, dv] of corners) {
        const point = [0, 0, 0], normal = [0, 0, 0];
        point[axis] = plane.plane; point[u] = x + low[u] + du; point[v] = y + low[v] + dv; normal[axis] = sign;
        const light = cornerLight(axis, sign, plane.plane, point[u], point[v], du === width ? 1 : 0, dv === height ? 1 : 0);
        positions.push(...point); normals.push(...normal);
        colors.push(plane.color[0] * light, plane.color[1] * light, plane.color[2] * light);
      }
      indexes.push(start, start + 1, start + 2, start, start + 2, start + 3);
      voxelForFace.push(plane.owner, plane.owner);
    }
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), colors: Float32Array.from(colors), indexes: Uint32Array.from(indexes), voxelForFace: Uint32Array.from(voxelForFace), exposedFaces, quads: indexes.length / 6 };
}
