import * as THREE from 'three';
import { voxelCuboid } from './VoxelSystem';
import { CITY_VOXEL_SIZE as S } from './VoxelConstants';
const block=(w:number,h:number,d:number,paint:string,x:number,y:number,z:number,parent:THREE.Group)=>{
  const mesh=voxelCuboid(w*S,h*S,d*S,paint,.95,S);mesh.position.set(x*S,y*S,z*S);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);
};
/** Related species vary their architecture, maturity and leaf palette, with
 * repeatable cuboid geometry that can be instanced by the chunk renderer. */
export function natureTree(seed:number,wet=false):THREE.Group {
  seed=Math.abs(Math.floor(seed));
  const root=new THREE.Group();root.name='nature-tree';const species=wet?3:Math.abs(seed)%6;
  const mature=Math.floor(seed/6)%3, trunk=7+mature*2, green=['#628e46','#427d5f','#91ac51','#537f52','#a1b05c','#6c9d72'][species];
  block(1,trunk,1,'#806047',0,trunk/2,0,root);
  if(species===1){ // cypress
    for(let tier=0;tier<4;tier++)block(5-tier,3,5-tier,tier===3?'#83a964':green,0,trunk-1+tier*2,0,root);
  }else if(species===4){ // palm, stepped cardinal fronds
    for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])for(let step=0;step<3;step++)
      block(dx?3:2,1,dz?3:2,step===2?'#779a46':green,dx*(step*2+1),trunk+2-step,dz*(step*2+1),root);
  }else{
    block(5+mature,3,5+mature,green,0,trunk,0,root);
    for(const [dx,dz] of [[-3,-1],[3,1],[0,-3]]){
      block(1,4,1,'#8c6b48',dx*.5,trunk-2,dz*.5,root);
      block(4,3,4,species===5?'#d795ac':green,dx,trunk+1,dz,root);
      if(species===3)block(2,4,2,'#7caa66',dx,trunk-1,dz,root);
    }
    block(4,2,4,species===5?'#edb2b6':'#a0bc65',0,trunk+2.5,0,root);
  }
  return root;
}
export function naturePatch(seed:number,wet=false):THREE.Group {
  seed=Math.abs(Math.floor(seed));
  const group=new THREE.Group();group.name=wet?'riverside-reeds':'garden-understory';group.userData.microNature=true;
  const flowers=['#e9c86c','#db879c','#a8acd1','#f2dcc0'];
  for(let i=0;i<5;i++){
    const x=((i*7+seed)%5)-2,z=((i*3+seed)%5)-2,height=wet?3+i%3:1+i%2;
    block(1,height,1,wet?'#779462':'#7a9951',x,height/2,z,group);
    if(!wet&&i%2===0)block(1,1,1,flowers[(seed+i)%4],x,height+.5,z,group);
  }
  return group;
}
