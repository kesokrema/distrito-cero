import { VOXEL_SIZE } from './VoxelConstants';

export interface WalkSurface {
  id: string;
  kind: 'plaza' | 'ramp' | 'stairs' | 'bridge' | 'promenade';
  x0: number; x1: number; z0: number; z1: number;
  height: number; endHeight?: number; axis?: 'x' | 'z';
  solid?: boolean;
  navigable?:boolean;
  enabled?: (x: number, z: number) => boolean;
  heightAt?: (x: number, z: number) => number;
}
/** Spatially indexed, overlapping walkable layers. Solid plazas replace ground;
 * bridges preserve a separate traversable surface beneath them. */
export class SurfaceNetwork {
  readonly surfaces = new Map<string, WalkSurface>();
  private cells = new Map<string, WalkSurface[]>();
  constructor(private cellSize: number) {}
  add(surface: WalkSurface): void {
    if (this.surfaces.has(surface.id)) return;
    this.surfaces.set(surface.id, surface);
    for (let z=Math.floor(surface.z0/this.cellSize);z<=Math.floor(surface.z1/this.cellSize);z++)
      for(let x=Math.floor(surface.x0/this.cellSize);x<=Math.floor(surface.x1/this.cellSize);x++) {
        const key=`${x}:${z}`, bucket=this.cells.get(key)??[];bucket.push(surface);this.cells.set(key,bucket);
      }
  }
  at(x:number,z:number): WalkSurface[] {
    return (this.cells.get(`${Math.floor(x/this.cellSize)}:${Math.floor(z/this.cellSize)}`)??[])
      .filter(s=>x>=s.x0&&x<=s.x1&&z>=s.z0&&z<=s.z1&&s.enabled?.(x,z)!==false);
  }
  height(s:WalkSurface,x:number,z:number):number {
    if (s.heightAt) return s.heightAt(x,z);
    const t=s.axis==='x'?(x-s.x0)/(s.x1-s.x0):(z-s.z0)/(s.z1-s.z0);
    const delta=(s.endHeight??s.height)-s.height;
    if((s.kind==='ramp'||s.kind==='stairs')&&Math.abs(delta)>0.001) {
      const steps=Math.max(1,Math.round(Math.abs(delta)/VOXEL_SIZE));
      const segment=Math.min(steps-1,Math.floor(Math.max(0,Math.min(1,t))*steps));
      return s.height+delta*(delta>0?(segment+1)/steps:segment/steps);
    }
    return s.height+delta*Math.max(0,Math.min(1,t));
  }
  ground(x:number,z:number,base:number):number {
    const solid=this.at(x,z).filter(s=>s.solid);
    return solid.length?Math.max(...solid.map(s=>this.height(s,x,z))):base;
  }
  reachable(x:number,z:number,currentY:number,maxStep=.55):{surface:WalkSurface;height:number}|null {
    let best:{surface:WalkSurface;height:number}|null=null;
    const candidates=this.at(x,z);
    for(const surface of candidates) {
      const height=this.height(surface,x,z);
      // Buried soil must never steal contact from intact paving or a ramp.
      if(surface.navigable===false&&candidates.some(s=>s!==surface&&this.height(s,x,z)>height+1e-5))continue;
      if(Math.abs(height-currentY)<=maxStep&&(!best||Math.abs(height-currentY)<Math.abs(best.height-currentY))) best={surface,height};
    }
    return best;
  }
  /** Only floors below the object can receive a falling body or a particle. */
  below(x:number,z:number,y:number,base:number):number {
    let height=base<=y+.35?base:-Infinity;
    for(const s of this.at(x,z)) {const h=this.height(s,x,z);if(h<=y+.35&&h>height)height=h;}
    return Number.isFinite(height)?height:base;
  }
}
