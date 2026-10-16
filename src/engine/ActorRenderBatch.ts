import * as THREE from 'three';

/** Animated joint groups remain the simulation rig; matching visible cuboids
 * share one GPU draw per shape and per-instance colors instead of per limb. */
export class ActorRenderBatch {
  private sources = new Map<THREE.Group, THREE.Mesh[]>();
  private batches = new Map<THREE.BufferGeometry, THREE.InstancedMesh>();
  private readonly material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .86 });
  private readonly frustum = new THREE.Frustum();
  private readonly projection = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 2.8);
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

  remove(root: THREE.Group): void { this.sources.delete(root); }
  get sourceCount(): number { return this.sources.size; }

  update(camera?: THREE.Camera): void {
    if(camera){camera.updateMatrixWorld();this.frustum.setFromProjectionMatrix(this.projection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));}
    for (const batch of this.batches.values()) batch.count = 0;
    for (const [root, meshes] of this.sources) {
      if (!root.parent || !root.visible) continue;
      if(camera){this.sphere.center.copy(root.position);this.sphere.center.y+=1;if(!this.frustum.intersectsSphere(this.sphere))continue;}
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
      batch.instanceMatrix.clearUpdateRanges();batch.instanceMatrix.addUpdateRange(0,batch.count*16);
      if (batch.instanceColor) batch.instanceColor.needsUpdate = true;
      if (batch.instanceColor) {batch.instanceColor.clearUpdateRanges();batch.instanceColor.addUpdateRange(0,batch.count*3);}
    }
  }
  dispose(): void { for (const batch of this.batches.values()) { this.scene.remove(batch); batch.dispose(); } this.sources.clear();this.batches.clear();this.material.dispose(); }
}
