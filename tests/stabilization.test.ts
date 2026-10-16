import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CollisionWorld } from '../src/engine/CollisionWorld';
import { FixedStep } from '../src/engine/FixedStep';
import { PerformanceMonitor } from '../src/engine/PerformanceMonitor';
import { RenderQuality } from '../src/engine/RenderQuality';
import { LocomotionIK } from '../src/actors/LocomotionIK';
import { GridSystem } from '../src/world/GridSystem';
import { RagdollSystem } from '../src/actors/RagdollSystem';
import type { PrefabManager } from '../src/world/PrefabManager';
import { CombatSystem } from '../src/actors/CombatSystem';
import { InventorySystem } from '../src/actors/InventorySystem';
import type { NPCController } from '../src/actors/NPCController';
import type { DestructionSystem } from '../src/world/DestructionSystem';
import { EventBus } from '../src/core/EventBus';

test('capsule sweeps stop at thin walls at speed and slide diagonally without axis bias',()=>{
  const world=new CollisionWorld((_bounds,add)=>add(1,-2,-10,1.05,4,10));
  const result=world.move(new THREE.Vector3(0,0,0),new THREE.Vector3(20,0,3),.28,2.05);
  assert.ok(result.position.x<.722 && result.position.x>.70);
  assert.ok(Math.abs(result.position.z-3)<.005);
  const reverse=new CollisionWorld((_bounds,add)=>add(-10,-2,1,10,4,1.05));
  const swapped=reverse.move(new THREE.Vector3(),new THREE.Vector3(3,0,20),.28,2.05);
  assert.ok(Math.abs(swapped.position.z-result.position.x)<.005);
});

test('capsule handles ceilings, floors, low steps and blocked headroom',()=>{
  const ceiling=new CollisionWorld((_b,add)=>add(-5,2.5,-5,5,2.7,5));
  const jump=ceiling.move(new THREE.Vector3(),new THREE.Vector3(0,5,0),.28,2.05);
  assert.ok(jump.ceiling && jump.position.y<=.451);
  const floor=new CollisionWorld((_b,add)=>add(-5,-.3,-5,5,0,5));
  const fall=floor.move(new THREE.Vector3(0,6,0),new THREE.Vector3(0,-20,0),.28,2.05);
  assert.ok(fall.grounded && Math.abs(fall.position.y)<.005);
  const step=new CollisionWorld((_b,add)=>{add(-5,-.3,-5,5,0,5);add(.5,0,-2,4,.4,2);});
  const climb=step.moveCharacter(new THREE.Vector3(),new THREE.Vector3(1,-.005,0),.28,2.05,true);
  assert.ok(climb.position.x>.98 && Math.abs(climb.position.y-.4)<.005);
  const low=new CollisionWorld((_b,add)=>{add(-5,-.3,-5,5,0,5);add(.5,0,-2,4,.4,2);add(-5,2.2,-5,5,2.4,5);});
  const blocked=low.moveCharacter(new THREE.Vector3(),new THREE.Vector3(1,-.005,0),.28,2.05,true);
  assert.ok(blocked.position.x<.5 && !low.overlaps(blocked.position,.28,2.05));
});

test('capsule occupancy reads logical damage immediately and supports oriented boxes',()=>{
  let alive=true;
  const world=new CollisionWorld((_b,add)=>{if(alive)add(1,-1,-2,1.2,4,2);});
  assert.ok(world.move(new THREE.Vector3(),new THREE.Vector3(3,0,0),.28,2.05).position.x<1);
  alive=false;
  assert.equal(world.move(new THREE.Vector3(),new THREE.Vector3(3,0,0),.28,2.05).position.x,3);
  const rotated=new CollisionWorld((_b,add)=>add(-1,0,-3,1,2,3,Math.PI/2,5,5));
  assert.ok(rotated.overlaps(new THREE.Vector3(7,0,5),.28,2.05));
  assert.ok(!rotated.overlaps(new THREE.Vector3(5,0,7),.28,2.05));
});

test('sphere camera sweep keeps the whole lens outside walls',()=>{
  const world=new CollisionWorld((_b,add)=>add(1,-2,-3,1.1,5,3));
  const lens=world.sweepSphere(new THREE.Vector3(0,1.7,0),new THREE.Vector3(4,1.7,0),.22);
  assert.ok(lens.x<.781 && lens.x>.77);
});

test('overlapping floor and low headroom recover to a clear nearby pose',()=>{
  const world=new CollisionWorld((_b,add)=>{add(-5,-1,-5,5,.22,5);add(-.55,2,-1,.55,2.22,1);});
  const result=world.move(new THREE.Vector3(0,0,0),new THREE.Vector3(),.28,2.36);
  assert.ok(result.recovered);assert.ok(!world.overlaps(result.position,.28,2.36));
  assert.ok(result.position.y<.8,'recovery must not teleport onto the upper stair');
});

test('fixed-step movement is identical at 30, 60 and 120 FPS and catch-up is bounded',()=>{
  const positions=[30,60,120].map(fps=>{
    const clock=new FixedStep();let distance=0;
    for(let frame=0;frame<fps*5;frame++)clock.advance(1/fps,dt=>distance+=dt*8);
    return distance;
  });
  assert.ok(positions.every(x=>Math.abs(x-40)<1e-8));
  const clock=new FixedStep();let calls=0;
  clock.advance(5,()=>calls++);assert.equal(calls,4);assert.ok(clock.droppedSeconds>4.8);
  clock.reset();assert.equal(clock.alpha,0);
});

test('diagnostics retain a bounded sample window and reset cleanly',()=>{
  const monitor=new PerformanceMonitor(true,10);
  for(let i=0;i<1000;i++)monitor.record('render',i);
  const stats=monitor.snapshot().render;
  assert.equal(stats.count,1000);assert.equal(stats.samples,10);assert.equal(stats.max,999);
  monitor.reset();assert.deepEqual(monitor.snapshot(),{});monitor.dispose();
});

test('quality adaptation ignores loading and uses sustained windows before changing detail',()=>{
  const quality=new RenderQuality(false);
  for(let i=0;i<900;i++)quality.sample(80,1/60,true);
  assert.equal(quality.level,'high');
  for(let i=0;i<300;i++)quality.sample(40,1/60,false);
  assert.equal(quality.level,'medium');
  quality.set('high');
  for(let i=0;i<600;i++)quality.sample(100,1/60,false);
  assert.equal(quality.level,'high');
});

test('actual character movement, jumping and contacts agree at 30/60/120 render FPS',()=>{
  const run=(fps:number)=>{
    const grid=new GridSystem(828507);grid.walkable=()=>true;grid.groundHeight=()=>0;
    const player=new LocomotionIK(grid,new THREE.Scene());
    player.setCollisionWorld(new CollisionWorld((_b,add)=>{add(-100,-1,-100,100,0,100);add(7,0,-10,7.04,5,10);add(-5,2.7,-5,5,2.9,5);}));
    const clock=new FixedStep();let ticks=0,maxHeight=0;
    for(let frame=0;frame<fps*3;frame++)clock.advance(1/fps,dt=>{
      if(ticks++===20)player.jump();
      player.update(dt,new THREE.Vector2(1,0),[],true);maxHeight=Math.max(maxHeight,player.group.position.y);
    });
    return {position:player.group.position.clone(),maxHeight};
  };
  const values=[30,60,120].map(run);
  assert.ok(values.every(value=>value.position.distanceTo(values[0].position)<1e-6));
  assert.ok(values.every(value=>value.position.x<6.722&&value.maxHeight<.655&&value.maxHeight>.1));
});

test('sleeping bodies wake on impact and distant bodies still expire',()=>{
  const grid=new GridSystem(828507),scene=new THREE.Scene();
  const prefabs={vehicles:[],supportHeight:()=>0,upperFloorPresent:()=>false,interiorWalkable:()=>true,interiorObstacleAt:()=>false} as unknown as PrefabManager;
  const ragdolls=new RagdollSystem(scene,grid,prefabs);
  const body=ragdolls.spawn(new THREE.Vector3(),0,new THREE.Vector3(),{shirt:'#123456',pants:'#345678',skin:'#cba987',shoes:'#111111'},0,1,.1);
  body.sleeping=true;
  ragdolls.impact(body,body.joints[0].position,new THREE.Vector3(3,1,0));assert.equal(body.sleeping,false);
  body.sleeping=true;ragdolls.wakeAll();assert.equal(body.sleeping,false);
  ragdolls.update(.2,()=>false);assert.equal(ragdolls.active(body),false);
});

test('first-person shots originate at the collision-corrected camera eye',()=>{
  const scene=new THREE.Scene(),origins:THREE.Vector3[]=[];
  const player={group:new THREE.Group(),aimAt(){},animateFire(){}} as unknown as LocomotionIK;
  player.group.position.set(10,0,20);
  const npcs={raycast:(ray:THREE.Raycaster)=>{origins.push(ray.ray.origin.clone());return null;}} as unknown as NPCController;
  const prefabs={buildings:new THREE.Group(),interiorMeshesNear:()=>[],groundMeshesNear:()=>[],supportHeight:()=>0} as unknown as PrefabManager;
  const combat=new CombatSystem(scene,player,new InventorySystem(),npcs,{} as DestructionSystem,prefabs,new EventBus());
  const eye=new THREE.Vector3(2,1.4,3);
  combat.fire(new THREE.Vector3(2,1.4,50),true,false,false,null,eye);
  assert.equal(origins.length,1);assert.ok(origins[0].equals(eye));
});
