import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GridSystem } from '../src/world/GridSystem';
import { PrefabManager } from '../src/world/PrefabManager';
import { MERGED_VOXEL_OWNER, meshVoxelCells } from '../src/world/GreedyMesher';
import { GroundPhysics,stepVehicleSuspension } from '../src/engine/GroundPhysics';
import { SurfaceNetwork } from '../src/world/SurfaceNetwork';
import { natureTree } from '../src/world/NaturePrefabs';
import { meshFlatSurface,meshTerrainSurface,meshTerrainBanks } from '../src/world/SurfacePatches';
import { buildingArchitecture, WALL_DIRECTIONS } from '../src/world/BuildingArchitecture';
import { planBlock, frontageZ, frontageDirection, stairBay } from '../src/world/BuildingLayout';
import { CITY_VOXEL_SIZE, FLOOR_HEIGHT, VOXEL_SIZE as S } from '../src/world/VoxelConstants';
import { voxelCuboid, voxelSurfaceGeometry } from '../src/world/VoxelSystem';
import { meshVoxelDecorations, snapVoxelMeshToGrid } from '../src/world/VoxelDecorationMesher';
import { BUILDING_PREFABS } from '../src/world/StructurePrefabCatalog';
import { createRoofFeatureMesh } from '../src/world/RoofPrefabRenderer';
import { LocomotionIK } from '../src/actors/LocomotionIK';
import { InteriorSystem } from '../src/world/InteriorSystem';
import { VehicleSystem } from '../src/actors/VehicleSystem';
import { SparsePathfinder } from '../src/core/Pathfinding';
import { NPCController, type NPC } from '../src/actors/NPCController';
import { RagdollSystem } from '../src/actors/RagdollSystem';
import { CombatSystem } from '../src/actors/CombatSystem';
import { BloodParticles } from '../src/actors/BloodParticles';
import { MissileEffects } from '../src/actors/MissileEffects';
import { InventorySystem } from '../src/actors/InventorySystem';
import { createHumanoid } from '../src/actors/HumanoidModel';
import { EventBus } from '../src/core/EventBus';
import { DestructionSystem } from '../src/world/DestructionSystem';
import { CityClock } from '../src/engine/CityClock';
import { SunShadowState } from '../src/engine/SunShadowState';
import { ContactShadowSystem } from '../src/engine/ContactShadowSystem';
import { CANAL_BED_Y, CANAL_SURFACE_Y } from '../src/world/CanalWater';
import { mixamoReferencePose, retargetMixamoClip } from '../src/actors/MixamoAnimationSystem';

class MeshWorker {
  static jobs: Array<() => void> = [];
  onmessage?: (event: { data: unknown }) => void;
  postMessage(message: { id: number; pieces: Float32Array | unknown[]; references?: Uint32Array; renderOwners?: Uint8Array;
    voxelSize?:number; latticeOffset?:number[]; revision?:number; gridSize?:number }): void {
    if (message.gridSize !== undefined) {
      MeshWorker.jobs.push(() => this.onmessage?.({ data: { id: message.id, revision: message.revision,
        positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), indexes: new Uint32Array(),
        voxelForFace: new Uint32Array(), exposedFaces: 0, quads: 0 } }));
      return;
    }
    const { id, pieces, references, renderOwners, voxelSize, latticeOffset } = message as {
      id: number; pieces: Float32Array; references: Uint32Array; renderOwners: Uint8Array; voxelSize:number; latticeOffset:number[]
    };
    MeshWorker.jobs.push(() => {
      for (let i = 0; i < pieces.length; i += 6) for (let axis = 0; axis < 3; axis++) pieces[i + axis] = Math.round(pieces[i + axis] / voxelSize - latticeOffset[axis]);
      const geometry = meshVoxelCells(pieces, references, true, renderOwners);
      for (let i = 0; i < geometry.positions.length; i++) geometry.positions[i] = (geometry.positions[i] + latticeOffset[i % 3] - .5) * voxelSize;
      this.onmessage?.({ data: { id, ...geometry } });
    });
  }
  terminate() {}
}
Object.assign(globalThis, {
  Worker: MeshWorker,
  document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, strokeRect() {}, fillText() {} }) }) }
});
function drain(world: PrefabManager): void {
  for (let i = 0; i < 120; i++) {
    world.flushFarMeshes();
    if (!MeshWorker.jobs.length) return;
    MeshWorker.jobs.splice(0).forEach((job) => job());
  }
  throw new Error('Mesh queue did not drain');
}

test('large world allocates only requested cells', () => {
  const grid = new GridSystem(919809);
  assert.equal(grid.size, 1025);
  assert.equal(Object.keys(grid.cells).length, 0);
  grid.cell(grid.center, grid.center);
  assert.equal(Object.keys(grid.cells).length, 1);
});

test('Mixamo clip retargeting maps standard bones to voxel joints and strips root motion', () => {
  const times = [0, 1], rotations = [0, 0, 0, 1, 0, 0.1, 0, 0.995];
  const source = new THREE.AnimationClip('MixamoWalk', 1, [
    new THREE.QuaternionKeyframeTrack('mixamorig:Hips.quaternion', times, rotations),
    new THREE.VectorKeyframeTrack('mixamorig:Hips.position', times, [0, 0, 0, 0, 4, 2]),
    new THREE.QuaternionKeyframeTrack('mixamorig:Spine.quaternion', times, rotations),
    new THREE.QuaternionKeyframeTrack('mixamorig:Spine2.quaternion', times, rotations),
    new THREE.QuaternionKeyframeTrack('mixamorig:LeftArm.quaternion', times, rotations),
    new THREE.QuaternionKeyframeTrack('mixamorig:LeftForeArm.quaternion', times, rotations),
    new THREE.QuaternionKeyframeTrack('mixamorig:LeftUpLeg.quaternion', times, rotations),
    new THREE.QuaternionKeyframeTrack('mixamorig:LeftLeg.quaternion', times, rotations),
    new THREE.QuaternionKeyframeTrack('mixamorig:LeftFoot.quaternion', times, rotations)
  ]);
  const result = retargetMixamoClip(source);
  const tracks = result.tracks.map((track) => track.name);
  assert.ok(tracks.includes('mixamorigHips.quaternion'));
  assert.ok(tracks.includes('mixamorigSpine2.quaternion'));
  assert.ok(tracks.includes('mixamorigLeftArm.quaternion'));
  assert.ok(tracks.includes('mixamorigLeftForeArm.quaternion'));
  assert.ok(tracks.includes('mixamorigLeftUpLeg.quaternion'));
  assert.ok(tracks.includes('mixamorigLeftLeg.quaternion'));
  assert.ok(tracks.includes('mixamorigLeftFoot.quaternion'));
  assert.equal(tracks.includes('mixamorigHips.position'), false, 'locomotion owns actor translation');
  assert.equal(tracks.filter((track) => track === 'mixamorigSpine2.quaternion').length, 1, 'spine variants collapse to one voxel joint');
  const rig = createHumanoid({ shirt: '#334455', accent: '#dcb58a', pants: '#223344', shoes: '#111111', skin: '#efc89a', hair: '#392719', style: 1 });
  const mixer = new THREE.AnimationMixer(rig.body);
  mixer.clipAction(result).play();
  mixer.update(0.5);
  assert.ok(Math.abs(rig.arms[0].shoulder.quaternion.y) > 0.02, 'retargeted arm rotation reaches the voxel shoulder');
  mixer.stopAllAction();
});

test('Mixamo bind pose stays neutral on the voxel rig and rotates around the pelvis', () => {
  const sourceRig = new THREE.Group();
  const sourceArm = new THREE.Bone(); sourceArm.name = 'mixamorigLeftArm';
  sourceArm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.42);
  const sourceForearm = new THREE.Bone(); sourceForearm.name = 'mixamorigLeftForeArm'; sourceForearm.position.y = 2;
  sourceArm.add(sourceForearm); sourceRig.add(sourceArm);
  const source = new THREE.AnimationClip('BindPose', 1, [new THREE.QuaternionKeyframeTrack(
    'mixamorigLeftArm.quaternion', [0, 1], [...sourceArm.quaternion.toArray(), ...sourceArm.quaternion.toArray()]
  )]);
  const result = retargetMixamoClip(source, sourceRig);
  const neutral = result.tracks[0].values;
  assert.ok(Math.abs(neutral[0]) < 1e-5 && Math.abs(neutral[1]) < 1e-5 && Math.abs(neutral[2]) < 1e-5 && Math.abs(neutral[3] - 1) < 1e-5,
    'source bind rotations must become identity deltas on the voxel rig');
  const rig = createHumanoid({ shirt: '#334455', accent: '#dcb58a', pants: '#223344', shoes: '#111111', skin: '#efc89a', hair: '#392719', style: 1 });
  assert.equal(rig.hips.position.y, 1.32);
  assert.equal(rig.torso.position.y, 0.16);
  assert.equal(rig.legs[0].hip.parent, rig.hips);
});

const mixamoTestFiles = (process.env.MIXAMO_TEST_FBXS || process.env.MIXAMO_TEST_FBX || '').split(',').filter(Boolean);
test('downloaded Mixamo FBXs parse and drive voxel joints when fixture paths are set', { skip: !mixamoTestFiles.length }, () => {
  const referenceFile = mixamoTestFiles.find((file) => file.endsWith('/idle.fbx')) || mixamoTestFiles[0];
  const referenceBuffer = readFileSync(referenceFile);
  const referenceArrayBuffer = referenceBuffer.buffer.slice(referenceBuffer.byteOffset, referenceBuffer.byteOffset + referenceBuffer.byteLength) as ArrayBuffer;
  const referenceSource = new FBXLoader().parse(referenceArrayBuffer, '');
  const referenceClip = referenceSource.animations.find((clip) => clip.tracks.length > 0);
  assert.ok(referenceClip, 'shared idle reference contains animated tracks');
  const referencePose = mixamoReferencePose(referenceClip);
  for (const file of mixamoTestFiles) {
    const buffer = readFileSync(file);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const source = new FBXLoader().parse(arrayBuffer, '');
    const sourceClip = source.animations.find((clip) => clip.tracks.length > 0);
    assert.ok(sourceClip, `${file} contains at least one animated take`);
    const clip = retargetMixamoClip(sourceClip, source, referencePose);
    assert.ok(clip.tracks.length >= 12, `${file}: retargeted ${clip.tracks.length} Mixamo joints`);
    const rig = createHumanoid({ shirt: '#334455', accent: '#dcb58a', pants: '#223344', shoes: '#111111', skin: '#efc89a', hair: '#392719', style: 1 });
    const mixer = new THREE.AnimationMixer(rig.body);
    mixer.clipAction(clip).play();
    mixer.update(Math.min(0.5, clip.duration * 0.5));
    rig.root.updateMatrixWorld(true);
    const animatedBounds = new THREE.Box3().setFromObject(rig.root);
    const pelvisWorld = rig.hips.getWorldPosition(new THREE.Vector3());
    assert.ok(animatedBounds.min.y > -0.75 && animatedBounds.max.y < 3.8,
      `${file}: animation must stay within a humanoid-sized pose, got ${animatedBounds.min.y.toFixed(2)}..${animatedBounds.max.y.toFixed(2)}`);
    assert.ok(Math.abs(pelvisWorld.y - 1.32) < 1e-4, `${file}: pelvis remains anchored at its anatomical pivot`);
    const movingJoints = [rig.torso, rig.arms[0].shoulder, rig.arms[0].elbow, rig.legs[0].hip, rig.legs[0].knee]
      .filter((joint) => Math.abs(joint.quaternion.x) + Math.abs(joint.quaternion.y) + Math.abs(joint.quaternion.z) > 0.015).length;
    if (!file.endsWith('/idle.fbx')) assert.ok(movingJoints >= 2, `${file}: expected multiple animated joints, saw ${movingJoints}`);
    mixer.stopAllAction();
  }
});

test('city clock starts at a chosen hour and reduces street activity at night', () => {
  const clock = new CityClock(12);
  assert.equal(clock.daylight, 1);
  assert.equal(clock.streetActivity, 1);
  clock.hour = 18.5;
  assert.ok(clock.sunset > 0.8);
  clock.hour = 23;
  assert.ok(clock.daylight < 0.1);
  assert.ok(clock.streetActivity < 0.4);
  clock.update(3600);
  assert.ok(Math.abs(clock.hour - 23) < 1e-9, 'a full game day wraps to the same hour');
  clock.update(60);
  assert.ok(Math.abs(clock.hour - 23.4) < 1e-9, 'one real minute advances only 24 game minutes');
});

test('cached sunlight stays fixed within a solar minute and nearby camera movement', () => {
  const sunlight = new SunShadowState();
  const focus = new THREE.Vector3(1, 0, 1);
  assert.equal(sunlight.update(focus, 12), true);
  const initial = sunlight.offset.clone(), anchor = sunlight.center.clone();
  for (let frame = 1; frame <= 120; frame++) {
    focus.x = 1 + frame / 60;
    assert.equal(sunlight.update(focus, 12 + frame / 60 * 24 / 3600), false);
    assert.deepEqual(sunlight.center, anchor);
    assert.deepEqual(sunlight.offset, initial);
  }
  assert.equal(sunlight.update(focus, 12 + 1 / 60), true, 'slow solar motion eventually refreshes');
  const solarOffset = sunlight.offset.clone();
  focus.x = 20;
  assert.equal(sunlight.update(focus, 12 + 1 / 60), true, 'walking out of the shadow region refreshes the anchor');
  assert.deepEqual(sunlight.offset, solarOffset, 'moving the shadow region does not turn the sun');
});

test('simple contact shadows share one mesh, rest on real floors and cache stationary support', () => {
  const scene = new THREE.Scene();
  let samples = 0, floor = 4.4;
  const shadows = new ContactShadowSystem(scene, () => { samples++; return floor; }, 8);
  const actor = new THREE.Group(); actor.position.set(3, floor, 2); scene.add(actor);
  shadows.beginFrame(actor.position, 0);
  shadows.add(actor, 1.3, 1.1);
  shadows.endFrame();
  assert.equal(shadows.mesh.count, 1);
  assert.equal(shadows.mesh.geometry.index!.count, 6, 'two triangles per simple shadow');
  assert.equal(shadows.mesh.castShadow, false);
  assert.equal((shadows.mesh.material as THREE.Material).depthWrite, false);
  assert.equal((shadows.mesh.material as THREE.Material).depthTest, true);
  const matrix = new THREE.Matrix4(); shadows.mesh.getMatrixAt(0, matrix);
  assert.ok(Math.abs(matrix.elements[13] - (floor + 0.035)) < 1e-6, 'shadow rests on the upper storey');
  for (let i = 1; i <= 60; i++) {
    shadows.beginFrame(actor.position, i / 60);
    shadows.add(actor, 1.3, 1.1);
  }
  assert.equal(samples, 1, 'standing actors do not query floor geometry each frame');
  floor = 0.07; shadows.invalidate(); actor.position.y = floor;
  shadows.beginFrame(actor.position, 2); shadows.add(actor, 1.3, 1.1);
  shadows.mesh.getMatrixAt(0, matrix);
  assert.ok(Math.abs(matrix.elements[13] - (floor + 0.035)) < 1e-6, 'destroyed floors invalidate support');
  actor.visible = false;
  shadows.beginFrame(actor.position, 3); shadows.add(actor, 1.3, 1.1); shadows.endFrame();
  assert.equal(shadows.mesh.count, 0);
  assert.equal(shadows.mesh.visible, false);
  shadows.dispose();
});

test('facial decal sits outside the rendered voxel head', () => {
  const rig = createHumanoid({ shirt: '#446688', accent: '#ddbb88', pants: '#334455',
    shoes: '#222222', skin: '#dfae83', hair: '#332211', style: 0 });
  const head = rig.head.children.find((child) => child.userData.bodyPart === 'head') as THREE.Mesh;
  head.geometry.computeBoundingBox();
  assert.ok(head.geometry.boundingBox);
  assert.ok(rig.face.position.z > head.geometry.boundingBox.max.z + 0.005,
    'the opaque head must not hide its face decal');
});

test('1,470 seeded blocks have disjoint parcels, street access and usable stair bays', () => {
  let buildings = 0; const fronts = new Set<string>(), heights = new Set<number>(), footprints = new Set<string>();
  for (let seed = 1; seed <= 30; seed++) {
    const grid = new GridSystem(seed * 13957), center = grid.blockAt(grid.center, grid.center);
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      const bounds = grid.blockBounds(center.bx + dx, center.bz + dz);
      const district = grid.districtAt((bounds.x0 + bounds.x1) >> 1, (bounds.z0 + bounds.z1) >> 1);
      const plans = planBlock(grid, bounds, district);
      assert.deepEqual(plans, planBlock(grid, bounds, district));
      for (const plan of plans) {
        buildings++; fronts.add(plan.front); heights.add(plan.height); footprints.add(`${plan.width}:${plan.depth}`);
        assert.ok(plan.width >= 4 && plan.depth >= 5);
        assert.ok(plan.x >= bounds.x0 + 4 && plan.x + plan.width <= bounds.x1 - 1);
        assert.ok(plan.z >= bounds.z0 + 4 && plan.z + plan.depth <= bounds.z1 - 1);
        const entryX = plan.x + Math.floor(plan.width / 2), direction = frontageDirection(plan);
        for (const other of plans) if (other !== plan) {
          assert.ok(plan.x + plan.width <= other.x || other.x + other.width <= plan.x || plan.z + plan.depth <= other.z || other.z + other.depth <= plan.z);
          for (let z = frontageZ(plan) + direction; z > bounds.z0 + 2 && z < bounds.z1; z += direction)
            assert.ok(!(entryX >= other.x && entryX < other.x + other.width && z >= other.z && z < other.z + other.depth));
        }
        const stair = stairBay(plan);
        assert.notEqual(stair.x, entryX);
        assert.ok(stair.z0 > plan.z && stair.z1 < plan.z + plan.depth - 1);
      }
    }
  }
  assert.equal(fronts.size, 2); assert.ok(heights.size >= 4 && footprints.size > 15);
  console.log(JSON.stringify({ generatedPlansChecked: buildings, distinctFootprints: footprints.size, distinctHeights: heights.size }));
});

test('architectural storeys and terraces remain connected to the stair core across seeds', () => {
  const forms = new Set<string>(); let terraces = 0;
  for (let seed=1;seed<=20;seed++) {
    const grid=new GridSystem(seed*13957), center=grid.blockAt(grid.center,grid.center);
    for (let dz=-1;dz<=1;dz++) for (let dx=-1;dx<=1;dx++) {
      const bounds=grid.blockBounds(center.bx+dx,center.bz+dz);
      for (const plan of planBlock(grid,bounds,grid.blockProfile(bounds.bx,bounds.bz).district)) {
        const layout=buildingArchitecture(plan), stair=stairBay(plan); forms.add(layout.form);
        assert.equal(layout.roofLevel(stair.x,stair.z0),plan.height-1);
        assert.equal(layout.roofLevel(stair.x,stair.z1),plan.height-1);
        terraces+=layout.doors.length;
        for (let level=1;level<plan.height;level++) {
          const queue=[{x:stair.x,z:stair.z0}], reached=new Set([`${stair.x}:${stair.z0}`]);
          for(let i=0;i<queue.length;i++) for(const d of WALL_DIRECTIONS) {
            const a=queue[i],x=a.x+d.dx,z=a.z+d.dz,key=`${x}:${z}`;
            if(reached.has(key)||layout.roofLevel(x,z)<level) continue;
            const outside=layout.roofLevel(a.x,a.z)===level, nextOutside=layout.roofLevel(x,z)===level;
            if(outside!==nextOutside) {
              const high=outside?{x,z}:a, face=outside?(d.bit===1?2:d.bit===2?1:d.bit===4?8:4):d.bit;
              if(!layout.doors.some(door=>door.level===level&&door.x===high.x&&door.z===high.z&&door.face===face)) continue;
            }
            reached.add(key);queue.push({x,z});
          }
          for(let z=plan.z;z<plan.z+plan.depth;z++) for(let x=plan.x;x<plan.x+plan.width;x++)
            if(layout.roofLevel(x,z)>=level) assert.ok(reached.has(`${x}:${z}`),`unreachable ${layout.form} level ${level} at ${x},${z}`);
        }
      }
    }
  }
  assert.equal(forms.size,5);assert.ok(terraces>100);
});

test('seeded neighborhoods keep varied blocks, green pockets and connected park entrances', () => {
  const forms = new Set<string>(), parkStyles = new Set<string>(), palettes = new Set<number>();
  let fullParks = 0, pockets = 0, mixedUseBlocks = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const grid = new GridSystem(seed * 7919), center = grid.blockAt(grid.center, grid.center);
    for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) {
      const bounds = grid.blockBounds(center.bx + dx, center.bz + dz);
      const profile = grid.blockProfile(bounds.bx, bounds.bz);
      forms.add(profile.form); parkStyles.add(profile.parkStyle); palettes.add(profile.palette);
      const plans = planBlock(grid, bounds, profile.district);
      if (new Set(plans.map((plan) => plan.type)).size > 1) mixedUseBlocks++;
      if (profile.district === 'park') {
        fullParks++;
        assert.equal(plans.length, 0);
      }
      if (profile.form === 'pocket' && profile.district !== 'park') {
        pockets++;
        const midX = (bounds.x0 + bounds.x1) >> 1;
        for (let z = grid.pocketStart(bounds); z < bounds.z1 - 1; z++) {
          assert.equal(grid.cell(midX, z)?.tile, 'park');
          assert.equal(grid.parkPathAt(bounds, midX, z), true);
        }
      }
      for (const plan of plans) for (let z = plan.z; z < plan.z + plan.depth; z++) for (let x = plan.x; x < plan.x + plan.width; x++)
        assert.notEqual(grid.cell(x, z)?.tile, 'park', `building encroaches on green space at ${x},${z}`);
    }
  }
  assert.equal(forms.size, 5); assert.equal(parkStyles.size, 3); assert.equal(palettes.size, 4);
  assert.ok(fullParks > 100 && pockets > 100 && mixedUseBlocks > 350);
});

test('opaque blood and fire write depth and settle above street and upper floors', () => {
  const scene = new THREE.Scene();
  const blood = new BloodParticles(scene), missile = new MissileEffects(scene);
  const bloodMesh = scene.getObjectByName('blood-particles') as THREE.InstancedMesh;
  const flameMesh = scene.getObjectByName('missile-ground-fire') as THREE.InstancedMesh;
  for (const mesh of [bloodMesh, flameMesh]) {
    const material = mesh.material as THREE.MeshBasicMaterial;
    assert.equal(material.depthTest, true);
    assert.equal(material.depthWrite, true);
  }
  const bottom = (mesh: THREE.InstancedMesh, index: number): number => {
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
    mesh.getMatrixAt(index, matrix);
    matrix.decompose(position, new THREE.Quaternion(), scale);
    return position.y - scale.y / 2;
  };
  blood.emit(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, 1, 0), 1);
  blood.update(0.05);
  assert.ok(bottom(bloodMesh, 0) >= 0.07);
  blood.emit(new THREE.Vector3(0, FLOOR_HEIGHT - 0.5, 0), new THREE.Vector3(0, 1, 0), 1, FLOOR_HEIGHT);
  blood.update(0.05);
  assert.ok(bottom(bloodMesh, 1) >= FLOOR_HEIGHT + S - 0.001);
  missile.explode(new THREE.Vector3(0, 0.05, 0));
  missile.update(0.05);
  assert.ok(flameMesh.count > 0);
  for (let i = 0; i < flameMesh.count; i++) assert.ok(bottom(flameMesh, i) > 0.07);
  missile.explode(new THREE.Vector3(5, 1, 0), [new THREE.Vector3(5, 3, 0)]);
  missile.update(0.05);
  assert.ok(bottom(flameMesh, 24) >= 2.999, 'a flame anchored to a voxel stays on that voxel');
});

test('greedy surfaces preserve exposed area, holes, normals and ownership', () => {
  const cells: number[] = [];
  for (let y = 0; y < 3; y++) for (let z = 0; z < 2; z++) for (let x = 0; x < 4; x++) cells.push(x, y, z, 1, 0.5, 0.2);
  const solid = meshVoxelCells(Float32Array.from(cells), new Uint32Array(24).fill(7));
  assert.equal(solid.exposedFaces, 52); assert.equal(solid.quads, 6);
  assert.ok(solid.voxelForFace.every((owner) => owner === 7));
  for (let i = 0; i < solid.indexes.length; i += 3) {
    const a = new THREE.Vector3().fromArray(solid.positions, solid.indexes[i] * 3);
    const b = new THREE.Vector3().fromArray(solid.positions, solid.indexes[i + 1] * 3);
    const c = new THREE.Vector3().fromArray(solid.positions, solid.indexes[i + 2] * 3);
    const n = new THREE.Vector3().fromArray(solid.normals, solid.indexes[i] * 3);
    assert.ok(b.sub(a).cross(c.sub(a)).dot(n) > 0);
  }
  const intact = voxelSurfaceGeometry(4, 3, 2), mask = new Uint8Array(24).fill(1);
  mask[1 + 4 * (1 + 2 * 1)] = 0;
  const damaged = voxelSurfaceGeometry(4, 3, 2, mask);
  const ray = new THREE.Raycaster(new THREE.Vector3(-S / 2, 0, 4), new THREE.Vector3(0, 0, -1));
  const material = new THREE.MeshBasicMaterial();
  const before = ray.intersectObject(new THREE.Mesh(intact, material))[0];
  const after = ray.intersectObject(new THREE.Mesh(damaged, material))[0];
  assert.ok(after.distance - before.distance > S * 0.99);
});

test('voxel ambient occlusion darkens a recessed corner without shading an open face', () => {
  const surface = meshVoxelCells(Float32Array.of(
    0, 0, 0, 1, 1, 1,
    1, 1, 0, 1, 1, 1
  ), Uint32Array.of(0, 1));
  const top = (x: number, z: number): number => {
    for (let i = 0; i < surface.positions.length; i += 3) {
      if (surface.normals[i + 1] === 1 && surface.positions[i] === x &&
          surface.positions[i + 1] === 1 && surface.positions[i + 2] === z)
        return surface.colors[i];
    }
    throw new Error('expected exposed top-face corner');
  };
  assert.ok(top(1, 0) < top(0, 0), 'only the corner beside the higher voxel is occluded');
  assert.equal(top(0, 0), 1);
});

test('greedy shell merges adjacent voxel owners and emits only faces owned by the remesh region', () => {
  const cells = Float32Array.of(
    0, 0, 0, 1, 0.5, 0.2,
    1, 0, 0, 1, 0.5, 0.2
  );
  const owners = Uint32Array.of(14, 27);
  const separate = meshVoxelCells(cells, owners);
  const merged = meshVoxelCells(cells, owners, true);
  assert.ok(merged.quads < separate.quads, 'same-color faces across owners should merge');
  assert.ok(merged.voxelForFace.every((owner) => owner === 0xffffffff), 'merged quads must request coordinate-based damage lookup');
  const regionOnly = meshVoxelCells(cells, owners, true, Uint8Array.of(1, 0));
  assert.equal(regionOnly.exposedFaces, 5, 'the halo voxel occludes the shared face without drawing its own faces');
  assert.equal(regionOnly.quads, 5);
});

test('decorative voxels snap to one 3D lattice and hide the faces buried between pieces', () => {
  const first = voxelCuboid(CITY_VOXEL_SIZE, CITY_VOXEL_SIZE, CITY_VOXEL_SIZE, '#d87958', 0.9, CITY_VOXEL_SIZE);
  const second = voxelCuboid(CITY_VOXEL_SIZE, CITY_VOXEL_SIZE, CITY_VOXEL_SIZE, '#638fa2', 0.9, CITY_VOXEL_SIZE);
  first.position.set(0.21, 0.21, 0.21);
  second.position.set(0.65, 0.21, 0.21);
  const scene = new THREE.Scene(); scene.add(first, second);
  scene.updateMatrixWorld(true);

  assert.ok(snapVoxelMeshToGrid(first));
  assert.ok(snapVoxelMeshToGrid(second));
  scene.updateMatrixWorld(true);
  const firstBounds = new THREE.Box3().setFromObject(first);
  const secondBounds = new THREE.Box3().setFromObject(second);
  for (const coordinate of [firstBounds.min.x, firstBounds.min.y, firstBounds.min.z,
    secondBounds.min.x, secondBounds.min.y, secondBounds.min.z]) {
    assert.ok(Math.abs(coordinate / S - Math.round(coordinate / S)) < 1e-5);
  }
  assert.ok(Math.abs(firstBounds.max.x - secondBounds.min.x) < 1e-5, 'neighboring props should share one exact face');

  const surface = meshVoxelDecorations([first, second]);
  assert.ok(surface);
  assert.ok(surface.quads < 12, 'the internal shared faces must not be rendered');
  assert.ok(surface.voxelForFace.every(owner=>owner===MERGED_VOXEL_OWNER), 'merged prop quads resolve ownership by voxel coordinates');
  assert.equal(surface.quads * 2, surface.indexes.length / 3);
  second.userData.voxelMask = new Uint8Array(1);
  const masked = meshVoxelDecorations([first, second]);
  assert.ok(masked);
  assert.equal(masked.quads,6,'removed neighboring voxels leave only the intact cuboid exterior');
});

test('roof fixture meshes keep their real sparse voxel footprint and functional catalog', () => {
  assert.ok(BUILDING_PREFABS.hotel.roof.features.includes('pool'));
  assert.ok(BUILDING_PREFABS.apartment.roof.features.includes('laundry'));
  const fixture = createRoofFeatureMesh([
    { x: 0, y: 0, z: 0, paint: '#aa6655' },
    { x: 1, y: 0, z: 0, paint: '#668899' },
    { x: 0, y: 1, z: 0, paint: '#ddbb77' },
  ], 'test');
  assert.ok(fixture);
  assert.equal((fixture.userData.voxelMask as Uint8Array).reduce((sum, cell) => sum + cell, 0), 3);
  assert.equal((fixture.userData.voxelDimensions as { suppressBottomBoundary?: boolean }).suppressBottomBoundary, true);
});

test('coplanar ground cells share two triangles without changing their texture coordinates or height', () => {
  const heights = Float32Array.of(0, 0, 0, 0, 0.07, 0.07, 0.07, 0.07);
  const surface = meshFlatSurface(4, 2, heights, 2, 10, 20);
  assert.equal(surface.quads, 2);
  assert.deepEqual(Array.from(surface.positions.slice(0, 12)), [10, 0, 20, 10, 0, 22, 18, 0, 22, 18, 0, 20]);
  assert.deepEqual(Array.from(surface.uvs.slice(0, 8)), [0, 0, 0, 0.5, 1, 0.5, 1, 0]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(surface.indexes, 1));
  const ground = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  assert.ok(new THREE.Raycaster(new THREE.Vector3(17, 3, 21), new THREE.Vector3(0, -1, 0)).intersectObject(ground)[0]);
  const raised = new THREE.Raycaster(new THREE.Vector3(17, 3, 23), new THREE.Vector3(0, -1, 0)).intersectObject(ground)[0];
  assert.ok(raised && Math.abs(raised.point.y - 0.07) < 1e-6);
});

test('sparse A* respects road costs and reroutes after destruction changes', () => {
  const pathfinder = new SparsePathfinder(1025), indexes: number[] = [], costs: number[] = [];
  for (let z = 0; z < 3; z++) for (let x = 0; x < 6; x++) { indexes.push(z * 1025 + x); costs.push(z === 1 && x > 0 && x < 5 ? 9 : 1); }
  pathfinder.update(Uint32Array.from(indexes), new Uint8Array(18), Uint8Array.from(costs));
  const route = pathfinder.find(1025, 1030); assert.ok(route.length > 6);
  const wall = route[2]; pathfinder.update(Uint32Array.of(wall), Uint8Array.of(1));
  assert.ok(!pathfinder.find(1025, 1030).includes(wall)); assert.equal(pathfinder.cellCount, 17);
});

test('escape routing avoids stepping toward a nearby shooter when another path is open', () => {
  const navigation = new SparsePathfinder(9);
  const indexes = Array.from({ length: 81 }, (_, index) => index).filter((index) => index !== 4 + 3 * 9);
  navigation.update(Uint32Array.from(indexes), new Uint8Array(indexes.length));
  const path = navigation.find(4 + 4 * 9, 4 + 1 * 9, { x: 3, z: 4, radius: 6 });
  assert.ok(path.length > 0);
  assert.notEqual(path[1], 3 + 4 * 9, 'the first detour must not approach the shooter on the left');
});

test('real chunks retain precise damage, open entrances, floor coverage and bounded rendering on revisit', () => {
  const grid = new GridSystem(919809), scene = new THREE.Scene();
  const started = performance.now(), world = new PrefabManager(scene, grid);
  assert.equal(world.blueprintStats().blocks, (grid.roadX.length - 1) * (grid.roadZ.length - 1));
  assert.ok(world.blueprintStats().buildings > 0, 'all city parcels are planned before detailed chunks');
  const central = grid.blockAt(grid.center, grid.center);
  drain(world); scene.updateMatrixWorld(true);
  assert.ok(world.overlapRemovals.shell + world.overlapRemovals.static > 0,
    'generated buildings and scenery exercise the common voxel occupancy resolver');
  assert.ok(world.lightAnchors.some((anchor) => anchor.kind === 'street'));
  assert.ok(world.lightAnchors.some((anchor) => anchor.kind === 'interior'));
  assert.ok(world.lightAnchors.some((anchor) => anchor.kind === 'street' && world.cityLightActive(anchor)),
    'a generated streetlamp must remain functional after mesh aggregation');
  const paving = scene.getObjectByName('chunk-ground') as THREE.Mesh;
  assert.ok(paving, 'city block has a textured voxel ground');
  const bounds = paving.userData.groundBounds as { x0: number; z0: number; width: number; depth: number; size: number };
  const pixels = paving.userData.groundPixels as Uint8Array;
  const ix = Math.floor(bounds.width / 2), iz = Math.floor(bounds.depth / 2);
  const at = (iz * bounds.width + ix) * 4;
  const before = pixels.slice(at, at + 3);
  world.scorchGround(bounds.x0 + (ix + 0.5) * bounds.size, bounds.z0 + (iz + 0.5) * bounds.size, 1);
  assert.ok(pixels[at] < before[0] && pixels[at + 1] < before[1] && pixels[at + 2] < before[2],
    'explosion scorch changes the actual ground voxel colors');
  for (const key of grid.activeBlocks) {
    const [bx,bz]=key.split(':').map(Number),bounds=grid.blockBounds(bx,bz);
    for(const plan of planBlock(grid,bounds,grid.blockProfile(bx,bz).district)) {
      for(const door of buildingArchitecture(plan).doors) {
        const direction=WALL_DIRECTIONS.find(d=>d.bit===door.face)!,[wx,wz]=grid.world(door.x,door.z);
        for(let t=.3;t<1.9;t+=.2) assert.equal(world.interiorObstacleAt(wx+direction.dx*t,wz+direction.dz*t,grid.terrain.height(wx,wz)+door.level*FLOOR_HEIGHT+CITY_VOXEL_SIZE),false,`blocked terrace door ${plan.type}`);
      }
    }
  }
  const initial = world.streamingStats();
  const roofProfiles: THREE.Mesh[] = [], roofFeatures: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.userData.roofProfile) roofProfiles.push(object);
    if (object.userData.roofFeature) roofFeatures.push(object);
  });
  assert.equal(roofProfiles.length, 0, 'roofs must be structural shells, without a second decorative cover');
  assert.ok(roofFeatures.length > 0, 'generated buildings should render destructible roof fixtures');
  assert.ok(roofProfiles.every((mesh) => world.interiorPieces.some((piece) => piece.mesh === mesh)), 'roof profiles should be damageable pieces');
  assert.ok(roofFeatures.every((mesh) => world.interiorPieces.some((piece) => piece.mesh === mesh)), 'roof fixtures should be damageable pieces');
  for (const mesh of roofFeatures) {
    const piece=world.interiorPieces.find(p=>p.mesh===mesh)!;
    assert.ok(Math.abs(piece.bounds.min.y-mesh.parent!.userData.roofSupportY)<.001,'roof fixture must touch its supporting deck');
    const {nx,ny,nz}=piece.dimensions;
    const point=new THREE.Vector3();
    for(let z=0;z<nz;z++) for(let x=0;x<nx;x++) {
      if (!piece.mask[x+nx*z]) continue;
      point.set((x-(nx-1)/2)*CITY_VOXEL_SIZE,-(ny-1)/2*CITY_VOXEL_SIZE,(z-(nz-1)/2)*CITY_VOXEL_SIZE);
      mesh.localToWorld(point);
      assert.ok(world.upperFloorPresent(point.x,point.z,mesh.parent!.userData.roofLevel),'all supporting voxels need a deck below');
    }
  }

  assert.ok(initial.shellTriangles < initial.unmergedShellTriangles / 8);
  let largestWallQuad = 0, largestRoofQuad = 0;
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.geometry.userData.voxelForFace) return;
    const geometry = object.geometry, indexes = geometry.index!, positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
    for (let at = 0; at < indexes.count; at += 6) {
      const a = new THREE.Vector3().fromBufferAttribute(positions, indexes.getX(at));
      const b = new THREE.Vector3().fromBufferAttribute(positions, indexes.getX(at + 1));
      const c = new THREE.Vector3().fromBufferAttribute(positions, indexes.getX(at + 2));
      const area = b.sub(a).cross(c.sub(a)).length();
      if (Math.abs(normals.getY(indexes.getX(at))) > 0.9) largestRoofQuad = Math.max(largestRoofQuad, area);
      else largestWallQuad = Math.max(largestWallQuad, area);
    }
  });
  assert.ok(largestWallQuad > S * S * 30, 'intact walls should contain large two-triangle faces');
  assert.ok(largestRoofQuad > S * S * 30, 'intact roofs should contain large two-triangle faces');
  assert.ok(initial.groundTriangles > 0);
  assert.ok(initial.groundTriangles < initial.unmergedGroundTriangles / 4);
  const floorSurfaces: THREE.Mesh[] = [], detailSurfaces: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh && object.userData.aggregateSurface && object.userData.surfaceKind === 'floor') floorSurfaces.push(object);
    if (object instanceof THREE.Mesh && object.userData.aggregateSurface && object.userData.surfaceKind === 'detail') detailSurfaces.push(object);
  });
  assert.ok(floorSurfaces.length > 0, 'intact building floors should render as combined surfaces');
  const floorOriginalTriangles = floorSurfaces.reduce((sum, mesh) => sum + mesh.userData.surfaceStats.originalTriangles, 0);
  const floorTriangles = floorSurfaces.reduce((sum, mesh) => sum + mesh.userData.surfaceStats.triangles, 0);
  assert.ok(floorTriangles < floorOriginalTriangles / 4);
  assert.ok(detailSurfaces.length > 0, 'static building details should render as combined surfaces');
  const detailOriginalTriangles = detailSurfaces.reduce((sum, mesh) => sum + mesh.userData.surfaceStats.originalTriangles, 0);
  const detailTriangles = detailSurfaces.reduce((sum, mesh) => sum + mesh.userData.surfaceStats.triangles, 0);
  assert.ok(detailTriangles < detailOriginalTriangles * .9, 'each accepted aggregate must reduce the already greedy source geometry by at least 10%');
  const combinedFloor = floorSurfaces[0];
  const floorPiece = world.interiorPieces.find((piece) => piece.aggregate?.mesh === combinedFloor)!;
  const floorHit = new THREE.Raycaster(new THREE.Vector3(floorPiece.center.x, floorPiece.bounds.max.y + 2, floorPiece.center.z),
    new THREE.Vector3(0, -1, 0)).intersectObject(combinedFloor)[0];
  assert.ok(floorHit && world.interiorPieceForHit(floorHit) === floorPiece);
  const floorVoxel = world.interiorVoxelForHit(floorHit);
  assert.notEqual(floorVoxel, null);
  world.eraseSceneVoxels(floorPiece, [floorVoxel!]);
  world.flushStaticDamage();
  assert.ok(combinedFloor.parent, 'a damaged floor keeps its compressed render object');
  assert.ok(!floorPiece.mesh.visible && !floorPiece.mask[floorVoxel!], 'logical voxel damage does not restore source meshes');
  const combinedDetail = detailSurfaces.find((mesh) => {
    const piece = world.interiorPieces.find((item) => item.aggregate?.mesh === mesh);
    return piece && piece.bounds.max.y - piece.bounds.min.y <= S * 2;
  })!;
  assert.ok(combinedDetail);
  const detailPiece = world.interiorPieces.find((piece) => piece.aggregate?.mesh === combinedDetail)!;
  const detailHit = new THREE.Raycaster(new THREE.Vector3(detailPiece.center.x, detailPiece.bounds.max.y + 2, detailPiece.center.z),
    new THREE.Vector3(0, -1, 0)).intersectObject(combinedDetail)[0];
  assert.ok(detailHit && world.interiorPieceForHit(detailHit) === detailPiece);
  const detailVoxel = world.interiorVoxelForHit(detailHit);
  assert.notEqual(detailVoxel, null);
  world.eraseSceneVoxels(detailPiece, [detailVoxel!]);
  world.flushStaticDamage();
  assert.ok(combinedDetail.parent);
  assert.ok(!detailPiece.mesh.visible && !detailPiece.mask[detailVoxel!]);
  assert.ok(Object.keys(grid.cells).length < grid.size * grid.size / 20);
  // Mobile components follow their vehicle and are excluded before per-piece work when far away.
  const vehicle = world.vehicles.find((item) => item.parent && !item.userData.destroyed)!;
  assert.ok(vehicle);
  const vehiclePosition = vehicle.position.clone();
  const belongsToVehicle = (piece: ReturnType<PrefabManager['interiorPiecesNear']>[number]) => {
    let parent: THREE.Object3D | null = piece.mesh;
    while (parent) { if (parent === vehicle) return true; parent = parent.parent; }
    return false;
  };
  assert.ok(world.interiorPiecesNear(vehicle.position.x, vehicle.position.z, 4).some(belongsToVehicle));
  vehicle.position.x += 40;
  assert.ok(!world.interiorPiecesNear(vehiclePosition.x, vehiclePosition.z, 4).some(belongsToVehicle));
  assert.ok(world.interiorPiecesNear(vehicle.position.x, vehicle.position.z, 4).some(belongsToVehicle));
  vehicle.position.copy(vehiclePosition); vehicle.updateWorldMatrix(true, true);
  const collisionDamage = new DestructionSystem(scene, grid, world, new EventBus());
  const roadCell = grid.activeCells.find((cell) => cell.tile === 'road' &&
    !grid.terrain.waterAt(...grid.world(cell.x, cell.z)));
  assert.ok(roadCell, 'the generated neighborhood contains an ordinary road surface');
  const [roadX, roadZ] = grid.world(roadCell!.x, roadCell!.z);
  const roadHeight = grid.groundHeight(roadX, roadZ);
  const groundChunk = world.groundMeshesNear(roadX, roadZ, 0.1)[0];
  assert.ok(groundChunk, 'the road has a rendered terrain chunk');
  const roadPixels = groundChunk!.userData.groundPixels as Uint8Array;
  const groundBounds = groundChunk!.userData.groundBounds as { x0: number; z0: number; width: number; depth: number; size: number };
  const pixelIndex = (Math.floor((roadZ - groundBounds.z0) / groundBounds.size) * groundBounds.width +
    Math.floor((roadX - groundBounds.x0) / groundBounds.size)) * 4;
  const roadPixelBefore = [...roadPixels.slice(pixelIndex, pixelIndex + 3)];
  assert.equal(collisionDamage.damagePavementSurface(roadX, roadZ, 3), true, 'street surface accepts projectile damage');
  assert.notDeepEqual([...roadPixels.slice(pixelIndex, pixelIndex + 3)], roadPixelBefore,
    'the damaged voxel surface is visibly replaced by a darker exposed layer');
  assert.equal(grid.groundHeight(roadX, roadZ), roadHeight-CITY_VOXEL_SIZE, 'the destroyed road layer reveals a lower solid support');
  for(let i=0;i<30;i++)world.flushGroundDamage();
  assert.ok(Array.from(groundChunk!.geometry.getAttribute('position').array).every(Number.isFinite), 'craters never create NaN terrain geometry');
  assert.ok(groundChunk!.geometry.getAttribute('position').array.some((value,index)=>index%3===1&&Math.abs(value-(roadHeight-CITY_VOXEL_SIZE))<1e-5), 'the road crater has real lower geometry');
  const exposedBefore=[...roadPixels.slice(pixelIndex,pixelIndex+3)];
  for(let blast=0;blast<20;blast++)world.scorchGround(roadX,roadZ,1);
  const exposedAfter=[...roadPixels.slice(pixelIndex,pixelIndex+3)];
  assert.ok(exposedAfter.every((value,channel)=>value<=exposedBefore[channel]&&value>=25),
    'repeated scorching stays charcoal, never wraps a negative byte into white or blue');
  const sidewalk=grid.activeCells.find(c=>c.tile==='sidewalk'&&!c.blocked&&
    !grid.surfaces.at(...grid.world(c.x,c.z)).length&&
    [[-1,0],[1,0],[0,-1],[0,1]].some(([dx,dz])=>grid.cell(c.x+dx,c.z+dz)?.active&&grid.cell(c.x+dx,c.z+dz)?.tile==='road'))!;
  assert.ok(sidewalk,'the neighborhood has ordinary paving beside the asphalt');
  const [walkX,walkZ]=grid.world(sidewalk.x,sidewalk.z),walkHeight=grid.groundHeight(walkX,walkZ);
  const sidewalkMeshes=world.groundMeshesNear(walkX,walkZ,.1);
  const sidewalkProbe=new THREE.Raycaster(new THREE.Vector3(walkX,walkHeight+1,walkZ),new THREE.Vector3(0,-1,0));
  assert.ok(Math.abs(sidewalkProbe.intersectObjects(sidewalkMeshes,false)[0].point.y-walkHeight)<1e-5,'intact paving and collision height agree');
  const [dx,dz]=[[-1,0],[1,0],[0,-1],[0,1]].find(([dx,dz])=>grid.cell(sidewalk.x+dx,sidewalk.z+dz)?.active&&grid.cell(sidewalk.x+dx,sidewalk.z+dz)?.tile==='road')!;
  const edgeX=walkX+dx*grid.cellSize/2,edgeZ=walkZ+dz*grid.cellSize/2;
  const curbProbe=new THREE.Raycaster(new THREE.Vector3(edgeX+dx*.15,walkHeight-.035,edgeZ+dz*.15),new THREE.Vector3(-dx,0,-dz),0,.3);
  const edgeMeshes=world.groundMeshesNear(edgeX,edgeZ,1);
  assert.ok(curbProbe.intersectObjects(edgeMeshes,false).length,'the intact sidewalk edge has a visible riser');
  assert.equal(collisionDamage.damagePavementSurface(walkX,walkZ,3),true,'sidewalk voxels accept projectile damage');
  for(let i=0;i<30;i++)world.flushGroundDamage();
  assert.ok(Math.abs(grid.groundHeight(walkX,walkZ)-(walkHeight-CITY_VOXEL_SIZE))<1e-5,'paving reveals exactly one lower support layer');
  assert.ok(Math.abs(sidewalkProbe.intersectObjects(sidewalkMeshes,false)[0].point.y-grid.groundHeight(walkX,walkZ))<1e-5,'destroyed paving stays closed and matches physics');
  collisionDamage.blast(edgeX,edgeZ,1.4,'player',walkHeight+.2);
  for(let i=0;i<30;i++)world.flushGroundDamage();
  assert.equal(curbProbe.intersectObjects(edgeMeshes,false).length,0,'an explosion retires the curb with the adjoining pavement');
  assert.ok(Math.abs(grid.groundHeight(walkX,walkZ)-(walkHeight-CITY_VOXEL_SIZE))<1e-5,'repeated damage cannot dig beyond the protected foundation');
  const canalBounds = grid.terrain.canalBounds();
  const canalX = (canalBounds.x0 + canalBounds.x1) / 2;
  const canalZ = grid.world(grid.center, grid.roadZ[4] + 4)[1];
  if (grid.terrain.waterAt(canalX, canalZ)) {
    assert.equal(collisionDamage.damagePavementSurface(canalX, canalZ, 3), false, 'canal water cannot be damaged as a road voxel');
  }
  const vehiclePiece = world.vehicleDamageParts(vehicle)[0];
  const initialVoxels = vehiclePiece.mask.reduce((sum, value) => sum + value, 0);
  const removedByCrash = collisionDamage.damageVehicleImpact(vehicle,
    new THREE.Vector3(Math.sin(vehicle.rotation.y), 0, Math.cos(vehicle.rotation.y)), 12);
  assert.ok(removedByCrash > 0, 'a collision removes real voxels from the body');
  const debris = scene.getObjectByName('destruction-debris-billboards') as THREE.InstancedMesh;
  assert.equal(debris.geometry.type, 'PlaneGeometry', 'debris renders as two-dimensional billboards');
  assert.ok(debris.count > 0 && debris.count <= 180);
  const debrisCamera = new THREE.PerspectiveCamera();
  for (let frame = 0; frame < 165; frame++) collisionDamage.update(1 / 60, debrisCamera);
  assert.equal(debris.count, 0, 'expired debris stops updating and drawing');
  assert.equal(vehiclePiece.mask.reduce((sum, value) => sum + value, 0), initialVoxels - removedByCrash);
  assert.equal(vehicle.userData.destroyed, undefined, 'one collision must leave a driveable car');
  collisionDamage.blast(vehicle.position.x, vehicle.position.z, 1.1, 'player', vehicle.position.y + 0.8);
  const survivors = vehiclePiece.mask.reduce((sum, value) => sum + value, 0);
  assert.ok(survivors > 0 && survivors < initialVoxels - removedByCrash,
    'a blast removes some vehicle voxels and retains the surrounding body');
  assert.equal(vehicle.visible, true, 'surviving vehicle voxels remain visible');
  for (const anchor of world.pedestrianAnchors) assert.equal(anchor.cell.blocked, false);
  for (const stairs of world.staircases) {
    const x = stairs.centerX - stairs.laneOffset, z = stairs.startZ;
    assert.ok(world.stairSurface(x, z, 0));
    for (let level = 1; level <= stairs.maxLevel; level++) {
      const [cx, cz] = grid.world(stairs.room.x0 + Math.floor((stairs.room.x1 - stairs.room.x0) / 2), grid.grid(stairs.centerX, stairs.position.z)[1]);
      assert.ok(world.upperFloorPresent(cx, cz, level), `missing floor ${level}`);
    }
  }
  const staircase = world.staircases.find((stairs) => stairs.maxLevel >= 2)!;
  assert.ok(staircase);
  const walker = new LocomotionIK(grid, scene, (x, z) => world.interiorWalkable(x, z),
    (x, z, y) => world.stairSurface(x, z, y), (x, z, y) => world.interiorObstacleAt(x, z, y),
    (x, z, level) => world.upperFloorPresent(x, z, level),(x,z,level)=>world.floorHeightAt(x,z,level));
  const interior = new InteriorSystem(world, new InventorySystem(), walker);
  walker.group.position.set(staircase.centerX - staircase.laneOffset, staircase.position.y, staircase.startZ + 0.25);
  walker.setFloor(0,null);
  const walkTo = (x: number, z: number) => {
    for (let frame = 0; frame < 700; frame++) {
      const dx = x - walker.group.position.x, dz = z - walker.group.position.z;
      if (Math.hypot(dx, dz) < 0.04) { walker.velocity.set(0, 0, 0); return; }
      const input = new THREE.Vector2(dx, dz).clampLength(0, 0.5);
      walker.update(1 / 120, input, [], false);
      interior.update();
    }
    assert.fail(`walk blocked at ${walker.group.position.toArray()} toward ${x},${z}`);
  };
  walkTo(staircase.centerX - staircase.laneOffset, staircase.endZ - 0.23);
  assert.equal(walker.floorLevel, 1);
  walkTo(staircase.centerX + staircase.laneOffset, staircase.endZ - 0.23);
  walkTo(staircase.centerX + staircase.laneOffset, staircase.startZ + 0.23);
  assert.equal(walker.floorLevel, 2);
  const boundary = [staircase.room.x0, staircase.room.x1 - 1].map((gx) => grid.world(gx, staircase.room.z0 + 2))
    .find(([x, z]) => world.upperFloorPresent(x, z, 1));
  assert.ok(boundary, 'an outer room cell has an upper-floor slab');
  walker.setFloor(1, staircase.room);
  walker.group.position.set(boundary[0], FLOOR_HEIGHT, boundary[1]);
  interior.update();
  assert.equal(walker.floorLevel, 1);
  assert.equal(walker.group.position.x, boundary[0]);
  assert.equal(walker.group.position.z, boundary[1]);
  scene.remove(walker.group);
  const roof = world.voxels.find((voxel) => voxel.roof && voxel.pieces.length === 25)!;
  const roofPiece = Math.floor(roof.pieces.length / 2), roofAt = roofPiece * 3;
  const roofX = roof.x + roof.positions[roofAt], roofZ = roof.z + roof.positions[roofAt + 2];
  const roofLevel = Math.round((roof.y-(roof.baseY??0)) / FLOOR_HEIGHT - 0.5);
  assert.ok(world.upperFloorPresent(roofX, roofZ, roofLevel));
  roof.pieces[roofPiece] = 0; world.writeVoxel(world.voxels.indexOf(roof)); drain(world);
  assert.equal(world.upperFloorPresent(roofX, roofZ, roofLevel), false, 'destroyed roof voxel must leave a real gap');
  // Pristine pieces share storage; damage must never mutate their neighbors.
  const shared = world.interiorPieces.find((piece) => !piece.ownsState)!;
  const peer = world.interiorPieces.find((piece) => piece !== shared && piece.mask === shared.mask)!;
  assert.ok(peer);
  const peerHealth = peer.health[0];
  world.preparePieceDamage(shared); shared.health[0] = 0;
  world.eraseSceneVoxels(shared, [0]);
  assert.equal(peer.health[0], peerHealth); assert.equal(peer.mask[0], 1);
  // Sample every entrance across its actual wall plane, not only its grid cell.
  for (const key of grid.activeBlocks) {
    const [bx, bz] = key.split(':').map(Number), bounds = grid.blockBounds(bx, bz);
    const district = grid.districtAt((bounds.x0 + bounds.x1) >> 1, (bounds.z0 + bounds.z1) >> 1);
    for (const plan of planBlock(grid, bounds, district)) {
      const [doorX, doorZ] = grid.world(plan.x + Math.floor(plan.width / 2), frontageZ(plan));
      const direction = frontageDirection(plan);
      for (let depth = -0.2; depth < 2; depth += 0.15)
        assert.equal(world.interiorObstacleAt(doorX, doorZ + direction * depth, grid.terrain.height(doorX,doorZ)), false, `blocked ${plan.type} entry ${key}`);
    }
  }
  // Cast into the actual compressed shell, remove that exact voxel, and cast through the hole.
  const shell = world.buildings.children.find((child) => child instanceof THREE.Mesh) as THREE.Mesh;
  const geometry = shell.geometry;
  const p = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  const indexes = geometry.index!;
  const center = new THREE.Vector3();
  for (let i = 0; i < 3; i++) center.add(new THREE.Vector3().fromBufferAttribute(p, indexes.getX(i)));
  center.multiplyScalar(1 / 3);
  const normal = new THREE.Vector3().fromBufferAttribute(normals, indexes.getX(0));
  const ray = new THREE.Raycaster(center.clone().addScaledVector(normal, 0.6), normal.clone().negate());
  const hit = ray.intersectObject(shell)[0];
  assert.ok(hit);
  const hitOwner = world.voxelForHit(hit), hitSub = world.pieceForHit(hit);
  assert.notEqual(hitOwner, null); assert.notEqual(hitSub, null);
  const hitVoxel = world.voxels[hitOwner!];
  hitVoxel.pieces[hitSub!] = 0; world.writeVoxel(hitOwner!); drain(world);
  const holeHit = ray.intersectObject(shell)[0];
  assert.ok(!holeHit || holeHit.distance > hit.distance + S * 0.9, 'ray should pass through the removed voxel');
  const module = world.voxels.find((voxel) => !voxel.roof && voxel.structural !== false)!;
  const index = world.voxels.indexOf(module), sub = Array.from(module.pieces).findIndex((hp) => hp > 0);
  module.pieces[sub] = 0; world.writeVoxel(index); drain(world);
  assert.equal(module.pieces[sub], 0);
  // A frame may add a dynamic actor while a chunk generator is yielding.
  const actor = new THREE.Group(); actor.name = 'external-actor';
  const far = { bx: central.bx + 9, bz: central.bz + 5 };
  world.ensureAround(far.bx, far.bz, 1, 1); scene.add(actor);
  world.ensureAround(far.bx, far.bz, 1, Infinity); drain(world);
  assert.equal(actor.parent, scene);
  assert.ok(world.streamingStats().renderedBlocks <= 25);
  world.ensureAround(central.bx, central.bz, 1, Infinity); drain(world);
  assert.equal(module.pieces[sub], 0); assert.ok(world.streamingStats().renderedBlocks <= 25);
  const camera = new THREE.OrthographicCamera(-42, 42, 28, -28, 0.1, 200);
  camera.position.set(45, 60, 45); camera.lookAt(0, 0, 0);
  world.updateCameraVisibility(camera, new THREE.Vector3());
  const visibleAtHome = world.streamingStats().renderedBlocks;
  assert.ok(visibleAtHome > 0);
  camera.position.set(2000, 60, 0); camera.lookAt(2000, 0, 0);
  world.updateCameraVisibility(camera, new THREE.Vector3());
  assert.equal(world.streamingStats().renderedBlocks, 0, 'off-camera chunk scene roots are detached');
  camera.position.set(45, 60, 45); camera.lookAt(0, 0, 0);
  world.updateCameraVisibility(camera, new THREE.Vector3());
  assert.equal(world.streamingStats().renderedBlocks, visibleAtHome);
  assert.equal(module.pieces[sub], 0, 'destroyed voxel state survives camera hibernation');
  const stats = world.streamingStats();
  console.log(JSON.stringify({ generationAndRevisitTestMs: Math.round(performance.now() - started), ...stats, shellTriangleReduction: +(1 - initial.shellTriangles / initial.unmergedShellTriangles).toFixed(4), groundTriangleReduction: +(1 - initial.groundTriangles / initial.unmergedGroundTriangles).toFixed(4), floorTriangleReduction: +(1 - floorTriangles / floorOriginalTriangles).toFixed(4), detailTriangleReduction: +(1 - detailTriangles / detailOriginalTriangles).toFixed(4) }));
  world.dispose();
});

test('vehicle voxel collision probes stop a car at a solid scenery voxel', () => {
  const prefabProbe = { interiorObstacleAt: (x: number, _z: number, _y: number) => x > 0.7 };
  const clear = (PrefabManager.prototype.vehicleSpaceClear as unknown as Function)
    .call(prefabProbe, 0, 0, Math.PI / 2, 4, 1.8, 0) as boolean;
  assert.equal(clear, false, 'a voxel in the swept vehicle footprint blocks movement');
  prefabProbe.interiorObstacleAt = () => false;
  const open = (PrefabManager.prototype.vehicleSpaceClear as unknown as Function)
    .call(prefabProbe, 0, 0, Math.PI / 2, 4, 1.8, 0) as boolean;
  assert.equal(open, true, 'the same vehicle can pass once the obstructing voxel is removed');
});

test('a moving car dents both vehicles and pushes the struck car along the road', () => {
  const driverCar = new THREE.Group(), struckCar = new THREE.Group();
  driverCar.userData.vehicle = { length: 4, width: 2, wheelbase: 2.6, maxSpeed: 17, impact: 1 };
  struckCar.userData.vehicle = { length: 4, width: 2 };
  struckCar.position.z = 4.3;
  const parked: boolean[] = [];
  const prefabs = { vehicles: [driverCar, struckCar], setVehicleRendered() {},
    isWorldActive: () => true,
    setVehicleParked: (_car: THREE.Group, value: boolean) => { parked.push(value); return []; } } as unknown as PrefabManager;
  const grid = { groundHeight:()=>0, walkable: () => true, cellAtWorld: () => ({ active: true, tile: 'road', rubble: false }) } as unknown as GridSystem;
  const hits: THREE.Group[] = [];
  const damage = { damageVehicleImpact: (car: THREE.Group) => { hits.push(car); return 6; } } as unknown as DestructionSystem;
  const npcs = { nearby: () => [] } as unknown as NPCController;
  const driver = { group: new THREE.Group() } as LocomotionIK;
  const vehicles = new VehicleSystem(prefabs, grid, new EventBus(), npcs, damage);
  vehicles.updateTraffic(1 / 30, driver);
  const state = vehicles as unknown as { active: THREE.Group; speed: number };
  state.active = driverCar; state.speed = 10;
  vehicles.update(0.1, { forward: false, reverse: false, left: false, right: false, handbrake: false },
    driver, new THREE.Vector2(1, 0));
  assert.deepEqual(hits, [driverCar, struckCar]);
  assert.deepEqual(parked, [false], 'the struck parked car frees its previous cells');
  for (let step = 0; step < 45; step++) vehicles.updateTraffic(1 / 30, driver);
  assert.ok(struckCar.position.z > 4.4, 'the collision impulse physically displaces the other car');
  assert.equal(parked.at(-1), true, 'the displaced car blocks its new parking cells after settling');
});

test('one-way traffic keeps its lane past parked cars and accelerates away from gunfire', () => {
  const grid = new GridSystem(8402, 129), center = grid.blockAt(grid.center + 2, grid.center + 2);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) grid.activateBlock(center.bx + dx, center.bz + dz);
  const bounds = grid.blockBounds(center.bx, center.bz);
  const direction = grid.roadDirection('x', bounds.z0 + 1);
  const [roadX] = grid.world(bounds.x0 + 9, bounds.z0 + 1);
  const moving = new THREE.Group(), parked = new THREE.Group();
  moving.position.set(roadX, 0, grid.roadLane('x', bounds.z0 + 1, direction));
  parked.position.set(roadX + direction * 7, 0, grid.roadLane('x', bounds.z0 + 1, -direction));
  for (const car of [moving, parked]) {
    car.rotation.y = direction * Math.PI / 2;
    car.userData.vehicle = { length: 5.28, width: 2.42, maxSpeed: 17, impact: 1 };
    car.userData.trafficAxis = 'x'; car.userData.trafficDirection = direction;
  }
  moving.userData.autonomous = true;
  parked.userData.autonomous = false;
  grid.cellAtWorld(parked.position.x, parked.position.z)!.blocked = true;
  const prefabs = { vehicles: [moving, parked], isWorldActive: () => true, setVehicleRendered() {} } as unknown as PrefabManager;
  const events = new EventBus();
  const npcs = { nearby: () => [] } as unknown as NPCController;
  const system = new VehicleSystem(prefabs, grid, events, npcs, {} as DestructionSystem);
  const player = { group: new THREE.Group() } as LocomotionIK;
  const start = moving.position.x;
  for (let frame = 0; frame < 30; frame++) system.updateTraffic(1 / 30, player);
  const cruise = Math.abs(moving.position.x - start);
  assert.ok(cruise > 2, 'the moving car passes along its road');
  assert.ok(Math.abs(moving.position.z - parked.position.z) > 3, 'parked and moving cars occupy separate lanes');
  events.emit('gunshot', { x: moving.position.x, z: moving.position.z, radius: 25 });
  const threatenedX = moving.position.x;
  for (let frame = 0; frame < 30; frame++) system.updateTraffic(1 / 30, player);
  assert.ok(Math.abs(moving.position.x - threatenedX) > cruise * 1.35, 'the driver flees faster after hearing shots');
  assert.ok(Math.abs(moving.position.z - parked.position.z) > 3, 'the car stays in its lane while fleeing');
});

test('a frightened driver completes a turn into the correct lane', () => {
  const grid = new GridSystem(8402, 129), block = grid.blockAt(grid.center + 2, grid.center + 2);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) grid.activateBlock(block.bx + dx, block.bz + dz);
  const bounds = grid.blockBounds(block.bx, block.bz);
  const direction = grid.roadDirection('x', bounds.z0 + 1);
  const crossing = direction > 0 ? bounds.x1 : bounds.x0;
  const [crossX] = grid.world(crossing + 1, bounds.z0 + 1);
  const car = new THREE.Group();
  car.position.set(crossX - direction * (grid.cellSize * 0.8 + 1.2), 0,
    grid.roadLane('x', bounds.z0 + 1, direction));
  car.rotation.y = direction * Math.PI / 2;
  car.userData.vehicle = { length: 5.28, width: 2.42, maxSpeed: 17, impact: 1 };
  car.userData.autonomous = true;
  car.userData.trafficAxis = 'x'; car.userData.trafficDirection = direction;
  const prefabs = { vehicles: [car], isWorldActive: () => true, setVehicleRendered() {} } as unknown as PrefabManager;
  const events = new EventBus();
  const system = new VehicleSystem(prefabs, grid, events,
    { nearby: () => [] } as unknown as NPCController, {} as DestructionSystem);
  const player = { group: new THREE.Group() } as LocomotionIK;
  system.updateTraffic(1 / 30, player);
  events.emit('gunshot', { x: crossX + direction * 16, z: car.position.z, radius: 35 });
  const initialZ = car.position.z;
  for (let frame = 0; frame < 90; frame++) system.updateTraffic(1 / 30, player);
  const traffic = (system as unknown as { traffic: Map<THREE.Group, { axis: string; direction: number; turn: unknown }> }).traffic.get(car)!;
  assert.equal(traffic.axis, 'z', 'the car finishes the turn rather than freezing at the corner');
  assert.equal(traffic.turn, null);
  assert.ok(Math.abs(car.position.z - initialZ) > 2);
  assert.ok(Math.abs(car.position.x - grid.roadLane('z', crossing, traffic.direction)) < 0.1);
});

test('targeted hits knock NPCs down, repeated limb hits detach, and lost legs prevent standing', () => {
  class PathWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage() {}
    terminate() {}
  }
  Object.assign(globalThis, {
    Worker: PathWorker,
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({
      fillRect() {}, strokeRect() {}, fillText() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
      set fillStyle(_value: string) {}, set strokeStyle(_value: string) {}, set lineWidth(_value: number) {},
      set textAlign(_value: string) {}, set textBaseline(_value: string) {}, set font(_value: string) {}
    }) }) }
  });
  const scene = new THREE.Scene(), grid = new GridSystem(5), events = new EventBus();
  grid.terrain.height=()=>0; grid.groundHeight=()=>0; // isolated flat combat arena
  const prefabs = { vehicles: [], upperFloorPresent: () => false, supportHeight:()=>0, floorHeightAt:(_x:number,_z:number,l:number)=>l*FLOOR_HEIGHT, interiorObstacleAt: () => false,
    interiorWalkable: () => true, isWorldActive: () => true } as unknown as PrefabManager;
  const ragdolls = new RagdollSystem(scene, grid, prefabs);
  const player = new THREE.Group(); player.position.set(0, 0, -3);
  const controller = new NPCController(scene, grid, events, {} as DestructionSystem, player, prefabs, ragdolls);
  const bleeding: Array<{ count: number; x: number; z: number }> = [];
  events.on('blood', ({ count, x, z }) => bleeding.push({ count, x, z }));
  const makeNpc = (id: number, x: number): NPC => {
    const group = (controller as unknown as { character: (hex: string) => THREE.Group }).character('#88b8c3');
    group.position.x = x; scene.add(group);
    const home = grid.cell(grid.center, grid.center)!;
    const npc: NPC = { id, kind: 'civilian', role: 'resident', group, state: 'commute', home, work: home, target: home,
      path: [], pathIndex: 0, speed: 2, panic: 0, stamina: 4.5, loyalty: 0, leader: false, memory: 0, reroute: 10,
      alive: true, direction: 1, trespassTime: 0, warned: false, needRest: 0, hazardTime: 0, shotTimer: 0,
      pauseTime: 0, knockdownTime: 0, knockback: new THREE.Vector3(), pendingDeath: false,
      marker: new THREE.Sprite(), markerTime: 0 };
    controller.npcs.push(npc); return npc;
  };
  const roadVictim = makeNpc(99, -20);
  const initialBlood = bleeding.length;
  controller.hitByVehicle(roadVictim, 2.2, new THREE.Vector3(1, 0, 0));
  assert.ok(roadVictim.stamina < 4.5 && roadVictim.stamina > 0, 'the impact removes HP');
  assert.ok(roadVictim.hitReaction && !roadVictim.ragdoll && roadVictim.group.visible,
    'a vehicle impact uses the visible articulated fall instead of a ragdoll');
  controller.update(0.5);
  assert.ok((roadVictim.group.userData.rig as { hips: THREE.Group }).hips.position.y < 1.32,
    'the impact animates the pedestrian down to the ground');
  assert.equal(bleeding.length, initialBlood + 1, 'the collision emits visible blood');
  const armNpc = makeNpc(100, 0);
  armNpc.marker.userData.marker = true; armNpc.group.add(armNpc.marker);
  scene.updateMatrixWorld(true);
  const armRay = new THREE.Raycaster(new THREE.Vector3(-0.39, 1.49, 4), new THREE.Vector3(0, 0, -1));
  const armHit = controller.raycast(armRay);
  assert.equal(armHit?.part, 'leftUpperArm');
  const liveWrist = (armNpc.group.userData.rig as { hands: THREE.Group[] }).hands[0].getWorldPosition(new THREE.Vector3());
  controller.damage(armNpc, 1.16, 'leftUpperArm', armHit!.point);
  assert.ok(armNpc.ragdoll && !armNpc.group.visible);
  assert.equal(armNpc.stamina, 4.5 - 1.16 * 0.75, 'a limb hit hurts less than a head hit');
  const tied = armNpc.ragdoll;
  assert.equal(tied.face.userData.expression, 'scared');
  assert.ok(tied.joints[6].position.distanceTo(liveWrist) < 0.001, 'the ragdoll must begin in the live pose');
  for (const [a, b] of [[2, 3], [2, 4], [2, 7], [0, 10], [0, 13], [4, 7], [10, 13], [4, 13]])
    assert.ok(tied.constraints.some((constraint) => constraint.a === a && constraint.b === b), `joint ${a}-${b} must attach to the trunk`);
  assert.equal((armNpc.ragdoll.links.find((link) => link.part === 'leftUpperArm')?.mesh.material as THREE.MeshStandardMaterial).color.getHexString(), 'df4543');
  for (let i = 0; i < 100; i++) { ragdolls.update(1 / 60); controller.update(1 / 60); }
  for (const constraint of tied.constraints) {
    const actual = tied.joints[constraint.a].position.distanceTo(tied.joints[constraint.b].position);
    assert.ok(constraint.minimum ? actual >= constraint.length - 0.12 : Math.abs(actual - constraint.length) < 0.2,
      `ragdoll joint ${constraint.a}-${constraint.b} stretched apart`);
  }
  assert.ok(tied.joints[3].position.y < 1.6, 'the connected person should actually fall to the ground');
  for (let i = 0; i < 110; i++) { ragdolls.update(1 / 60); controller.update(1 / 60); }
  assert.ok(!armNpc.ragdoll && armNpc.group.visible, 'an NPC with both legs must get back up');
  const recoveredHead = (armNpc.group.userData.rig as { head: THREE.Group }).head.getWorldPosition(new THREE.Vector3());
  assert.ok(tied.joints[3].position.distanceTo(recoveredHead) < 0.25, 'recovery must meet the live pose before switching models');
  controller.damage(armNpc, 1.16, 'leftUpperArm', armHit!.point);
  assert.ok(armNpc.missing?.has('leftUpperArm') && armNpc.missing.has('leftForearm'));
  assert.ok(!armNpc.ragdoll?.links.some((link) => link.part === 'leftUpperArm' || link.part === 'leftForearm'));
  assert.ok(armNpc.ragdoll?.constraints.some((constraint) => constraint.a === 2 && constraint.b === 4 && constraint.part === 'torso'),
    'the shoulder remains part of the torso after its arm detaches');
  assert.ok(scene.children.some((child) => child.name === 'severed-limb' && child.children.length === 3 &&
    child.children.some((piece) => piece.name === 'severed-wound')),
    'upper and lower arm must fall together with a small visible wound cap');
  assert.ok(armNpc.woundMarks?.length === 2 && armNpc.ragdoll.woundMarks.length === 1,
    'a missing arm must leave visible stains on both live and ragdoll bodies');
  assert.ok(bleeding.some((event) => event.count >= 12), 'severing an arm must emit red particles immediately');
  assert.ok(armNpc.alive);

  for (let i = 0; i < 195; i++) { ragdolls.update(1 / 60); controller.update(1 / 60); }
  assert.ok(!armNpc.ragdoll && armNpc.group.visible && armNpc.state === 'flee',
    'a one-armed survivor gets up and walks away before bleeding out');
  assert.ok(armNpc.bleedOutTime && armNpc.bleedOutTime > 0);
  const [routeX, routeZ] = grid.grid(armNpc.group.position.x + 7, armNpc.group.position.z);
  const route = grid.index(routeX, routeZ);
  const initial = armNpc.group.position.clone();
  const moveOneStep = () => {
    armNpc.group.position.copy(initial); armNpc.velocity = new THREE.Vector3();
    armNpc.path = [route]; armNpc.pathIndex = 0;
    (controller as unknown as { move: (npc: NPC, dt: number) => void }).move(armNpc, 1 / 60);
    return armNpc.velocity!.length();
  };
  const injuredSpeed = moveOneStep();
  const missing = armNpc.missing!; armNpc.missing = undefined;
  const healthySpeed = moveOneStep(); armNpc.missing = missing;
  assert.ok(healthySpeed > 0 && injuredSpeed < healthySpeed * 0.4,
    'a one-armed NPC must move much slower than their original gait');
  for (let i = 0; i < 25; i++) { ragdolls.update(1 / 60); controller.update(1); }
  assert.ok(!armNpc.alive, 'the one-armed NPC eventually bleeds out');
  assert.ok(bleeding.some((event) => event.count === 2), 'the wound emits intermittent red particles');

  const legNpc = makeNpc(101, 5);
  controller.damage(legNpc, 0.39, 'rightShin', undefined, 2.2);
  assert.ok(legNpc.missing?.has('rightShin') && legNpc.ragdoll?.crawling);
  assert.ok(!legNpc.ragdoll?.constraints.some((constraint) => constraint.part === 'rightShin'));
  for (let i = 0; i < 240; i++) { ragdolls.update(1 / 60); controller.update(1 / 60); }
  assert.ok(legNpc.alive && legNpc.ragdoll && !legNpc.group.visible, 'a lost leg must prevent recovery');
  assert.equal(legNpc.ragdoll.life, Infinity);
  const handBefore = legNpc.ragdoll.joints[6].position.clone();
  const pelvisBefore = ragdolls.pelvis(legNpc.ragdoll).clone();
  for (let i = 0; i < 30; i++) { ragdolls.update(1 / 60); controller.update(1 / 60); }
  assert.ok(handBefore.distanceTo(legNpc.ragdoll.joints[6].position) > 0.02, 'the grounded NPC still moves an arm');
  assert.ok(pelvisBefore.distanceTo(ragdolls.pelvis(legNpc.ragdoll)) > 0.08,
    'a wounded NPC must actually crawl across the ground');
  const pelvisAfter = ragdolls.pelvis(legNpc.ragdoll);
  const handAfter = legNpc.ragdoll.joints[6].position.clone();
  assert.ok(handBefore.clone().sub(pelvisBefore).distanceTo(handAfter.sub(pelvisAfter)) > 0.06,
    'the crawl must visibly alternate its arm stroke instead of translating as a stiff body');
  controller.damage(legNpc, 0.39, 'leftShin', undefined, 2.2);
  assert.ok(legNpc.alive && legNpc.missing?.has('leftShin') && legNpc.missing.has('rightShin'),
    'a crawling NPC can lose the other leg while still alive');
  assert.ok(!legNpc.ragdoll?.constraints.some((constraint) => [12, 15].includes(constraint.a) || [12, 15].includes(constraint.b)),
    'detached feet cannot continue pulling on invisible ragdoll joints');
  const guard = makeNpc(102, 10);
  scene.remove(guard.group);
  guard.group = (controller as unknown as { character: (hex: string, heavy: boolean, armed: boolean) => THREE.Group })
    .character('#c78345', true, true);
  guard.group.position.set(10, 0, 0); scene.add(guard.group);
  guard.kind = 'enemy'; guard.role = 'guard'; guard.state = 'chase'; guard.leader = true;
  guard.stamina = 8; guard.reroute = 10; guard.shotTimer = 0;
  player.position.set(10, 0, -20);
  const shots: Array<{ fromY: number; heavy: boolean }> = [];
  events.on('enemyShot', (shot) => shots.push(shot));
  for (let i = 0; i < 80; i++) { ragdolls.update(1 / 60); controller.update(1 / 60); }
  assert.ok(shots.length > 0 && shots[0].heavy && shots[0].fromY > 1, 'rifle guard fires from its muzzle at range');
  const rig = guard.group.userData.rig as { torso: THREE.Group; mount: THREE.Group; hands: THREE.Group[] };
  assert.equal(rig.mount.parent, rig.torso);
  scene.updateMatrixWorld(true);
  for (const [side, grip] of [new THREE.Vector3(-0.15, -0.25, 0.69), new THREE.Vector3(0.16, -0.35, 0.42)].entries()) {
    const hand = rig.torso.worldToLocal(rig.hands[side].getWorldPosition(new THREE.Vector3()));
    assert.ok(hand.distanceTo(grip) < 0.14, `hand ${side} must grip rifle: ${hand.distanceTo(grip)}`);
  }
  controller.damage(guard, 0.39, 'leftForearm', undefined, 2.2);
  assert.equal(guard.state, 'surrender');
  assert.equal(rig.mount.visible, false, 'an armed NPC cannot keep shooting after losing an arm');
  const headNpc = makeNpc(103, 15);
  controller.damage(headNpc, 1.16, 'head');
  assert.equal(headNpc.alive, false, 'a direct pistol headshot must have a distinct consequence');
  assert.equal(headNpc.ragdoll?.face.userData.expression, 'dead');
  const shotgunNpc = makeNpc(105, 25);
  scene.updateMatrixWorld(true);
  const bloodBeforeHead = bleeding.length;
  controller.damage(shotgunNpc, 0.39, 'head');
  assert.ok(shotgunNpc.alive, 'one pellet alone does not exhaust normal health');
  controller.explodeHead(shotgunNpc, new THREE.Vector3(0, 0, 1));
  assert.equal(shotgunNpc.alive, false);
  assert.ok(shotgunNpc.ragdoll?.missing.has('head') && shotgunNpc.missing?.has('head'));
  assert.equal(shotgunNpc.ragdoll?.details.length, 0, 'the corpse must have no intact head');
  assert.ok(scene.children.some((child) => child.name === 'head-wound'));
  assert.equal(bleeding.length, bloodBeforeHead + 4, 'head explosion emits four red bursts');
  ragdolls.update(1 / 60);
  const blastNpc = makeNpc(104, 20);
  scene.updateMatrixWorld(true);
  const redBefore = bleeding.length;
  controller.hitByMissile(new THREE.Vector3(20, 1, 0), 4.2);
  assert.equal(blastNpc.alive, false, 'a nearby missile blast defeats the actor');
  assert.ok(blastNpc.ragdoll && !blastNpc.ragdoll.crawling);
  assert.ok(['leftUpperArm', 'rightUpperArm', 'leftThigh', 'rightThigh'].every((part) =>
    blastNpc.missing?.has(part as 'leftUpperArm')),
  'all four limbs separate in the blast');
  assert.ok(bleeding.length >= redBefore + 4, 'each lost limb emits blood particles');
  controller.dispose();
});

test('one burst of shots scares a civilian once and sends them away from the player', () => {
  class RecordingWorker {
    static paths: Array<{ goal: number; avoid?: { x: number; z: number } }> = [];
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: { type: string; goal: number; avoid?: { x: number; z: number } }): void {
      if (message.type === 'path') RecordingWorker.paths.push(message);
    }
    terminate() {}
  }
  Object.assign(globalThis, { Worker: RecordingWorker });
  RecordingWorker.paths = [];
  const scene = new THREE.Scene(), grid = new GridSystem(17), events = new EventBus();
  const player = new THREE.Group();
  const [px, pz] = grid.world(grid.center + 3, grid.center + 8);
  player.position.set(px, 0, pz);
  const prefabs = { vehicles: [], upperFloorPresent: () => false, supportHeight:()=>0, floorHeightAt:(_x:number,_z:number,l:number)=>l*FLOOR_HEIGHT, interiorObstacleAt: () => false,
    interiorWalkable: () => true, isWorldActive: () => true } as unknown as PrefabManager;
  const ragdolls = new RagdollSystem(scene, grid, prefabs);
  const controller = new NPCController(scene, grid, events, {} as DestructionSystem, player, prefabs, ragdolls);
  const block = grid.blockAt(grid.center + 8, grid.center + 8);
  grid.activateBlock(block.bx, block.bz);
  const home = grid.cell(grid.center + 8, grid.center + 8)!;
  const [nx, nz] = grid.world(home.x, home.z);
  const group = (controller as unknown as { character: (hex: string) => THREE.Group }).character('#88b8c3');
  group.position.set(nx, 0, nz);
  const npc: NPC = { id: 912, kind: 'civilian', role: 'resident', group, state: 'commute', home, work: home, target: home,
    path: [], pathIndex: 0, speed: 2, panic: 0, stamina: 4.5, loyalty: 0, leader: false, memory: 0, reroute: 0,
    alive: true, direction: 1, trespassTime: 0, warned: false, needRest: 0, hazardTime: 0, shotTimer: 0,
    pauseTime: 0, knockdownTime: 0, knockback: new THREE.Vector3(), pendingDeath: false,
    marker: new THREE.Sprite(), markerTime: 0 };
  controller.npcs.push(npc);
  events.emit('gunshot', { x: px, z: pz, radius: 19 });
  assert.equal(npc.state, 'flee');
  assert.ok(npc.target.x > home.x, 'the escape destination is on the side away from the player');
  assert.deepEqual(RecordingWorker.paths[0].avoid, { x: grid.center + 3, z: grid.center + 8, radius: 12 });
  npc.fearTime = 0.25; npc.markerTime = 0.5;
  for (let shot = 0; shot < 8; shot++) events.emit('gunshot', { x: px, z: pz, radius: 19 });
  assert.equal(npc.fearTime, 0.25, 'later shots in the same panic episode do not restart the fear pose');
  assert.equal(npc.markerTime, 0.5);
  assert.equal(RecordingWorker.paths.length, 1, 'the escape route remains stable during a burst');
  npc.state = 'commute'; npc.panic = 0.1;
  events.emit('gunshot', { x: px, z: pz, radius: 19 });
  assert.equal(RecordingWorker.paths.length, 2, 'a new episode can trigger after calming down');
  const neighborCell = grid.cell(home.x + 1, home.z)!;
  const [otherX, otherZ] = grid.world(neighborCell.x, neighborCell.z);
  const neighborGroup = (controller as unknown as { character: (hex: string) => THREE.Group }).character('#e7aa85');
  neighborGroup.position.set(otherX, 0, otherZ);
  const neighbor: NPC = { ...npc, id: 913, group: neighborGroup, home: neighborCell, work: neighborCell,
    target: neighborCell, state: 'commute', panic: 0, path: [], pathIndex: 0, reroute: 10,
    marker: new THREE.Sprite(), markerTime: 0, fearTime: 0, fleeSource: undefined, fleeFromPlayer: false,
    socialExposure: 0, knockback: new THREE.Vector3() };
  controller.npcs.push(neighbor);
  for (let step = 0; step < 5; step++) controller.update(0.1);
  assert.equal(neighbor.state, 'flee', 'a nearby calm pedestrian learns about the threat');
  assert.ok(neighbor.fearTime! > 0 && neighbor.markerTime > 0, 'the social reaction is visible');
  assert.ok(neighbor.target.x > neighborCell.x, 'the informed pedestrian also escapes away from the player');
  for (let step = 0; step < 60; step++) controller.update(0.5);
  assert.ok(npc.panic >= 0.46 && neighbor.panic >= 0.46, 'both remain panicked while the player stays nearby');
  assert.equal(npc.state, 'flee');
  player.position.set(200, 0, 200);
  for (let step = 0; step < 70; step++) controller.update(0.5);
  assert.equal(npc.state, 'commute', 'civilians eventually recover once the player leaves');
  player.position.set(nx - 4, 0, nz);
  assert.equal(controller.intimidate(npc, player.position), true);
  assert.equal(npc.state, 'flee', 'aiming a weapon makes a calm pedestrian flee');
  assert.ok(npc.panic >= 0.72 && npc.markerTime > 0);
  controller.update(0.3);
  const fearRemaining = npc.fearTime || 0;
  assert.equal(controller.intimidate(npc, player.position), false, 'continued aim does not restart the fright animation');
  assert.ok((npc.fearTime || 0) <= fearRemaining);
  controller.dispose();
});

test('crawling bodies stop before furniture, walls and vehicle footprints', () => {
  const scene = new THREE.Scene(), grid = new GridSystem(5);
  const vehicle = new THREE.Group(); vehicle.position.set(2.5, 0, 8);
  vehicle.userData.vehicle = { length: 2, width: 1.5 };
  const prefabs = { vehicles: [vehicle], upperFloorPresent: () => false, supportHeight:()=>0, floorHeightAt:(_x:number,_z:number,l:number)=>l*FLOOR_HEIGHT,
    interiorWalkable: () => true, interiorObstacleAt: (x: number, z: number) => x > 2 && x < 3 && Math.abs(z) < 4 } as unknown as PrefabManager;
  const system = new RagdollSystem(scene, grid, prefabs);
  Object.assign(system, { crawlMotion: JSON.parse(readFileSync('public/animations/mixamo/crawl-motion.json','utf8')) });
  const colors = { shirt: '#557788', pants: '#334455', skin: '#ddb997', shoes: '#223344' };
  const makeCrawler = (z: number) => {
    const body = system.spawn(new THREE.Vector3(0, 0, z), 0, new THREE.Vector3(), colors,
      0, 1, 20, new Set(['rightShin']));
    body.crawling = true;
    system.setCrawlDirection(body, new THREE.Vector3(1, 0, 0));
    return body;
  };
  const byWall = makeCrawler(0), byVehicle = makeCrawler(8);
  for (let i = 0; i < 360; i++) system.update(1 / 60);
  assert.ok(system.pelvis(byWall).x < 1.25, 'head and arms must stop before the wall rather than letting the pelvis clip through');
  assert.ok(system.pelvis(byVehicle).x < 1.25, 'a car footprint must block the full crawling silhouette');
  const wristBefore = byWall.joints[6].position.y;
  for (let i = 0; i < 18; i++) system.update(1 / 60);
  assert.notEqual(byWall.joints[6].position.y, wristBefore,
    'a crawler keeps reaching and pulling even when an obstacle prevents forward movement');
  system.remove(byWall); system.remove(byVehicle);
});

test('shotgun limb hit severs in one impact and both bullet directions emit bounded red voxels', () => {
  const scene = new THREE.Scene(), inventory = new InventorySystem();
  inventory.weapon = 'shotgun';
  const player = { group: new THREE.Group(), aimAt() {}, animateFire() {} } as unknown as LocomotionIK;
  const npc = { kind: 'enemy', group: new THREE.Group() } as NPC;
  const damageCalls: Array<{ amount: number; part: string; trauma: number }> = [];
  const explodedHeads: NPC[] = [];
  const npcs = { raycast: () => ({ npc, point: new THREE.Vector3(-0.39, 1.48, 4), distance: 4,
    part: 'torso' }),
    damage: (_npc: NPC, amount: number, part: string, _point: THREE.Vector3, trauma: number) => {
      damageCalls.push({ amount, part, trauma }); return false;
    }, explodeHead: (victim: NPC) => explodedHeads.push(victim) } as unknown as NPCController;
  const prefabs = { supportHeight:()=>0, buildings: new THREE.Group(), interiorMeshesNear: () => [] } as unknown as PrefabManager;
  const combat = new CombatSystem(scene, player, inventory, npcs, {} as DestructionSystem, prefabs, new EventBus());
  const aimedPart = { npc, part: 'leftUpperArm' as const, point: new THREE.Vector3(-0.39, 1.48, 4) };
  combat.fire(aimedPart.point, true, false, true, aimedPart);
  assert.equal(combat.activeBulletCount, 7, 'each pellet launches a visible traveling particle');
  assert.equal(damageCalls.length, 1, 'one shell applies one resolved wound after tracing all pellets');
  assert.equal(damageCalls[0].part, 'leftUpperArm', 'the selected joint survives muzzle parallax');
  assert.equal(damageCalls[0].trauma, 2.2);
  assert.ok(Math.abs(damageCalls[0].amount - 2.73) < 0.001);
  assert.ok(combat.blood.activeCount > 0);
  const npcParticles = combat.blood.activeCount;
  combat.enemyTracer(new THREE.Vector3(0, 1.5, -4), new THREE.Vector3(0, 1.4, 0), true, true);
  assert.ok(combat.blood.activeCount > npcParticles, 'enemy bullet hit emits red particles on the player');
  for (let i = 0; i < 80; i++) combat.update(1 / 60);
  assert.equal(combat.blood.activeCount, 0);
  assert.equal(combat.activeBulletCount, 0, 'bullet particles expire after travel');
  combat.fire(new THREE.Vector3(-0.39, 2.1, 4), true, false, true,
    { npc, part: 'head', point: new THREE.Vector3(-0.39, 2.1, 4) });
  assert.deepEqual(explodedHeads, [npc], 'only an aimed shotgun headshot triggers the head explosion');
});

test('missile keeps flying beyond the old range and explodes on physical ground contact', () => {
  const scene = new THREE.Scene(), inventory = new InventorySystem();
  inventory.weapon = 'charge';
  const player = { group: new THREE.Group(), aimAt() {}, animateFire() {} } as unknown as LocomotionIK;
  const victims: THREE.Vector3[] = [], craters: THREE.Vector3[] = [];
  const npcs = { raycast: () => null, hitByMissile: (point: THREE.Vector3) => victims.push(point.clone()) } as unknown as NPCController;
  const prefabs = { supportHeight:()=>0, buildings: new THREE.Group(), interiorMeshesNear: () => [] } as unknown as PrefabManager;
  const destruction = { fireAnchors: () => [], blast: (x: number, z: number, _radius: number, _source: string, y: number) => {
    craters.push(new THREE.Vector3(x, y, z)); return 0;
  } } as unknown as DestructionSystem;
  const combat = new CombatSystem(scene, player, inventory, npcs, destruction, prefabs, new EventBus());
  assert.equal(combat.fire(new THREE.Vector3(0, 0, 70)), 'MISIL LANZADO');
  const projectile = scene.getObjectByName('demolition-missile') as THREE.Group;
  const projectileLight = projectile.children.find((child) => child instanceof THREE.PointLight) as THREE.PointLight;
  assert.ok(projectileLight?.intensity > 20, 'the missile exhaust lights nearby surfaces while flying');
  assert.equal(craters.length, 0, 'the charge is a traveling projectile');
  for (let i = 0; i < 80; i++) combat.update(1 / 60);
  assert.equal(craters.length, 0, 'the old 28-unit cutoff no longer detonates the missile');
  for (let i = 0; i < 80 && craters.length === 0; i++) combat.update(1 / 60);
  assert.equal(craters.length, 1);
  assert.ok(scene.children.some((child) => child instanceof THREE.PointLight && child.intensity >= 70),
    'the impact produces a visible light burst');
  assert.equal(victims.length, 1);
  assert.ok(craters[0].distanceTo(player.group.position.clone().add(new THREE.Vector3(0, 1.78, 0))) > 60,
    'the missile reaches the distant aimed ground');
  assert.ok(scene.children.some((child) => child.name === 'missile-fire-particles'));
  combat.update(0.6);
  assert.ok(!scene.children.some((child) => child instanceof THREE.PointLight),
    'temporary explosion lights are removed after the flash');
});

test('terrain contact matches rendered triangles and cutouts leave no gaps around plazas', () => {
  const grid=new GridSystem(919809),size=grid.cellSize;
  const origin=-size/2;
  const result=meshTerrainSurface(5,5,new Float32Array(25),size,origin,origin,
    (x,z)=>grid.terrain.height(x,z),()=>false);
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(result.positions,3));geometry.setIndex(new THREE.BufferAttribute(result.indexes,1));
  const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
  for(let x=0;x<8;x+=.37)for(let z=0;z<8;z+=.51) {
    const hit=new THREE.Raycaster(new THREE.Vector3(x,50,z),new THREE.Vector3(0,-1,0)).intersectObject(mesh)[0];
    assert.ok(hit);assert.ok(Math.abs(hit.point.y-grid.terrain.height(x,z))<1e-5);
  }
  const clipped=meshTerrainSurface(2,2,new Float32Array(4),size,0,0,()=>0,()=>false,[{x0:.7,x1:3.1,z0:1.3,z1:4.4}]);
  let area=0;const p=clipped.positions,ids=clipped.indexes;
  for(let i=0;i<ids.length;i+=3){const a=ids[i]*3,b=ids[i+1]*3,c=ids[i+2]*3;
    area+=Math.abs((p[b]-p[a])*(p[c+2]-p[a+2])-(p[b+2]-p[a+2])*(p[c]-p[a]))/2;}
  assert.ok(Math.abs(area-(4.4*4.4-2.4*3.1))<1e-5,'cutout removes its exact area, not whole adjacent grid cells');
});

test('a falling controller obeys gravity and four wheel suspension settles on slopes', () => {
  const contact=new GroundPhysics();let y=5;
  y=contact.step(y,0,1/60);assert.ok(y<5&&y>4.98,'falling is integrated, never teleported');
  for(let frame=0;frame<120;frame++)y=contact.step(y,0,1/60);
  assert.equal(y,0);assert.equal(contact.grounded,true);
  assert.equal(contact.jump(8.2),true,'grounded contact accepts a real vertical impulse');
  y=contact.step(y,0,1/60);
  assert.ok(y>0.1 && contact.verticalSpeed>0,'the jump raises the actual actor position');
  for(let frame=0;frame<120;frame++)y=contact.step(y,0,1/60);
  assert.equal(y,0,'gravity returns the actor to the contact surface');
  const car=new THREE.Group();car.userData.vehicle={width:2,length:4,wheelbase:2.8};
  for(let frame=0;frame<300;frame++)stepVehicleSuspension(car,1/60,(x,z)=>x*.08+z*.14);
  assert.ok(Math.abs(car.rotation.x+Math.atan(.14))<.025,'front wheels follow uphill contact');
  assert.ok(Math.abs(car.rotation.z-Math.atan(.08))<.025,'track follows cross slope');
  const y0=car.position.y;
  for(let frame=0;frame<120;frame++)stepVehicleSuspension(car,1/60,(x,z)=>x*.08+z*.14);
  assert.ok(Math.abs(y0-car.position.y)<.001,'damped suspension stays settled');
  const started=performance.now();
  for(let frame=0;frame<600;frame++)for(let vehicle=0;vehicle<30;vehicle++)stepVehicleSuspension(car,1/60,(x,z)=>x*.08+z*.14);
  console.log(JSON.stringify({suspension30VehiclesMsPerFrame:(performance.now()-started)/600}));
});

test('surface layers preserve the lower promenade and pathfinding does not teleport onto a bridge', () => {
  const surfaces=new SurfaceNetwork(2.2);
  surfaces.add({id:'lower',kind:'promenade',x0:0,x1:4,z0:0,z1:10,height:-3.52});
  assert.equal(surfaces.below(1,2,-2,0),-3.52);
  assert.equal(surfaces.below(1,2,1,0),0);
  const finder=new SparsePathfinder(5),area=25;
  const indexes=[5,6,7,8,9,5+area,6+area,7+area,8+area,9+area];
  finder.update(Uint32Array.from(indexes),new Uint8Array(10),undefined,Float32Array.from([0,0,0,0,0,-3.52,-3.52,-3.52,-3.52,-3.52]));
  assert.deepEqual(finder.find(5+area,9+area),[30,31,32,33,34]);
  assert.deepEqual(finder.find(5+area,9),[],'no direct transition through a 3.52m solid bridge deck');
});

test('landscape access paths stay clear, canal bridges have human clearance and nature has distinct species', () => {
  const grid=new GridSystem(919809),scene=new THREE.Scene(),world=new PrefabManager(scene,grid);
  const center=grid.blockAt(grid.center,grid.center);
  world.ensureAround(grid.terrain.canalColumn,center.bz,1,Infinity);drain(world);scene.updateMatrixWorld(true);
  const surfaces=[...grid.surfaces.surfaces.values()];
  console.log(JSON.stringify({urbanSurfaces:surfaces.reduce((counts,s)=>{counts[s.kind]=(counts[s.kind]??0)+1;return counts;},{} as Record<string,number>)}));
  assert.ok(surfaces.some(s=>s.kind==='plaza'));
  assert.ok(surfaces.some(s=>s.kind==='promenade'));
  for(const surface of surfaces.filter(s=>s.kind==='ramp'||s.kind==='stairs')) {
    const treads=world.interiorPieces.filter(p=>p.mesh.userData.walkSurfaceIds?.includes(surface.id)&&p.alive);
    const expected=Math.round(Math.abs((surface.endHeight??surface.height)-surface.height)/S);
    assert.equal(treads.length,expected,`${surface.id} has one destructible voxel tread per height step`);
    assert.ok(treads.every(p=>p.mesh.userData.voxelDimensions?.voxelSize===S),`${surface.id} has no smooth ramp wedge`);
    for(let t=.04;t<1;t+=.06) {
      const x=surface.axis==='x'?surface.x0+(surface.x1-surface.x0)*t:(surface.x0+surface.x1)/2;
      const z=surface.axis==='z'?surface.z0+(surface.z1-surface.z0)*t:(surface.z0+surface.z1)/2;
      const y=grid.surfaces.height(surface,x,z);
      const probe=new THREE.Raycaster(new THREE.Vector3(x,y+.01,z),new THREE.Vector3(0,-1,0),0,.02);
      assert.ok(Number.isFinite(y)&&probe.intersectObjects(treads.map(p=>p.mesh),false).length>0,
      `${surface.id} walking height matches its voxel top at ${t}`);
      assert.equal(world.interiorObstacleAt(x,z,y),false,`blocked landscape access ${surface.id} at ${t}`);
    }
  }
  assert.ok(scene.getObjectByName('voxel-earth-foundation')?.userData.voxelDimensions?.voxelSize===S,
    'raised and lowered terrain uses voxel foundations');
  assert.ok(scene.getObjectByName('canal-water')?.userData.voxelDimensions?.voxelSize===S,
    'lowered canal water follows the same voxel lattice');
  const canalAccesses=surfaces.filter(s=>s.id.startsWith('riverwalk:')&&s.id.endsWith(':access'));
  for(const access of canalAccesses) {
    const outerX=access.x0<grid.terrain.canalBounds().x0?access.x0:access.x1;
    const z=(access.z0+access.z1)/2;
    const wall=world.interiorPieces.find(p=>p.alive&&p.mesh.name==='canal-access-retaining-wall'&&
      Math.abs((outerX===access.x0?p.bounds.min.x:p.bounds.max.x)-outerX)<.01&&
      p.bounds.min.z<=z&&p.bounds.max.z>=z);
    assert.ok(wall,`${access.id} has a voxel wall sealing its exterior edge`);
    assert.ok(wall.bounds.max.y>=-.01&&wall.bounds.min.y<=-3.95,
      `${access.id} side reaches from street level to the canal floor`);
    assert.equal(world.interiorObstacleAt((wall.bounds.min.x+wall.bounds.max.x)/2,z,-2),true,
      `${access.id} outside edge has no open gap through the terrain`);
    const end=access.z1+2.2;
    const corner=world.interiorPieces.find(p=>p.alive&&p.mesh.name==='canal-access-corner-return'&&
      Math.abs(p.bounds.max.z-end)<.01&&
      p.bounds.min.x<=outerX+1.1&&p.bounds.max.x>=outerX-1.1);
    assert.ok(corner,`${access.id} landing corner closes against the canal bank`);
  }
  const flow=scene.getObjectByName('canal-flow') as THREE.InstancedMesh;
  assert.ok(flow?.count>10,'voxel highlights represent the moving current');
  const beforeFlow=new THREE.Matrix4(),afterFlow=new THREE.Matrix4();
  flow.getMatrixAt(0,beforeFlow);world.updateWater(.5);flow.getMatrixAt(0,afterFlow);
  assert.notDeepEqual(afterFlow.elements,beforeFlow.elements,'the voxel current moves each frame');
  const promenade=surfaces.find(s=>s.kind==='promenade'&&!s.solid)!;
  const x=(promenade.x0+promenade.x1)/2,z=promenade.z0+3.3;
  assert.ok(grid.terrain.height(x,z)-promenade.height>=3.3);
  assert.equal(world.supportHeight(x,z,promenade.height+1),promenade.height);
  const walker=new LocomotionIK(grid,scene,(x,z)=>world.interiorWalkable(x,z),
    (x,z,y)=>world.stairSurface(x,z,y),(x,z,y)=>world.interiorObstacleAt(x,z,y),
    (x,z,l)=>world.upperFloorPresent(x,z,l),(x,z,l)=>world.floorHeightAt(x,z,l));
  walker.group.position.set(x,promenade.height,promenade.z0+10);
  for(let frame=0;frame<240;frame++)walker.update(1/120,new THREE.Vector2(0,-.5),[],false);
  assert.ok(walker.group.position.z<promenade.z0+4,'walk through the road bridge underneath');
  assert.ok(Math.abs(walker.group.position.y-promenade.height)<.05,'never snap onto the road overhead');
  const channel=grid.terrain.canalBounds(),waterX=(channel.x0+channel.x1)/2;
  const banks:THREE.Object3D[]=[];scene.traverse(o=>{if(o.name==='voxel-terrain-cutout-bank')banks.push(o);});
  const underBridge=new THREE.Raycaster(new THREE.Vector3(waterX,-2,promenade.z0+grid.cellSize*3+2),new THREE.Vector3(0,0,-1),0,8);
  assert.equal(underBridge.intersectObjects(banks,false).length,0,'earth banks leave the water passage beneath the road bridge open');
  const waterZ=promenade.z0+grid.cellSize*4;
  assert.equal(grid.water.at(waterX,waterZ),true);
  assert.equal(grid.groundHeight(waterX,waterZ),CANAL_BED_Y,'canal water has a physical floor below its visible surface');
  const current=new THREE.Vector3();
  assert.equal(grid.water.currentAt(waterX,CANAL_SURFACE_Y,waterZ,current),true);
  assert.ok(current.z>1,'the channel has a consistent downstream current');
  const underRoad=promenade.z0+grid.cellSize;
  assert.equal(grid.groundHeight(waterX,underRoad),0,'the road bridge keeps its upper driving surface');
  assert.equal(grid.water.currentAt(waterX,CANAL_BED_Y,underRoad,current),true,
    'the same stream continues below the road bridge');
  assert.equal(world.supportHeight(waterX,underRoad,CANAL_BED_Y+.2),CANAL_BED_Y,
    'a body carried beneath the bridge remains on the canal floor');
  const jumper=new LocomotionIK(grid,scene,(x,z)=>world.interiorWalkable(x,z),
    (x,z,y)=>world.stairSurface(x,z,y),(x,z,y)=>world.interiorObstacleAt(x,z,y),
    (x,z,l)=>world.upperFloorPresent(x,z,l),(x,z,l)=>world.floorHeightAt(x,z,l));
  const bridgeEnd=promenade.z0+grid.cellSize*3;
  jumper.group.position.set(waterX,0,bridgeEnd-2.2);
  for(let frame=0;frame<20;frame++)jumper.update(1/60,new THREE.Vector2(),[],false);
  assert.equal(jumper.jump(),true,'the player can jump from the canal road bridge');
  for(let frame=0;frame<180;frame++)jumper.update(1/60,new THREE.Vector2(0,1),[],false);
  assert.ok(jumper.group.position.z>bridgeEnd+2&&jumper.group.position.y<CANAL_SURFACE_Y,
    'jumping past the bridge edge falls into flowing water');
  const beforeSwim=jumper.group.position.clone();
  for(let frame=0;frame<90;frame++)jumper.update(1/60,new THREE.Vector2(0,1),[],false);
  assert.ok(jumper.group.position.z>beforeSwim.z+1,'the player keeps moving in water instead of being blocked by its unwalkable grid');
  const bodyPhysics=new RagdollSystem(scene,grid,world);
  const floating=bodyPhysics.spawn(new THREE.Vector3(waterX,CANAL_BED_Y,waterZ),0,new THREE.Vector3(),
    {shirt:'#37a8a0',pants:'#394f60',skin:'#e9c49d',shoes:'#263b47'});
  bodyPhysics.detach(floating,'leftForearm',new THREE.Vector3());
  const loose=scene.getObjectByName('severed-limb')!;
  const bodyZ=bodyPhysics.pelvis(floating).z,looseZ=loose.position.z;
  for(let frame=0;frame<90;frame++)bodyPhysics.update(1/60);
  assert.ok(bodyPhysics.pelvis(floating).z>bodyZ+.4,'the current carries a fallen body');
  assert.ok(loose.position.z>looseZ+.3,`detached limbs float downstream: moved ${loose.position.z-looseZ}, height ${loose.position.y}`);
  const blood=new BloodParticles(scene,(x,z,y)=>world.supportHeight(x,z,y),grid.water);
  blood.emit(new THREE.Vector3(waterX,CANAL_SURFACE_Y+.08,waterZ),new THREE.Vector3(0,0,0),1,CANAL_BED_Y);
  const drop=(blood as unknown as {particles:Array<{position:THREE.Vector3;velocity:THREE.Vector3}>}).particles[0];
  drop.velocity.set(0,0,0);
  for(let frame=0;frame<18;frame++)blood.update(1/60);
  assert.ok(drop.position.z>waterZ+.04&&drop.position.y>=CANAL_SURFACE_Y,
    'blood floats on the water and follows the same current');
  const debrisSystem=new DestructionSystem(scene,grid,world,new EventBus());
  const debrisProbe=debrisSystem as unknown as {spawnDebris:(point:THREE.Vector3,color:THREE.Color)=>void;
    debris:Array<{position:THREE.Vector3;velocity:THREE.Vector3}>};
  debrisProbe.spawnDebris(new THREE.Vector3(waterX,CANAL_SURFACE_Y+.1,waterZ),new THREE.Color('#c3b89c'));
  debrisProbe.debris[0].velocity.set(0,0,0);
  for(let frame=0;frame<30;frame++)debrisSystem.update(1/60,new THREE.PerspectiveCamera());
  assert.ok(debrisProbe.debris[0].position.z>waterZ+.08,'light debris drifts with the current');
  assert.ok(surfaces.filter(s=>s.kind==='bridge').length>0);
  const roofBridge=surfaces.find(s=>s.kind==='bridge')!;
  const roofJumper=new LocomotionIK(grid,scene,(x,z)=>world.interiorWalkable(x,z),
    (x,z,y)=>world.stairSurface(x,z,y),(x,z,y)=>world.interiorObstacleAt(x,z,y),
    (x,z,l)=>world.upperFloorPresent(x,z,l),(x,z,l)=>world.floorHeightAt(x,z,l));
  roofJumper.group.position.set((roofBridge.x0+roofBridge.x1)/2,roofBridge.height,(roofBridge.z0+roofBridge.z1)/2);
  for(let frame=0;frame<20;frame++)roofJumper.update(1/60,new THREE.Vector2(),[],false);
  assert.equal(roofJumper.jump(),true);
  for(let frame=0;frame<140;frame++)roofJumper.update(1/60,new THREE.Vector2(0,1),[],false);
  assert.ok(roofJumper.group.position.y<roofBridge.height-1,
    'jumping over a skybridge rail leads to a real fall');
  for(const bridge of surfaces.filter(s=>s.kind==='bridge'))for(let t=.02;t<1;t+=.08) {
    const bx=bridge.x0+(bridge.x1-bridge.x0)*t,bz=(bridge.z0+bridge.z1)/2;
    assert.equal(world.interiorObstacleAt(bx,bz,bridge.height),false,'bridge deck and parapet openings stay clear');
  }
  const bridge=surfaces.find(s=>s.kind==='bridge')!;
  const deck=world.interiorPieces.find(p=>p.mesh.userData.walkSurfaceIds?.includes(bridge.id))!;
  const bx=(bridge.x0+bridge.x1)/2,bz=(bridge.z0+bridge.z1)/2;
  assert.ok(grid.surfaces.reachable(bx,bz,bridge.height));
  world.eraseSceneVoxels(deck,Array.from(deck.mask.keys()));
  assert.equal(grid.surfaces.reachable(bx,bz,bridge.height),null,'destroyed bridge leaves no invisible support');
  const plaza=surfaces.find(s=>s.kind==='plaza')!;
  const plazaDeck=world.interiorPieces.find(p=>p.mesh.userData.walkSurfaceIds?.includes(plaza.id))!;
  const px=(plaza.x0+plaza.x1)/2,pz=(plaza.z0+plaza.z1)/2;
  world.eraseSceneVoxels(plazaDeck,Array.from(plazaDeck.mask.keys()));
  assert.ok(grid.groundHeight(px,pz)<plaza.height-.2,'broken plaza paving reveals the earth beneath');
  const profiles=new Set(Array.from({length:6},(_,seed)=>{
    const tree=natureTree(seed);return tree.children.map(o=>`${o.position.toArray()}:${(o as THREE.Mesh).geometry.uuid}:${((o as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex()}`).join('|');
  }));assert.equal(profiles.size,6);
  world.dispose();
});

test('seed 828507 has level roads and the player traverses entrances, stairs, ramps and roof bridges', () => {
  Object.assign(globalThis,{Worker:MeshWorker});
  const grid=new GridSystem(828507),scene=new THREE.Scene(),world=new PrefabManager(scene,grid);
  drain(world);scene.updateMatrixWorld(true);
  const walker=new LocomotionIK(grid,scene,(x,z)=>world.interiorWalkable(x,z),
    (x,z,y)=>world.stairSurface(x,z,y),(x,z,y)=>world.interiorObstacleAt(x,z,y),
    (x,z,l)=>world.upperFloorPresent(x,z,l),(x,z,l)=>world.floorHeightAt(x,z,l));
  const walkTo=(x:number,z:number,label:string)=>{
    for(let i=0;i<1400;i++) {
      const delta=new THREE.Vector2(x-walker.group.position.x,z-walker.group.position.z);
      if(delta.length()<.045){walker.velocity.set(0,0,0);return;}
      walker.update(1/60,delta.clampLength(0,.6),[],false);
    }
    assert.fail(`${label}: stuck at ${walker.group.position.toArray()} toward ${x},${z}`);
  };
  const place=(x:number,y:number,z:number)=>{walker.group.position.set(x,y,z);walker.velocity.set(0,0,0);};
  for(const cell of grid.activeCells.filter(c=>c.tile==='road')) {
    const [x,z]=grid.world(cell.x,cell.z);
    const corners=[[-1,-1],[-1,1],[1,-1],[1,1]].map(([dx,dz])=>grid.terrain.height(x+dx*1.1,z+dz*1.1));
    assert.ok(Math.max(...corners)-Math.min(...corners)<1e-6,'no road crossfall or tilted intersection');
  }
  const b=grid.blockAt(grid.center,grid.center),bounds=grid.blockBounds(b.bx,b.bz);
  const [rx,rz]=grid.world(bounds.x0+1,bounds.z0+1),[endX,endZ]=grid.world(bounds.x1-1,bounds.z1-1);
  place(rx,0,rz);walkTo(endX,rz,'street east');walkTo(rx,rz,'street west');walkTo(rx,endZ,'street south');
  for(const key of grid.activeBlocks) {
    const [bx,bz]=key.split(':').map(Number),block=grid.blockBounds(bx,bz);
    for(const plan of planBlock(grid,block,grid.blockProfile(bx,bz).district)) {
      const [x,z]=grid.world(plan.x+Math.floor(plan.width/2),frontageZ(plan)),direction=frontageDirection(plan);
      place(x,0,z+direction*2.1);
      walkTo(x,z-direction*.6,`${plan.type} entrance`);
      walkTo(x,z+direction*2.1,`${plan.type} exit`);
    }
  }
  let rampsWalked=0,bridgesWalked=0;
  const stairs=world.staircases.find(s=>s.maxLevel>=2)!;
  assert.ok(stairs);
  assert.equal(stairs.steps[0][0],null,'the ground-floor slab is the first stair step, without a coplanar tread');
  const firstStep=world.stairSurface(stairs.centerX-stairs.laneOffset,stairs.startZ-.02,stairs.position.y);
  assert.ok(firstStep && Math.abs(firstStep.height-(stairs.position.y+CITY_VOXEL_SIZE/2))<.001,
    'the surviving floor still supports entry to the stair flight');
  place(stairs.centerX-stairs.laneOffset,stairs.position.y,stairs.startZ+.25);
  walkTo(stairs.centerX-stairs.laneOffset,stairs.endZ-.23,'first stair flight');
  assert.equal(walker.floorLevel,1);
  walkTo(stairs.centerX+stairs.laneOffset,stairs.endZ-.23,'landing');
  walkTo(stairs.centerX+stairs.laneOffset,stairs.startZ+.23,'second flight');
  assert.equal(walker.floorLevel,2);
  walkTo(stairs.centerX+stairs.laneOffset,stairs.endZ-.23,'second flight descending');
  walkTo(stairs.centerX-stairs.laneOffset,stairs.endZ-.23,'landing descending');
  walkTo(stairs.centerX-stairs.laneOffset,stairs.startZ+.25,'first flight descending');
  assert.equal(walker.floorLevel,0);
  for(const surface of grid.surfaces.surfaces.values()) {
    if(surface.kind==='ramp'||surface.kind==='stairs') {
      rampsWalked++;
      const [x0,z0]=surface.axis==='x'?[surface.x0+.02,(surface.z0+surface.z1)/2]:[(surface.x0+surface.x1)/2,surface.z0+.02];
      const [x1,z1]=surface.axis==='x'?[surface.x1-.02,z0]:[x0,surface.z1-.02];
      place(x0,grid.surfaces.height(surface,x0,z0),z0);
      walkTo(x1,z1,surface.id);walkTo(x0,z0,surface.id+' reverse');
    }
    if(surface.kind==='bridge') {
      bridgesWalked++;
      const z=(surface.z0+surface.z1)/2;
      place(surface.x0-.35,surface.height,z);
      walkTo(surface.x1+.35,z,'roof bridge exit');
      assert.ok(Math.abs(walker.group.position.y-surface.height)<.05,'stay on the destination roof');
      walkTo(surface.x0-.35,z,'roof bridge return');
    }
  }
  assert.ok(rampsWalked>0&&bridgesWalked>0,'test city includes both ramps and roof bridges');
  const middleZ=(stairs.startZ+stairs.endZ)/2;
  assert.equal(world.stairSurface(stairs.centerX-stairs.laneOffset,middleZ,stairs.position.y),null,'upper steps cannot capture a player standing beneath them');
  place(stairs.centerX-stairs.laneOffset,stairs.position.y,middleZ);
  walker.update(1/60,new THREE.Vector2(),[],false);
  assert.ok(Math.abs(walker.group.position.y-stairs.position.y)<.05,'no jump to a staircase above the player');
  world.dispose();
});

test('intact paving hides its buried support and movement cannot skip a thin wall at low FPS', () => {
  const grid=new GridSystem(828507),surface={x0:0,x1:4,z0:0,z1:4};
  grid.surfaces.add({...surface,id:'soil',kind:'promenade',height:-.44,navigable:false});
  grid.surfaces.add({...surface,id:'paving',kind:'plaza',height:0});
  assert.equal(grid.surfaces.reachable(1,1,-.3)?.surface.id,'paving');
  grid.walkable=()=>true;
  const walker=new LocomotionIK(grid,new THREE.Scene(),undefined,undefined,x=>x>=1&&x<=1.44);
  walker.group.position.set(.85,0,6);walker.velocity.set(11.5,0,0);
  walker.update(.1,new THREE.Vector2(1,0),[],true);
  assert.ok(walker.group.position.x<1,'swept movement stops before the wall');
});

test('downloaded Crawling clip is baked into moving joint targets for the physical wounded body', async () => {
  const { bakeCrawlMotion, sampleJointMotion } = await import('../src/actors/JointAnimation');
  const bytes=readFileSync('public/animations/mixamo/crawl.fbx');
  const rig=new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,'');
  const baked=bakeCrawlMotion(rig,rig.animations[0]);
  const shipped=JSON.parse(readFileSync('public/animations/mixamo/crawl-motion.json','utf8'));
  assert.equal(shipped.source,'Mixamo/Crawling.fbx');
  assert.equal(shipped.frames.length,baked.frames.length);
  assert.deepEqual(shipped.frames[8],JSON.parse(JSON.stringify(baked.frames[8])), 'the runtime table is produced from the downloaded FBX, not a hand-authored pose');
  const first=sampleJointMotion(baked,0,6,new THREE.Vector3());
  const later=sampleJointMotion(baked,.6,6,new THREE.Vector3());
  assert.ok(first.distanceTo(later)>.1,'the hand actually reaches through the crawl cycle');
  assert.ok(shipped.frames.every((frame:number[])=>frame.length===48&&frame.every(Number.isFinite)));
});

test('clipped terrain omits hidden cells instead of emitting invalid triangles', () => {
  const surface=meshTerrainSurface(3,3,new Float32Array([0,0,0,0,NaN,0,0,0,0]),S,0,0,()=>0,()=>false);
  assert.ok(surface.positions.every(Number.isFinite));
  const area=surface.indexes.length;
  assert.ok(area>6&&area<=24,'the four rectangles surround the missing voxel without a full grid');
});

test('terrain excavation banks close the union of cutouts with faces toward the excavation',()=>{
  const cuts=[{x0:2,x1:4,z0:2,z1:6},{x0:3,x1:6,z0:4,z1:6}];
  const surface=meshTerrainBanks(8,8,new Float32Array(64),1,0,0,()=>0,cuts,-4);
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(surface.positions,3));geometry.setIndex(new THREE.BufferAttribute(surface.indexes,1));geometry.computeVertexNormals();
  const normals=geometry.getAttribute('normal');let area=0;
  for(let i=0;i<surface.positions.length;i+=12){
    const a=new THREE.Vector3().fromArray(surface.positions,i),b=new THREE.Vector3().fromArray(surface.positions,i+3);
    const edge=a.distanceTo(b);area+=edge*4;
    const mid=a.clone().lerp(b,.5).setY(-2),normal=new THREE.Vector3().fromBufferAttribute(normals,i/3);
    const inward=mid.clone().addScaledVector(normal,.01),outward=mid.clone().addScaledVector(normal,-.01);
    const inside=(p:THREE.Vector3)=>cuts.some(c=>p.x>c.x0&&p.x<c.x1&&p.z>c.z0&&p.z<c.z1);
    assert.equal(inside(inward),true,'the earth wall faces the exposed void');assert.equal(inside(outward),false,'buried interior seams are omitted');
  }
  assert.equal(area,64,'only the 16-unit perimeter of the cutout union has visible banks');
  assert.ok(surface.indexes.length<=48,'coplanar bank strips are merged');
});

test('blocked traffic brakes in its lane, resumes when clear and never reverses direction',()=>{
  const grid=new GridSystem(8402,129),block=grid.blockAt(grid.center+2,grid.center+2);
  grid.activateBlock(block.bx,block.bz);grid.hash=()=>1;
  const bounds=grid.blockBounds(block.bx,block.bz),direction=grid.roadDirection('x',bounds.z0+1);
  const makeCar=(x:number)=>{const c=new THREE.Group();c.position.set(x,0,grid.roadLane('x',bounds.z0+1,direction));c.rotation.y=direction*Math.PI/2;c.userData.vehicle={length:5.28,width:2.42,maxSpeed:17,impact:1};return c;};
  const x=grid.world(Math.round((bounds.x0+bounds.x1)/2),bounds.z0+1)[0],car=makeCar(x),blocker=makeCar(x+direction*7);
  car.userData.autonomous=true;car.userData.trafficAxis='x';car.userData.trafficDirection=direction;
  const prefabs={vehicles:[car,blocker],isWorldActive:()=>true,setVehicleRendered(){}} as unknown as PrefabManager;
  const system=new VehicleSystem(prefabs,grid,new EventBus(),{nearby:()=>[]} as unknown as NPCController,{} as DestructionSystem),player={group:new THREE.Group()} as LocomotionIK;
  const heading=car.rotation.y;
  for(let i=0;i<240;i++)system.updateTraffic(1/30,player);
  const state=(system as unknown as {traffic:Map<THREE.Group,{direction:number;speed:number}>}).traffic.get(car)!;
  assert.equal(state.direction,direction);assert.ok(Math.abs(car.rotation.y-heading)<.01);assert.ok(state.speed<.1,'queued vehicles brake to a stop');
  const stopped=car.position.x;prefabs.vehicles.splice(1,1);
  for(let i=0;i<45;i++)system.updateTraffic(1/30,player);
  assert.ok((car.position.x-stopped)*direction>2,'the queue resumes forward once the obstacle leaves');
});

test('damaged outdoor stairs support their surviving column and full destruction leaves rendered earth',()=>{
  Object.assign(globalThis,{Worker:MeshWorker});
  const grid=new GridSystem(470943),scene=new THREE.Scene(),world=new PrefabManager(scene,grid),block=grid.blockAt(grid.center,grid.center);
  world.ensureAround(grid.terrain.canalColumn,block.bz,0,Infinity);drain(world);scene.updateMatrixWorld(true);
  const surface=[...grid.surfaces.surfaces.values()].find(s=>s.id.startsWith('riverwalk:')&&s.id.endsWith(':access'))!;
  const piece=world.interiorPieces.find(p=>p.alive&&p.mesh.userData.walkSurfaceIds?.includes(surface.id)&&p.dimensions.ny>5)!;
  const center=world.sceneVoxelPosition(piece,Math.floor(piece.dimensions.nx/2)+piece.dimensions.nx*(Math.floor(piece.dimensions.nz/2)+piece.dimensions.nz*(piece.dimensions.ny-1)));
  const before=grid.surfaces.height(surface,center.x,center.z);
  const {nx,ny,nz}=piece.dimensions;const ix=Math.floor(nx/2),iz=Math.floor(nz/2),sub=ix+nx*(iz+nz*(ny-1));
  world.eraseSceneVoxels(piece,[sub]);world.flushStaticDamage();
  assert.ok(Math.abs(grid.surfaces.height(surface,center.x,center.z)-(before-S))<1e-5,'support follows the next remaining voxel below the damaged tread');
  const feet=world.supportHeight(center.x,center.z,before);
  assert.ok(Math.abs(feet-(before-S))<1e-5,'physics receives the same exposed tread height');
  for(const p of world.interiorPieces.filter(p=>p.mesh.userData.walkSurfaceIds?.includes(surface.id)))world.eraseSceneVoxels(p,Array.from(p.mask.keys()));
  for(let i=0;i<50;i++)world.flushStaticDamage();
  assert.equal(grid.surfaces.at(center.x,center.z).some(s=>s.id===surface.id),false,'a fully removed tread no longer supports the body');
  const ray=new THREE.Raycaster(new THREE.Vector3(center.x,1,center.z),new THREE.Vector3(0,-1,0));
  const earth:THREE.Object3D[]=[];scene.traverse(o=>{if(o instanceof THREE.Mesh&&o.userData.terrainFoundation)earth.push(o);});
  const hit=ray.intersectObjects(earth,false)[0];assert.ok(hit,'the floor beneath the destroyed ramp stays rendered');
  assert.ok(Math.abs(hit.point.y-world.supportHeight(center.x,center.z,before))<1e-5,'rendered earth and the fallback collision height agree');
  assert.ok(earth.some(o=>o.name==='voxel-terrain-cutout-bank'),'excavations have closed voxel earth banks behind the destructible wall');
  world.dispose();
});
