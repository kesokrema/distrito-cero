import * as THREE from 'three';

/** Animated joint groups remain the simulation rig; matching visible cuboids
 * share one GPU draw per shape and per-instance colors instead of per limb. */
export class ActorRenderBatch {
  private sources = new Map<THREE.Group, THREE.Mesh[]>();
  private batches = new Map<THREE.BufferGeometry, THREE.InstancedMesh>();
  private readonly material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .86 });
  constructor(private scene: THREE.Scene) {}

  add(root: THREE.Group): void {
    if (this.sources.has(root)) return;
    const meshes: THREE.Mesh[] = [];
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !object.userData.actorVoxel) return;
      // Keep normal visible flags and raycasts for damage; layer 31 is logical.
      object.layers.set(31); meshes.push(object);
      if (!this.batches.has(object.geometry)) {
        const batch = new THREE.InstancedMesh(object.geometry, this.material, 2048);
        batch.name = 'animated-actor-cuboids'; batch.count = 0; batch.frustumCulled = false;
        batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(batch); this.batches.set(object.geometry, batch);
      }
    });
    this.sources.set(root, meshes);
  }

  update(): void {
    for (const batch of this.batches.values()) batch.count = 0;
    for (const [root, meshes] of this.sources) {
      if (!root.parent || !root.visible) continue;
      root.updateWorldMatrix(true, true);
      for (const mesh of meshes) {
        let visible = true;
        for (let parent: THREE.Object3D | null = mesh; parent && parent !== root; parent = parent.parent) {
          if (!parent.visible) { visible = false; break; }
        }
        if (!visible) continue;
        const batch = this.batches.get(mesh.geometry)!;
        if (batch.count >= 2048) continue;
        batch.setMatrixAt(batch.count, mesh.matrixWorld);
        const material = mesh.material as THREE.MeshStandardMaterial;
        batch.setColorAt(batch.count++, material.color);
      }
    }
    for (const batch of this.batches.values()) {
      batch.visible = batch.count > 0; batch.instanceMatrix.needsUpdate = true;
      if (batch.instanceColor) batch.instanceColor.needsUpdate = true;
    }
  }
  dispose(): void { for (const batch of this.batches.values()) { this.scene.remove(batch); batch.dispose(); } this.material.dispose(); }
}
