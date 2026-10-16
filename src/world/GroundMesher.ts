import { meshTerrainSurface, meshTerrainBanks, type SurfaceCutout } from './SurfacePatches';
import { UrbanTerrain } from './UrbanTerrain';
import { CANAL_BED_Y } from './CanalConstants';
import { CITY_VOXEL_SIZE, VOXEL_SIZE } from './VoxelConstants';
export type GroundLayerData={size:number;heights:Float32Array;width:number;depth:number;x0:number;z0:number;cutouts:SurfaceCutout[]};
export type GroundCover={bounds:number[];inverse:number[];nx:number;ny:number;nz:number;size:number;mask:Uint8Array};
export type GroundRequest={kind:'ground';id:number;revision:number;layer:GroundLayerData;covers:GroundCover[];
 terrain:{roadX:number[];roadZ:number[];center:number;size:number};border:{north:Float32Array;south:Float32Array;west:Float32Array;east:Float32Array}};
export function meshGround(data:GroundRequest) {
 const {layer,border,covers}=data;
 const terrain=new UrbanTerrain(data.terrain.roadX,data.terrain.roadZ,data.terrain.center,data.terrain.size);
 const hidden=new Uint8Array(layer.width*layer.depth);
 const borderHeight=(x:number,z:number)=>x<0?border.west[z]:x>=layer.width?border.east[z]:z<0?border.north[x]:border.south[x];
 for(const piece of covers) {
  const b=piece.bounds,e=piece.inverse;
  const x0=Math.max(0,Math.floor((b[0]-layer.x0)/layer.size)),x1=Math.min(layer.width-1,Math.floor((b[3]-layer.x0)/layer.size));
  const z0=Math.max(0,Math.floor((b[2]-layer.z0)/layer.size)),z1=Math.min(layer.depth-1,Math.floor((b[5]-layer.z0)/layer.size));
  const occupied=(x:number,y:number,z:number)=>{
   const ix=Math.floor((e[0]*x+e[4]*y+e[8]*z+e[12])/piece.size+piece.nx/2);
   const iy=Math.floor((e[1]*x+e[5]*y+e[9]*z+e[13])/piece.size+piece.ny/2);
   const iz=Math.floor((e[2]*x+e[6]*y+e[10]*z+e[14])/piece.size+piece.nz/2);
   return ix>=0&&ix<piece.nx&&iy>=0&&iy<piece.ny&&iz>=0&&iz<piece.nz&&piece.mask[ix+piece.nx*(iz+piece.nz*iy)];
  };
  for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++) {
   const wx=layer.x0+(x+.5)*layer.size,wz=layer.z0+(z+.5)*layer.size,y=terrain.height(wx,wz)+layer.heights[x+z*layer.width];
   if(y<b[1]-.001||y>b[4]+.001)continue;
   if(occupied(wx,y-.001,wz)||occupied(wx,y+.001,wz))hidden[x+z*layer.width]=1;
  }
 }
      const heights = layer.heights.slice();
      for (let i = 0; i < heights.length; i++) if (hidden[i]) heights[i] = NaN;
      const result = meshTerrainSurface(layer.width, layer.depth, heights, layer.size, layer.x0, layer.z0,
        (x,z) => terrain.height(x,z), () => false, layer.cutouts);
      const positions = Array.from(result.positions), uvs = Array.from(result.uvs), indexes = Array.from(result.indexes);
      type Riser={a:number[];b:number[];lowA:number;lowB:number;highA:number;highB:number;dx:number;dz:number};
      const risers=new Map<string,Riser>();
      const emitRiser=(r:Riser)=>{
        const first=positions.length/3;
        positions.push(r.a[0],r.lowA,r.a[1],r.b[0],r.lowB,r.b[1],r.b[0],r.highB,r.b[1],r.a[0],r.highA,r.a[1]);
        for(const point of [r.a,r.b,r.b,r.a])uvs.push(
          (point[0]-r.dx*layer.size/2-layer.x0)/(layer.width*layer.size),
          (point[1]-r.dz*layer.size/2-layer.z0)/(layer.depth*layer.size));
        if(r.dx===1||r.dz===-1)indexes.push(first,first+1,first+2,first,first+2,first+3);
        else indexes.push(first,first+2,first+1,first,first+3,first+2);
      };
      // The same height field owns crater walls and sidewalk edges. No
      // separate curb mesh can survive after the paving below it is removed.
      for (let z = 0; z < layer.depth; z++) for (let x = 0; x < layer.width; x++) {
        const height = heights[x + z * layer.width];
        if (!Number.isFinite(height)) continue;
        const x0 = layer.x0 + x * layer.size, z0 = layer.z0 + z * layer.size;
        for (const [dx,dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = x+dx, nz = z+dz;
          const wx=layer.x0+(nx+.5)*layer.size,wz=layer.z0+(nz+.5)*layer.size;
          if(layer.cutouts.some(c=>wx>c.x0&&wx<c.x1&&wz>c.z0&&wz<c.z1))continue;
          const top = nx < 0 || nz < 0 || nx >= layer.width || nz >= layer.depth
            ?borderHeight(nx,nz):heights[nx+nz*layer.width];
          if (!Number.isFinite(top) || top <= height) continue;
          const a = dx ? [x0+(dx>0?layer.size:0), z0] : [x0,z0+(dz>0?layer.size:0)];
          const b = dx ? [a[0],z0+layer.size] : [x0+layer.size,a[1]];
          const ea=terrain.height(a[0],a[1]),eb=terrain.height(b[0],b[1]);
          const riser:Riser={a,b,lowA:ea+height,lowB:eb+height,highA:ea+top,highB:eb+top,dx,dz};
          if(Math.abs(ea-eb)>1e-5){emitRiser(riser);continue;}
          const key=`${dx}:${dz}:${(dx?a[0]:a[1]).toFixed(5)}:${riser.lowA.toFixed(5)}:${riser.highA.toFixed(5)}`;
          const previous=risers.get(key);
          if(previous&&Math.hypot(previous.b[0]-a[0],previous.b[1]-a[1])<1e-5)previous.b=b;
          else {if(previous)emitRiser(previous);risers.set(key,riser);}
        }
      }
      for(const riser of risers.values())emitRiser(riser);

 const canal=terrain.canalBounds();
 const banks=meshTerrainBanks(layer.width,layer.depth,layer.heights,layer.size,layer.x0,layer.z0,
  (x,z)=>terrain.height(x,z),layer.cutouts,(x,z)=>x>=canal.x0-2.2&&x<=canal.x1+2.2&&!terrain.cutoutAt(x,z)?terrain.height(x,z)-CITY_VOXEL_SIZE:CANAL_BED_Y-VOXEL_SIZE*2);
 return {id:data.id,revision:data.revision,positions:Float32Array.from(positions),uvs:Float32Array.from(uvs),indexes:Uint32Array.from(indexes),
  bankPositions:banks.positions,bankIndexes:banks.indexes};
}
export type GroundResult=ReturnType<typeof meshGround>;
