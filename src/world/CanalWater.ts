import * as THREE from 'three';
import type { UrbanTerrain } from './UrbanTerrain';

export const CANAL_SURFACE_Y = -3.96;
export const CANAL_BED_Y = -4.4;

/** One current field drives movement, floating fragments and visible ripples. */
export class CanalWater {
  constructor(private terrain: UrbanTerrain) {}

  at(x: number, z: number): boolean { return this.terrain.channelAt(x, z); }

  currentAt(x: number, y: number, z: number, result: THREE.Vector3): boolean {
    if (!this.at(x, z) || y > CANAL_SURFACE_Y + 0.42 || y < CANAL_BED_Y - 0.4) {
      result.set(0, 0, 0);
      return false;
    }
    result.set(Math.sin(z * 0.23 + x * 0.11) * 0.12, 0, 1.75 + Math.sin(z * 0.16) * 0.18);
    return true;
  }
}

type FlowBounds = { x0: number; x1: number; z0: number; z1: number; phase: number };
const flowDummy = new THREE.Object3D();
const flowGeometry = new THREE.BoxGeometry(0.22, 0.045, 0.66);
const flowMaterial = new THREE.MeshBasicMaterial({ color: '#a2dce0', transparent: true, opacity: 0.4, depthWrite: false });

/** A small instanced field of voxel highlights; the water slab stays solid. */
export function createCanalFlow(bounds: FlowBounds): THREE.InstancedMesh {
  const count = Math.max(18, Math.round((bounds.z1 - bounds.z0) * 0.9));
  const mesh = new THREE.InstancedMesh(flowGeometry, flowMaterial, count);
  mesh.name = 'canal-flow';
  mesh.userData.flowBounds = bounds;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  animateCanalFlow(mesh, 0);
  return mesh;
}

export function animateCanalFlow(mesh: THREE.InstancedMesh, time: number): void {
  const bounds = mesh.userData.flowBounds as FlowBounds;
  const length = bounds.z1 - bounds.z0;
  for (let i = 0; i < mesh.count; i++) {
    const lane = (i * 7) % 11;
    const x = bounds.x0 + 0.44 + lane * Math.max(0.05, (bounds.x1 - bounds.x0 - 0.88) / 10);
    const phase = ((i * 0.61803398875 + bounds.phase) % 1) * length;
    const z = bounds.z0 + ((phase + time * 1.75) % length);
    flowDummy.position.set(x, CANAL_SURFACE_Y + 0.045, z);
    flowDummy.scale.set(1, 1, i % 4 === 0 ? 1.6 : 1);
    flowDummy.updateMatrix();
    mesh.setMatrixAt(i, flowDummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}
