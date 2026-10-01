import * as THREE from 'three';

type Support = { x: number; y: number; z: number; floor: number; sampled: number; seen: number };

/** One draw call for all people/car shadows; no animated meshes in the sun shadow pass. */
export class ContactShadowSystem {
  readonly mesh: THREE.InstancedMesh;
  private readonly support = new Map<THREE.Object3D, Support>();
  private readonly dummy = new THREE.Object3D();
  private readonly opacity = new THREE.Color();
  private readonly focus = new THREE.Vector3();
  private now = 0;
  private nextCleanup = 0;

  constructor(private scene: THREE.Scene, private floorAt: (x: number, z: number, y: number) => number,
      private capacity = 1024) {
    const material = new THREE.ShaderMaterial({
      transparent: true, depthTest: true, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      vertexShader: `
        varying vec2 vShadowUv;
        varying float vOpacity;
        void main() {
          vShadowUv = uv;
          vOpacity = instanceColor.r;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vShadowUv;
        varying float vOpacity;
        void main() {
          float radius = length((vShadowUv - 0.5) * 2.0);
          float alpha = (1.0 - smoothstep(0.32, 1.0, radius)) * vOpacity;
          if (alpha < 0.008) discard;
          gl_FragColor = vec4(0.025, 0.04, 0.045, alpha);
        }`
    });
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = 'actor-contact-shadows';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Allocate instanceColor before the first shader compilation.
    this.mesh.setColorAt(0, this.opacity.setRGB(0.3, 0.3, 0.3));
    scene.add(this.mesh);
  }

  beginFrame(focus: THREE.Vector3, now = performance.now() / 1000): void {
    this.focus.copy(focus);
    this.now = now;
    this.mesh.count = 0;
    if (now >= this.nextCleanup) {
      for (const [source, sample] of this.support) if (now - sample.seen > 3) this.support.delete(source);
      this.nextCleanup = now + 1;
    }
  }

  add(source: THREE.Object3D, width: number, length: number, yaw = source.rotation.y): void {
    if (!source.parent || !source.visible || this.mesh.count >= this.capacity) return;
    const p = source.position;
    if ((p.x - this.focus.x) ** 2 + (p.z - this.focus.z) ** 2 > 110 ** 2) return;
    for (let parent: THREE.Object3D | null = source.parent; parent; parent = parent.parent) if (!parent.visible) return;
    let sample = this.support.get(source);
    if (!sample) {
      sample = { x: p.x, y: p.y, z: p.z, floor: this.floorAt(p.x, p.z, p.y + 0.2), sampled: this.now, seen: this.now };
      this.support.set(source, sample);
    } else if (Math.abs(p.y - sample.y) > 0.6 || this.now - sample.sampled >= 0.2 &&
        ((p.x - sample.x) ** 2 + (p.z - sample.z) ** 2 > 0.2 ** 2 || Math.abs(p.y - sample.y) > 0.08)) {
      sample.x = p.x; sample.y = p.y; sample.z = p.z;
      sample.floor = this.floorAt(p.x, p.z, p.y + 0.2);
      sample.sampled = this.now;
    }
    sample.seen = this.now;
    const height = Math.max(0, p.y - sample.floor);
    if (height > 6 || !Number.isFinite(sample.floor)) return;
    this.dummy.position.set(p.x, sample.floor + 0.035, p.z);
    this.dummy.rotation.set(0, yaw, 0);
    const spread = 1 + height * 0.08;
    this.dummy.scale.set(width * spread, 1, length * spread);
    this.dummy.updateMatrix();
    const index = this.mesh.count++;
    this.mesh.setMatrixAt(index, this.dummy.matrix);
    const alpha = 0.29 / (1 + height * 0.8);
    this.mesh.setColorAt(index, this.opacity.setRGB(alpha, alpha, alpha));
  }

  endFrame(visible = true): void {
    this.mesh.visible = visible && this.mesh.count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }

  invalidate(): void { this.support.clear(); }
  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
    this.support.clear();
  }
}
