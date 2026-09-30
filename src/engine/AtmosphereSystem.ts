import * as THREE from 'three';
import { voxelSurfaceGeometry } from '../world/VoxelSystem';
import type { CameraMode } from './RenderEngine';

/** Distant scenery follows the camera, so the sky has a fixed render cost even
 * when the generated city grows. Every cloud is built from standard voxels. */
export class AtmosphereSystem {
  private readonly root = new THREE.Group();
  private readonly clouds = new THREE.Group();
  private readonly cloudMeshes: THREE.InstancedMesh[] = [];
  private readonly cloudMaterial = new THREE.MeshBasicMaterial({ color: '#fff9eb', vertexColors: true, fog: true });
  private readonly birdMaterial = new THREE.MeshBasicMaterial({ color: '#394d58', vertexColors: true, fog: true });
  private readonly birdGeometry = [voxelSurfaceGeometry(1, 1, 2), voxelSurfaceGeometry(3, 1, 1)];
  private readonly birds: Array<{ group: THREE.Group; wings: [THREE.Group, THREE.Group]; phase: number; radius: number; height: number }> = [];
  private time = 0;

  constructor(scene: THREE.Scene) {
    this.root.name = 'distant-atmosphere';
    this.root.add(this.clouds);
    const dummy = new THREE.Object3D();
    for (let variant = 0; variant < 4; variant++) {
      const geometry = this.cloudGeometry(variant);
      const mesh = new THREE.InstancedMesh(geometry, this.cloudMaterial, 5);
      for (let i = 0; i < 5; i++) {
        const index = variant * 5 + i;
        const angle = index * Math.PI * (3 - Math.sqrt(5));
        const radius = 40 + (index % 5) * 13;
        dummy.position.set(Math.cos(angle) * radius, 38 + (index % 4) * 6, Math.sin(angle) * radius);
        dummy.rotation.set(0, angle, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, new THREE.Color(['#fffaf1', '#f3f4ef', '#f9e9da', '#e5eef0'][index % 4]));
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.clouds.add(mesh);
      this.cloudMeshes.push(mesh);
    }
    for (let i = 0; i < 7; i++) {
      const bird = new THREE.Group();
      const body = new THREE.Mesh(this.birdGeometry[0], this.birdMaterial);
      bird.add(body);
      const wings: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
      for (const side of [-1, 1] as const) {
        const pivot = wings[side < 0 ? 0 : 1];
        pivot.position.x = side * 0.11;
        const wing = new THREE.Mesh(this.birdGeometry[1], this.birdMaterial);
        wing.position.x = side * 0.33;
        pivot.add(wing);
        bird.add(pivot);
      }
      this.root.add(bird);
      this.birds.push({ group: bird, wings, phase: i * 1.71, radius: 23 + (i % 4) * 7, height: 10 + (i % 3) * 3 });
    }
    scene.add(this.root);
    this.root.visible = false;
  }

  setTimeOfDay(daylight: number, sunset: number): void {
    this.cloudMaterial.color.set('#758094').lerp(new THREE.Color('#fff9eb'), daylight)
      .lerp(new THREE.Color('#f5aa88'), Math.min(1, sunset) * 0.3);
    this.birdMaterial.color.set('#182639').lerp(new THREE.Color('#394d58'), daylight);
  }

  private cloudGeometry(variant: number): THREE.BufferGeometry {
    const nx = 50, ny = 15, nz = 28;
    const alive = new Uint8Array(nx * ny * nz);
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const lobes = [
        [12, 13, 15, 10, 4.8], [26, 13, 17, 11, 6.8], [40, 16, 12, 9, 4.5]
      ];
      const inside = lobes.some(([cx, cz, rx, rz, ry], i) => {
        const dx = (x - cx - (variant - 1.5) * (i - 1)) / rx;
        const dz = (z - cz) / rz;
        const dy = (y - (6.1 + (i === 1 ? 0.7 : 0))) / ry;
        return dx * dx + dz * dz + dy * dy < 1;
      });
      if (inside) alive[x + nx * (z + nz * y)] = 1;
    }
    return voxelSurfaceGeometry(nx, ny, nz, alive);
  }

  update(dt: number, position: THREE.Vector3, mode: CameraMode): void {
    this.root.visible = mode !== 'isometric';
    if (!this.root.visible) return;
    this.time += dt;
    this.root.position.set(position.x, 0, position.z);
    this.clouds.rotation.y = this.time * 0.0017;
    for (const bird of this.birds) {
      const angle = this.time * 0.17 + bird.phase;
      bird.group.position.set(Math.cos(angle) * bird.radius, bird.height + Math.sin(this.time * 1.6 + bird.phase) * 0.55,
        Math.sin(angle) * bird.radius);
      bird.group.rotation.y = -angle;
      const flap = Math.sin(this.time * 6.4 + bird.phase) * 0.48;
      bird.wings[0].rotation.z = -flap;
      bird.wings[1].rotation.z = flap;
    }
  }

  dispose(): void {
    this.cloudMeshes.forEach((mesh) => mesh.geometry.dispose());
    this.birdGeometry.forEach((geometry) => geometry.dispose());
    this.cloudMaterial.dispose();
    this.birdMaterial.dispose();
  }
}
