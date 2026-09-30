/** Combine adjacent coplanar ground cells while keeping one continuous texture atlas. */
export function meshFlatSurface(width: number, depth: number, heights: Float32Array, size: number, originX: number, originZ: number): {
  positions: Float32Array; uvs: Float32Array; indexes: Uint32Array; quads: number;
} {
  if (heights.length !== width * depth) throw new Error('Invalid surface height map');
  const visited = new Uint8Array(heights.length);
  const positions: number[] = [], uvs: number[] = [], indexes: number[] = [];
  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    const cell = z * width + x;
    if (visited[cell] || !Number.isFinite(heights[cell])) continue;
    const height = heights[cell];
    let spanX = 1, spanZ = 1;
    while (x + spanX < width && !visited[cell + spanX] && heights[cell + spanX] === height) spanX++;
    outer: while (z + spanZ < depth) {
      const row = (z + spanZ) * width + x;
      for (let dx = 0; dx < spanX; dx++) if (visited[row + dx] || heights[row + dx] !== height) break outer;
      spanZ++;
    }
    for (let dz = 0; dz < spanZ; dz++) for (let dx = 0; dx < spanX; dx++) visited[(z + dz) * width + x + dx] = 1;
    const first = positions.length / 3;
    const x0 = originX + x * size, x1 = originX + (x + spanX) * size;
    const z0 = originZ + z * size, z1 = originZ + (z + spanZ) * size;
    positions.push(x0, height, z0, x0, height, z1, x1, height, z1, x1, height, z0);
    uvs.push(x / width, z / depth, x / width, (z + spanZ) / depth,
      (x + spanX) / width, (z + spanZ) / depth, (x + spanX) / width, z / depth);
    indexes.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return { positions: Float32Array.from(positions), uvs: Float32Array.from(uvs), indexes: Uint32Array.from(indexes), quads: indexes.length / 6 };
}

export type SurfaceCutout={x0:number;x1:number;z0:number;z1:number};
/** Preserve greedy flat areas and clip boundary cells exactly to plaza/canal footprints. */
export function meshTerrainSurface(width:number,depth:number,heights:Float32Array,size:number,originX:number,originZ:number,
  elevation:(x:number,z:number)=>number,hole:(x:number,z:number)=>boolean,cutouts:SurfaceCutout[]=[]) {
  const flat=new Float32Array(heights),pieces:Array<{x0:number;x1:number;z0:number;z1:number;offset:number}>=[];
  for(let z=0;z<depth;z++)for(let x=0;x<width;x++) {
    const at=x+z*width,wx=originX+x*size,wz=originZ+z*size;
    if(hole(wx+size/2,wz+size/2)){flat[at]=NaN;continue;}
    const intersections=cutouts.filter(c=>c.x0<wx+size-1e-6&&c.x1>wx+1e-6&&c.z0<wz+size-1e-6&&c.z1>wz+1e-6);
    const h=[[wx,wz],[wx,wz+size],[wx+size,wz+size],[wx+size,wz]].map(([a,b])=>elevation(a,b)+heights[at]);
    if(!intersections.length&&h.every(v=>Math.abs(v-h[0])<1e-5)){flat[at]=h[0];continue;}
    flat[at]=NaN;
    const xs=[...new Set([wx,wx+size,...intersections.flatMap(c=>[Math.max(wx,c.x0),Math.min(wx+size,c.x1)])])].sort((a,b)=>a-b);
    const zs=[...new Set([wz,wz+size,...intersections.flatMap(c=>[Math.max(wz,c.z0),Math.min(wz+size,c.z1)])])].sort((a,b)=>a-b);
    for(let j=0;j<zs.length-1;j++)for(let i=0;i<xs.length-1;i++) {
      const cx=(xs[i]+xs[i+1])/2,cz=(zs[j]+zs[j+1])/2;
      if(intersections.some(c=>cx>c.x0&&cx<c.x1&&cz>c.z0&&cz<c.z1))continue;
      pieces.push({x0:xs[i],x1:xs[i+1],z0:zs[j],z1:zs[j+1],offset:heights[at]});
    }
  }
  const merged=meshFlatSurface(width,depth,flat,size,originX,originZ);
  const positions=Array.from(merged.positions),uvs=Array.from(merged.uvs),indexes=Array.from(merged.indexes);
  for(const {x0,x1,z0,z1,offset} of pieces){const first=positions.length/3;
    for(const [x,z] of [[x0,z0],[x0,z1],[x1,z1],[x1,z0]]) {
      positions.push(x,elevation(x,z)+offset,z);uvs.push((x-originX)/(width*size),(z-originZ)/(depth*size));
    }
    indexes.push(first,first+1,first+2,first,first+2,first+3);
  }
  return {positions:Float32Array.from(positions),uvs:Float32Array.from(uvs),indexes:Uint32Array.from(indexes),quads:indexes.length/6};
}
