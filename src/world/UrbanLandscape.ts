import * as THREE from 'three';
import type { GridSystem, BlockBounds } from './GridSystem';
import type { WalkSurface } from './SurfaceNetwork';
import { voxelCuboid } from './VoxelSystem';
import { VOXEL_SIZE } from './VoxelConstants';
import { CANAL_BED_Y, CANAL_SURFACE_Y, createCanalFlow } from './CanalWater';
import { naturePatch,natureTree } from './NaturePrefabs';
const stone='#abaf98';
export class UrbanLandscape {
  constructor(private grid:GridSystem){}
  private box(root:THREE.Group,w:number,h:number,d:number,x:number,y:number,z:number,paint=stone):THREE.Mesh {
    const mesh=voxelCuboid(w,h,d,paint,.9);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;root.add(mesh);return mesh;
  }
  private foundation(root:THREE.Group,s:WalkSurface,height:number):void {
    const floor=this.box(root,s.x1-s.x0,VOXEL_SIZE,s.z1-s.z0,
      (s.x0+s.x1)/2,height-VOXEL_SIZE/2,(s.z0+s.z1)/2,'#998b6c');
    floor.name='voxel-earth-foundation';floor.castShadow=false;
    this.grid.surfaces.add({...s,id:s.id+':earth',kind:'promenade',navigable:false,height,endHeight:undefined,enabled:undefined});
  }
  build(bounds:BlockBounds):THREE.Group {
    const root=new THREE.Group();root.userData.terrainApplied=true;root.name='urban-landscape';root.userData.furniture=true;
    if(bounds.bx===this.grid.terrain.canalColumn)this.canal(root,bounds);
    else if(this.grid.blockProfile(bounds.bx,bounds.bz).district==='park')this.plaza(root,bounds);
    return root;
  }
  private ramp(root:THREE.Group,s:WalkSurface):void {
    this.grid.surfaces.add(s);
    const bottom=Math.min(s.height,s.endHeight??s.height)-VOXEL_SIZE;
    const steps=Math.max(1,Math.round(Math.abs((s.endHeight??s.height)-s.height)/VOXEL_SIZE));
    this.foundation(root,s,bottom-VOXEL_SIZE);
    for(let i=0;i<steps;i++) {
      const lo=i/steps,hi=(i+1)/steps;
      const cx=s.axis==='x'?s.x0+(s.x1-s.x0)*(lo+hi)/2:(s.x0+s.x1)/2;
      const cz=s.axis==='z'?s.z0+(s.z1-s.z0)*(lo+hi)/2:(s.z0+s.z1)/2;
      const top=this.grid.surfaces.height(s,cx,cz);
      const tread=this.box(root,s.axis==='x'?(s.x1-s.x0)/steps:s.x1-s.x0,top-bottom,
        s.axis==='z'?(s.z1-s.z0)/steps:s.z1-s.z0,cx,(top+bottom)/2,cz,
        s.kind==='stairs'?'#ceb994':'#c5bca2');
      tread.name=`voxel-${s.kind}-step`;
      tread.userData.walkSurfaceIds=[s.id];
    }
  }
  private plaza(root:THREE.Group,b:BlockBounds):void {
    const [x,z]=this.grid.world((b.x0+b.x1+3)/2,(b.z0+b.z1+3)/2),base=this.grid.terrain.height(x,z);
    const height=base+(this.grid.hash(b.bx,b.bz,945)>.45?1.32:-1.32),half=3.3;
    const id=`plaza:${b.bx}:${b.bz}`;
    this.grid.surfaces.add({id,kind:'plaza',x0:x-half,x1:x+half,z0:z-half,z1:z+half,height,solid:true});
    const deck=this.box(root,half*2,.22,half*2,x,height-.11,z,'#d7c3a2');deck.userData.walkSurfaceIds=[id];
    this.foundation(root,this.grid.surfaces.surfaces.get(id)!,Math.min(base,height)-.44);
    // Retaining sides have deliberate gaps where the accessible connections meet.
    for(const sign of [-1,1])for(const edge of [-1,1])
      this.box(root,.22,1.32,2.2,x+sign*half,(base+height)/2,z+edge*2.2,'#b1ac91');
    this.box(root,6.6,1.32,.22,x,(base+height)/2,z-half,'#b1ac91');
    for(const side of [-1,1])this.box(root,2.2,1.32,.22,x+side*2.2,(base+height)/2,z+half,'#b1ac91');
    this.ramp(root,{id:id+':ramp-west',kind:'ramp',x0:x-half-6.6,x1:x-half,z0:z-1.1,z1:z+1.1,height:base,endHeight:height,axis:'x',solid:true});
    this.ramp(root,{id:id+':ramp-east',kind:'ramp',x0:x+half,x1:x+half+6.6,z0:z-1.1,z1:z+1.1,height,endHeight:base,axis:'x',solid:true});
    this.ramp(root,{id:id+':stairs',kind:'stairs',x0:x-1.1,x1:x+1.1,z0:z+half,z1:z+half+5.28,height,endHeight:base,axis:'z',solid:true});
    for(const side of [-1,1]){
      const planter=this.box(root,1.32,.44,1.32,x+side*2.2,height+.22,z-2.2,'#b77c61');planter.name='plaza-planter';
      const patch=naturePatch(b.bx+b.bz+side+2);patch.position.set(x+side*2.2,height+.44,z-2.2);root.add(patch);
    }
  }
  private canal(root:THREE.Group,b:BlockBounds):void {
    const {x0,x1}=this.grid.terrain.canalBounds(),z0=this.grid.world(0,b.z0)[1]-this.grid.cellSize/2,z1=this.grid.world(0,b.z1)[1]-this.grid.cellSize/2;
    const water=voxelCuboid(x1-x0,VOXEL_SIZE,z1-z0,'#579eab',.28);
    water.position.set((x0+x1)/2,CANAL_SURFACE_Y-VOXEL_SIZE/2,(z0+z1)/2);
    water.receiveShadow=true;water.name='canal-water';water.userData.noObstacle=true;root.add(water);
    root.add(createCanalFlow({x0,x1,z0,z1,phase:this.grid.hash(b.bx,b.bz,771)}));
    this.box(root,x1-x0,.44,z1-z0,(x0+x1)/2,CANAL_BED_Y-.22,(z0+z1)/2,'#586f63');
    const bridgeEnd=z0+this.grid.cellSize*3;
    for(const side of [-1,1]){
      const bank=side<0?x0:x1,cx=bank+side*1.1;
      // Lower promenades pass underneath road bridges.
      const id=`riverwalk:${b.bx}:${b.bz}:${side}`;
      this.grid.surfaces.add({id,kind:'promenade',x0:cx-1.1,x1:cx+1.1,z0,z1,height:-3.52,solid:false});
      this.grid.surfaces.add({id:id+':open',kind:'promenade',x0:cx-1.1,x1:cx+1.1,z0:bridgeEnd,z1,height:-3.52,solid:true});
      const path=this.box(root,2.2,.22,z1-z0,cx,-3.63,(z0+z1)/2,'#b1b4a0');path.userData.walkSurfaceIds=[id,id+':open'];
      this.foundation(root,this.grid.surfaces.surfaces.get(id)!,-3.96);
      this.grid.surfaces.add({...this.grid.surfaces.surfaces.get(id+':open')!,id:id+':earth-open',navigable:false,height:-3.96});
      const accessStart=Math.max(bridgeEnd+2.2,z1-22),accessEnd=z1-4.4;
      // A parallel ramp descends beside the lower path, with no wall across its landing.
      for(const [a,c] of [[z0,accessStart],[accessEnd+2.2,z1]])if(c>a)
        this.box(root,.44,3.52,c-a,bank+side*2.42,-1.76,(a+c)/2,'#899b86');
      this.ramp(root,{id:id+':access',kind:'ramp',x0:side<0?bank-4.4:bank+2.2,x1:side<0?bank-2.2:bank+4.4,
        z0:accessStart,z1:accessEnd,height:0,endHeight:-3.52,axis:'z',solid:true});
      // The street cutout exposes the outer side of every descending tread.
      // Close the full street-to-canal drop with a voxel retaining wall.
      const outerEdge=bank+side*4.4;
      const landingEnd=accessEnd+2.2;
      const retaining=this.box(root,.22,3.96,landingEnd-accessStart,
        outerEdge+side*.11,-1.98,(accessStart+landingEnd)/2,'#899b86');
      retaining.name='canal-access-retaining-wall';
      const landingX=bank+side*3.3;
      const corner=this.box(root,2.2,3.96,.22,landingX,-1.98,landingEnd+.11,'#899b86');
      corner.name='canal-access-corner-return';
      this.box(root,2.2,.22,2.2,landingX,-3.63,accessEnd+1.1,'#b1b4a0');
      this.grid.surfaces.add({id:id+':landing',kind:'promenade',x0:landingX-1.1,x1:landingX+1.1,z0:accessEnd,z1:accessEnd+2.2,height:-3.52,solid:true});
      for(let z=bridgeEnd+2.2;z<z1-8;z+=6.6){
        const patch=naturePatch(b.bz+Math.round(z)+10000,true);patch.position.set(bank-side*.44,-3.74,z);root.add(patch);
        const tree=natureTree(b.bz+100,true);tree.position.set(bank+side*6.6,0,z);root.add(tree);
      }
      // Road bridge piers and rails leave both lower paths open.
      this.box(root,.44,4.4,.88,bank-side*.44,-2.2,z0+3.3,'#8c9b93');
    }
    for(const z of [z0+.11,bridgeEnd-.11]){
      this.box(root,x1-x0+.88,.44,.22,(x0+x1)/2,.44,z,'#ded1b1');
      for(let x=x0;x<=x1;x+=2.2)this.box(root,.22,.66,.22,x,.33,z,'#718681');
    }
  }
}
